//! AgentOS archive v1 (spec §23.3, §24.1 step 2): the plain stream that `age` encrypts for off-machine export.
//!
//! Layout: magic `AGENTOS-AR1\n`, then frames `u32 BE length + canonical JSON header` each followed by `size` bytes
//! of content for files. Only two entry kinds exist: `dir` and `file`. Links, devices, FIFOs and sockets cannot be
//! written (the writer refuses them) and cannot be expressed (the reader has no kind for them). The trailer frame
//! `{"end":true,"count":n,"headersDigest":…}` closes the stream; a stream without it is incomplete and rejected.
//!
//! Unpacking never trusts a path: every component must be a plain name (no `/` prefix, `.`, `..`, empty, NUL or
//! backslash), and every create goes through `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)` under the staging root
//! with `O_EXCL|O_NOFOLLOW`, so nothing can land outside the staging directory even if the tree already holds a link.
//! Ownership is never taken from the archive: files are created by the restoring process (mode 0600/0700) and the
//! caller chowns the finished tree to the target execution UID (UID spoofing in an archive has no field to use).
use agentos_protocol::fsutil::openat2;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::ffi::CString;
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::Path;

pub const MAGIC: &[u8] = b"AGENTOS-AR1\n";
pub const MAX_HEADER: usize = 64 * 1024;
pub const MAX_ENTRIES: u64 = 1_000_000;

#[derive(Debug)]
pub struct ArErr(pub &'static str, pub String);
impl std::fmt::Display for ArErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.0, self.1)
    }
}
pub type AR<T> = Result<T, ArErr>;
fn e<T>(code: &'static str, m: impl Into<String>) -> AR<T> {
    Err(ArErr(code, m.into()))
}

pub fn sha256_hex(b: &[u8]) -> String {
    hex::encode(Sha256::digest(b))
}

/// A relative archive path made only of plain components.
pub fn valid_rel(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 4096
        && !p.starts_with('/')
        && !p.contains('\0')
        && !p.contains('\\')
        && p.split('/').all(|c| !c.is_empty() && c != "." && c != ".." && c.len() <= 255)
}

fn canon(v: &Value) -> Vec<u8> {
    agentos_protocol::canonical::canonical_json(v).unwrap_or_default().into_bytes()
}

fn frame(w: &mut dyn Write, h: &Value) -> AR<Vec<u8>> {
    let b = canon(h);
    w.write_all(&(b.len() as u32).to_be_bytes()).map_err(|x| ArErr("WRITE_FAILED", x.to_string()))?;
    w.write_all(&b).map_err(|x| ArErr("WRITE_FAILED", x.to_string()))?;
    Ok(b)
}

/// Write the tree under `root` (sorted, deterministic). Refuses anything that is not a regular file or directory.
pub fn write_tree(root: &Path, w: &mut dyn Write) -> AR<Value> {
    w.write_all(MAGIC).map_err(|x| ArErr("WRITE_FAILED", x.to_string()))?;
    let mut hd = Sha256::new();
    let mut count = 0u64;
    let mut stack = vec![String::new()];
    let mut files = serde_json::Map::new();
    while let Some(rel) = stack.pop() {
        let dir = if rel.is_empty() { root.to_path_buf() } else { root.join(&rel) };
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .map_err(|x| ArErr("READ_FAILED", format!("{}: {x}", dir.display())))?
            .filter_map(|d| d.ok().map(|d| d.file_name().to_string_lossy().into_owned()))
            .collect();
        names.sort();
        let mut subdirs = vec![];
        for n in names {
            let r = if rel.is_empty() { n.clone() } else { format!("{rel}/{n}") };
            if !valid_rel(&r) {
                return e("ARCHIVE_PATH_INVALID", r);
            }
            let full = root.join(&r);
            let md = std::fs::symlink_metadata(&full).map_err(|x| ArErr("READ_FAILED", x.to_string()))?;
            let ft = md.file_type();
            if ft.is_symlink() || ft.is_block_device() || ft.is_char_device() || ft.is_fifo() || ft.is_socket() {
                return e("ARCHIVE_ENTRY_UNSUPPORTED", format!("{r} is not a regular file or directory"));
            }
            if ft.is_dir() {
                let b = frame(w, &json!({ "path": r, "kind": "dir" }))?;
                hd.update(&b);
                count += 1;
                subdirs.push(r);
            } else {
                let mut f = File::open(&full).map_err(|x| ArErr("READ_FAILED", x.to_string()))?;
                let mut buf = Vec::with_capacity(md.size() as usize);
                f.read_to_end(&mut buf).map_err(|x| ArErr("READ_FAILED", x.to_string()))?;
                let h = sha256_hex(&buf);
                let b = frame(w, &json!({ "path": r, "kind": "file", "size": buf.len(), "sha256": h, "exec": md.mode() & 0o111 != 0 }))?;
                hd.update(&b);
                w.write_all(&buf).map_err(|x| ArErr("WRITE_FAILED", x.to_string()))?;
                files.insert(r, json!(h));
                count += 1;
            }
        }
        subdirs.reverse();
        stack.extend(subdirs);
    }
    let digest = hex::encode(hd.finalize());
    frame(w, &json!({ "end": true, "count": count, "headersDigest": digest }))?;
    w.flush().map_err(|x| ArErr("WRITE_FAILED", x.to_string()))?;
    Ok(json!({ "count": count, "headersDigest": digest, "files": files }))
}

fn read_exact(r: &mut dyn Read, n: usize) -> AR<Vec<u8>> {
    let mut b = vec![0u8; n];
    r.read_exact(&mut b).map_err(|_| ArErr("ARCHIVE_TRUNCATED", "stream ended early".into()))?;
    Ok(b)
}

fn mkdirat(dir: &OwnedFd, name: &str) -> AR<()> {
    let c = CString::new(name).map_err(|_| ArErr("ARCHIVE_PATH_INVALID", name.into()))?;
    if unsafe { libc::mkdirat(dir.as_raw_fd(), c.as_ptr(), 0o700) } != 0 {
        return e("ARCHIVE_PATH_INVALID", format!("mkdir {name}: {}", std::io::Error::last_os_error()));
    }
    Ok(())
}

/// Open the parent directory of `rel` strictly beneath `root` (no symlinks anywhere on the way).
fn parent_fd(root: &OwnedFd, rel: &str) -> AR<(OwnedFd, String)> {
    let (parent, leaf) = match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    };
    let fd = openat2(root.as_raw_fd(), parent, libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW, 0).map_err(|x| ArErr("ARCHIVE_PATH_INVALID", format!("{rel}: {}", x.message)))?;
    Ok((fd, leaf.to_string()))
}

/// Unpack into an existing EMPTY staging directory. Returns the summary (count, digest, file hashes).
/// On any error the caller removes the staging directory; nothing outside it was touched.
pub fn unpack(r: &mut dyn Read, staging: &Path, max_bytes: u64) -> AR<Value> {
    let m = read_exact(r, MAGIC.len())?;
    if m != MAGIC {
        return e("ARCHIVE_FORMAT", "not an AgentOS archive v1");
    }
    if std::fs::read_dir(staging).map_err(|x| ArErr("STAGING", x.to_string()))?.next().is_some() {
        return e("STAGING", "staging directory is not empty");
    }
    let root = agentos_protocol::fsutil::open_root(&staging.to_string_lossy()).map_err(|x| ArErr("STAGING", x.message))?.0;
    let mut hd = Sha256::new();
    let mut count = 0u64;
    let mut total = 0u64;
    let mut files = serde_json::Map::new();
    loop {
        let len = u32::from_be_bytes(read_exact(r, 4)?.try_into().unwrap()) as usize;
        if len == 0 || len > MAX_HEADER {
            return e("ARCHIVE_FORMAT", "bad header length");
        }
        let hb = read_exact(r, len)?;
        let h: Value = std::str::from_utf8(&hb).ok().and_then(|t| agentos_protocol::v1_json::parse_strict_json(t).ok()).ok_or_else(|| ArErr("ARCHIVE_FORMAT", "header is not strict JSON".into()))?;
        if canon(&h) != hb {
            return e("ARCHIVE_FORMAT", "header is not canonical");
        }
        if h.get("end") == Some(&json!(true)) {
            let keys: Vec<&String> = h.as_object().unwrap().keys().collect();
            if keys.len() != 3 || h["count"].as_u64() != Some(count) || h["headersDigest"].as_str() != Some(&hex::encode(hd.finalize())) {
                return e("ARCHIVE_TAMPERED", "trailer does not match the entries");
            }
            let mut extra = [0u8; 1];
            if r.read(&mut extra).map_err(|x| ArErr("READ_FAILED", x.to_string()))? != 0 {
                return e("ARCHIVE_TAMPERED", "data after the trailer");
            }
            return Ok(json!({ "count": count, "files": files, "bytes": total }));
        }
        hd.update(&hb);
        count += 1;
        if count > MAX_ENTRIES {
            return e("ARCHIVE_LIMIT", "too many entries");
        }
        let o = h.as_object().ok_or_else(|| ArErr("ARCHIVE_FORMAT", "header".into()))?;
        let path = o.get("path").and_then(|x| x.as_str()).unwrap_or_default().to_string();
        if !valid_rel(&path) {
            return e("ARCHIVE_PATH_INVALID", path);
        }
        match o.get("kind").and_then(|x| x.as_str()) {
            Some("dir") if o.len() == 2 => {
                let (pfd, leaf) = parent_fd(&root, &path)?;
                mkdirat(&pfd, &leaf)?;
            }
            Some("file") if o.len() == 5 => {
                let size = o.get("size").and_then(|x| x.as_u64()).ok_or_else(|| ArErr("ARCHIVE_FORMAT", "size".into()))?;
                let want = o.get("sha256").and_then(|x| x.as_str()).unwrap_or_default().to_string();
                let exec = o.get("exec").and_then(|x| x.as_bool()).ok_or_else(|| ArErr("ARCHIVE_FORMAT", "exec".into()))?;
                total += size;
                if total > max_bytes {
                    return e("ARCHIVE_LIMIT", "archive is larger than the space allowed for staging");
                }
                let body = read_exact(r, size as usize)?;
                if sha256_hex(&body) != want {
                    return e("ARCHIVE_TAMPERED", format!("{path} does not match its hash"));
                }
                let (pfd, leaf) = parent_fd(&root, &path)?;
                let fd = openat2(pfd.as_raw_fd(), &leaf, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW, if exec { 0o700 } else { 0o600 })
                    .map_err(|x| ArErr("ARCHIVE_PATH_INVALID", format!("{path}: {}", x.message)))?;
                let mut f = unsafe { File::from_raw_fd(std::os::fd::IntoRawFd::into_raw_fd(fd)) };
                f.write_all(&body).map_err(|x| ArErr("WRITE_FAILED", x.to_string()))?;
                f.sync_all().map_err(|x| ArErr("WRITE_FAILED", x.to_string()))?;
                files.insert(path, json!(want));
            }
            _ => return e("ARCHIVE_ENTRY_UNSUPPORTED", format!("{path}: only dir and file entries exist")),
        }
    }
}

/// Test helper and fault tool: write raw frames (used to build hostile archives in tests).
pub fn raw_frame(w: &mut Vec<u8>, h: &Value, body: &[u8]) {
    let b = canon(h);
    w.extend_from_slice(&(b.len() as u32).to_be_bytes());
    w.extend_from_slice(&b);
    w.extend_from_slice(body);
}
