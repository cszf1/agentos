//! File worker (spec §13.3): the only writer of managed roots. Runs as the dedicated agentos-file UID; the root and
//! its parents cannot be written or renamed by the host user, so the single-writer precondition has a real
//! permission basis.
use serde_json::{json, Value};
use std::os::unix::fs::MetadataExt;
use std::os::unix::io::AsRawFd;

use crate::{die, has_fault, Res, WErr};
use agentos_protocol::fsutil::{self, FsError};
use agentos_protocol::worker::WorkerRequest;

fn root_of(req: &WorkerRequest) -> Result<(std::os::unix::io::OwnedFd, libc::stat, String), WErr> {
    let root = req.target["root"].as_str().ok_or_else(|| WErr::none("INVALID_SYSTEM_PLAN", "target.root missing"))?.to_string();
    let (fd, st) = fsutil::open_root(&root)?;
    Ok((fd, st, root))
}

fn s<'a>(v: &'a Value, k: &str) -> Result<&'a str, WErr> {
    v[k].as_str().ok_or_else(|| WErr::none("INVALID_SYSTEM_PLAN", format!("{k} missing")))
}

pub fn handle(req: &WorkerRequest) -> Res {
    let p = &req.params;
    match req.op.as_str() {
        "observe" => {
            let (_fd, st, root) = root_of(req)?;
            let me = unsafe { libc::geteuid() };
            // F04 evidence: owner and mode of the root and of each parent directory.
            let mut chain = Vec::new();
            let mut cur = std::path::Path::new(&root).parent();
            let mut parents_safe = true;
            while let Some(c) = cur {
                if c.as_os_str().is_empty() {
                    break;
                }
                if let Ok(md) = std::fs::symlink_metadata(c) {
                    let safe = md.uid() == 0 && md.mode() & 0o022 == 0;
                    parents_safe &= safe;
                    chain.push(json!({"path": c.display().to_string(), "uid": md.uid(), "mode": format!("{:o}", md.mode() & 0o7777)}));
                }
                cur = c.parent();
            }
            let exclusive = st.st_uid == me && st.st_mode & 0o022 == 0 && parents_safe;
            Ok(json!({
                "identity": {"dev": st.st_dev, "ino": st.st_ino, "uid": st.st_uid},
                "version": format!("{}:{}", st.st_dev, st.st_ino),
                "details": {"ownerUid": st.st_uid, "mode": format!("{:o}", st.st_mode & 0o7777), "writerUid": me, "exclusiveWriter": exclusive, "parents": chain}
            }))
        }
        "version" => {
            let (fd, _, _) = root_of(req)?;
            let path = s(p, "path")?;
            agentos_protocol::params::check_rel_path(path, false).map_err(|m| WErr::none("PATH_SCOPE_VIOLATION", m))?;
            match fsutil::target_version(fd.as_raw_fd(), path)? {
                Some((v, id, nlink)) => Ok(json!({"version": v, "identity": {"dev": id.dev, "ino": id.ino}, "nlink": nlink})),
                None => Ok(json!({"version": null})),
            }
        }
        "usage" => {
            const USAGE_MAX_ENTRIES: u64 = 20_000;
            let (_, _, root) = root_of(req)?;
            let mut total = 0u64;
            let mut n: u64 = 0;
            let mut stack = vec![std::path::PathBuf::from(root)];
            while let Some(d) = stack.pop() {
                if let Ok(rd) = std::fs::read_dir(&d) {
                    for e in rd.flatten() {
                        n += 1;
                        // Fail closed: a partial total would let the broker's quota check pass a full root.
                        if n > USAGE_MAX_ENTRIES {
                            return Err(WErr::none("APP_RESOURCE_LIMIT", format!("managed root has more than {USAGE_MAX_ENTRIES} entries; usage cannot be measured")));
                        }
                        if let Ok(md) = e.metadata() {
                            if md.is_dir() {
                                stack.push(e.path());
                            } else {
                                total += md.len();
                            }
                        }
                    }
                }
            }
            Ok(json!({"bytes": total, "entries": n}))
        }
        "write_temp" => {
            let (fd, _, _) = root_of(req)?;
            let parent = s(p, "parent")?;
            let temp = s(p, "temp")?;
            if !temp.starts_with(".aos-tmp-") || temp.contains('/') {
                return Err(WErr::none("PATH_SCOPE_VIOLATION", "temp names are platform generated"));
            }
            if !parent.is_empty() {
                agentos_protocol::params::check_rel_path(parent, false).map_err(|m| WErr::none("PATH_SCOPE_VIOLATION", m))?;
            }
            let content = s(p, "content")?;
            fsutil::write_temp(fd.as_raw_fd(), parent, temp, content.as_bytes())?;
            Ok(json!({"temp": temp, "bytes": content.len()}))
        }
        "publish" => {
            let (fd, _, _) = root_of(req)?;
            let parent = s(p, "parent")?;
            let temp = s(p, "temp")?;
            let leaf = s(p, "leaf")?;
            let rel = if parent.is_empty() { leaf.to_string() } else { format!("{parent}/{leaf}") };
            agentos_protocol::params::check_rel_path(&rel, false).map_err(|m| WErr::none("PATH_SCOPE_VIOLATION", m))?;
            if !temp.starts_with(".aos-tmp-") {
                return Err(WErr::none("PATH_SCOPE_VIOLATION", "temp names are platform generated"));
            }
            let no_replace = p["noReplace"].as_bool().unwrap_or(false);
            // Re-check the precondition immediately before the rename (single writer + broker resource lock).
            let cur = fsutil::target_version(fd.as_raw_fd(), &rel)?.map(|x| x.0);
            let expected = p["expectedVersion"].as_str().map(String::from);
            if !no_replace && cur != expected {
                return Err(WErr::none("FILE_VERSION_STALE", "target changed before publication"));
            }
            if has_fault(req, "file.die_before_rename") {
                die("file.die_before_rename");
            }
            // After the rename the target has changed: a later failure (directory fsync) is an unknown effect, so the
            // broker reconciles instead of recording "target unchanged".
            fsutil::publish_phased(fd.as_raw_fd(), parent, temp, leaf, no_replace)
                .map_err(|(e, renamed): (FsError, bool)| if renamed { WErr::unknown(e.code, e.message) } else { WErr::none(e.code, e.message) })?;
            if has_fault(req, "file.die_after_rename") {
                die("file.die_after_rename");
            }
            Ok(json!({"published": rel}))
        }
        "cleanup" => {
            let (fd, _, _) = root_of(req)?;
            let parent = s(p, "parent")?;
            let temp = s(p, "temp")?;
            if !temp.starts_with(".aos-tmp-") {
                return Err(WErr::none("PATH_SCOPE_VIOLATION", "only registered temp names are removed"));
            }
            Ok(json!({"removed": fsutil::unlink_temp(fd.as_raw_fd(), parent, temp).unwrap_or(false)}))
        }
        "read" => {
            let (fd, _, _) = root_of(req)?;
            let cap = s(p, "capabilityId")?;
            read_cap(fd.as_raw_fd(), cap, &p["params"])
        }
        _ => Err(WErr::none("INVALID_SYSTEM_PLAN", "unknown file op")),
    }
}

pub fn read_cap(root: i32, cap: &str, p: &Value) -> Res {
    fsutil::read_cap(root, cap, p).map_err(|e| WErr::none(e.code, e.message))
}
