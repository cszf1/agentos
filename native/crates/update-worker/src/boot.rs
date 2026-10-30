//! BootEntryWriter and loader control (spec §21.2 steps 4–5, 7; §21.3).
//!
//! Only entries this controller registered (file name prefix `agentos-`, recorded in `EFI/agentos/registry.json`)
//! are ever written or removed. Assets of a candidate are written to `EFI/agentos/.tmp-<rid>/`, every file and the
//! directory fsynced and hash-checked, then the directory is renamed to `EFI/agentos/<rid>` (publish point 1). The
//! BLS entry is written to `loader/entries/.agentos-<rid>.conf.tmp`, fsynced, renamed to `agentos-<rid>.conf`
//! (publish point 2). A crash at any point leaves either nothing, an unreferenced complete asset directory, or a
//! complete entry — never a half-written entry, and never a removed known-good or recovery entry.
//!
//! The persistent default only changes in `commit` after health passed; a trial uses the one-shot slot.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub struct UErr(pub &'static str, pub String);
impl std::fmt::Display for UErr {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.0, self.1)
    }
}
pub type UR<T> = Result<T, UErr>;
pub fn uerr<T>(c: &'static str, m: impl Into<String>) -> UR<T> {
    Err(UErr(c, m.into()))
}
fn io(c: &'static str) -> impl Fn(std::io::Error) -> UErr {
    move |e| UErr(c, e.to_string())
}

pub fn sha_file(p: &Path) -> UR<String> {
    let mut f = File::open(p).map_err(io("READ_FAILED"))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut buf).map_err(io("READ_FAILED"))?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(format!("sha256:{}", hex::encode(h.finalize())))
}

pub fn fsync_dir(p: &Path) -> UR<()> {
    File::open(p).and_then(|f| f.sync_all()).map_err(io("WRITE_FAILED"))
}

fn fault(p: &str) {
    if std::env::var("AGENTOS_FAULT_POINT").as_deref() == Ok(p) {
        unsafe { libc::kill(libc::getpid(), libc::SIGKILL) };
    }
}

pub fn valid_rid(r: &str) -> bool {
    r.len() == 36 && r.bytes().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase() || c == b'-')
}

pub struct Candidate<'a> {
    pub release_id: &'a str,
    pub title: &'a str,
    pub kernel: &'a Path,
    pub initrd: &'a Path,
    pub kernel_hash: Option<&'a str>,
    pub initrd_hash: &'a str,
    /// `init=` target: the verified deployment closure's toplevel init.
    pub init: &'a str,
    pub cmdline: &'a str,
}

pub struct Esp {
    pub root: PathBuf,
}

impl Esp {
    fn assets(&self) -> PathBuf {
        self.root.join("EFI/agentos")
    }
    fn entries(&self) -> PathBuf {
        self.root.join("loader/entries")
    }
    pub fn entry_id(rid: &str) -> String {
        format!("agentos-{rid}.conf")
    }
    pub fn registry(&self) -> Value {
        std::fs::read_to_string(self.assets().join("registry.json")).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({ "entries": [] }))
    }
    fn write_atomic(&self, dir: &Path, name: &str, bytes: &[u8]) -> UR<()> {
        let tmp = dir.join(format!(".{name}.tmp"));
        let mut f = File::create(&tmp).map_err(io("WRITE_FAILED"))?;
        f.write_all(bytes).map_err(io("WRITE_FAILED"))?;
        f.sync_all().map_err(io("WRITE_FAILED"))?;
        drop(f);
        std::fs::rename(&tmp, dir.join(name)).map_err(io("WRITE_FAILED"))?;
        fsync_dir(dir)
    }
    fn register(&self, rid: &str) -> UR<()> {
        let mut r = self.registry();
        let id = Esp::entry_id(rid);
        let a = r["entries"].as_array_mut().unwrap();
        if !a.iter().any(|x| x == &json!(id)) {
            a.push(json!(id));
        }
        self.write_atomic(&self.assets(), "registry.json", serde_json::to_string(&r).unwrap().as_bytes())
    }

    /// Write (or re-verify) the complete candidate. Re-entrant: a complete published candidate is verified, not rewritten.
    pub fn write_candidate(&self, c: &Candidate) -> UR<Value> {
        if !valid_rid(c.release_id) {
            return uerr("INVALID_REQUEST", "releaseId");
        }
        if c.cmdline.contains('\n') || c.init.contains(char::is_whitespace) || !c.init.starts_with("/nix/store/") {
            return uerr("INVALID_REQUEST", "cmdline/init");
        }
        std::fs::create_dir_all(self.assets()).map_err(io("WRITE_FAILED"))?;
        std::fs::create_dir_all(self.entries()).map_err(io("WRITE_FAILED"))?;
        let final_dir = self.assets().join(c.release_id);
        // Source assets must match the verified manifest before anything is written.
        if sha_file(c.initrd)? != c.initrd_hash {
            return uerr("UPDATE_CONTENT_MISMATCH", "initrd does not match the manifest");
        }
        if let Some(kh) = c.kernel_hash {
            if sha_file(c.kernel)? != kh {
                return uerr("UPDATE_CONTENT_MISMATCH", "kernel does not match the manifest");
            }
        }
        let kh = sha_file(c.kernel)?;
        if final_dir.exists() {
            if sha_file(&final_dir.join("initrd"))? != c.initrd_hash || sha_file(&final_dir.join("linux"))? != kh {
                return uerr("NEEDS_ATTENTION", "a published candidate directory does not match; not overwriting");
            }
        } else {
            let tmp = self.assets().join(format!(".tmp-{}", c.release_id));
            // Leftovers of interrupted writes are removed first; then the ESP must hold both assets plus a margin, or
            // nothing is written (a full ESP must not end in a half-copied candidate, spec §21.1, V1-U06/U07).
            self.clean_partials()?;
            let need = std::fs::metadata(c.kernel).map_err(io("READ_FAILED"))?.len() + std::fs::metadata(c.initrd).map_err(io("READ_FAILED"))?.len() + crate::preflight::MIN_ESP_FREE;
            let free = crate::preflight::free_bytes(&self.assets())?;
            if free < need {
                return uerr("UPDATE_PRECONDITION", format!("ESP has {free} bytes free, the candidate needs {need}; nothing written"));
            }
            std::fs::create_dir(&tmp).map_err(io("WRITE_FAILED"))?;
            for (src, name) in [(c.kernel, "linux"), (c.initrd, "initrd")] {
                std::fs::copy(src, tmp.join(name)).map_err(io("WRITE_FAILED"))?;
                File::open(tmp.join(name)).and_then(|f| f.sync_all()).map_err(io("WRITE_FAILED"))?;
                fault(&format!("boot.after_copy_{name}"));
            }
            fsync_dir(&tmp)?;
            if sha_file(&tmp.join("initrd"))? != c.initrd_hash || sha_file(&tmp.join("linux"))? != kh {
                let _ = std::fs::remove_dir_all(&tmp);
                return uerr("UPDATE_CONTENT_MISMATCH", "copied asset differs (ESP write error)");
            }
            fault("boot.before_dir_publish");
            std::fs::rename(&tmp, &final_dir).map_err(io("WRITE_FAILED"))?;
            fsync_dir(&self.assets())?;
        }
        fault("boot.before_entry");
        let entry = format!(
            "title {}\nversion {}\nlinux /EFI/agentos/{}/linux\ninitrd /EFI/agentos/{}/initrd\noptions init={} {} agentos.release={}\n",
            c.title.replace('\n', " "), c.release_id, c.release_id, c.release_id, c.init, c.cmdline, c.release_id
        );
        let id = Esp::entry_id(c.release_id);
        let existing = std::fs::read(self.entries().join(&id)).ok();
        if existing.as_deref() != Some(entry.as_bytes()) {
            self.register(c.release_id)?;
            self.write_atomic(&self.entries(), &id, entry.as_bytes())?;
        }
        fault("boot.after_entry");
        Ok(json!({ "entryId": id, "kernelHash": kh, "initrdHash": c.initrd_hash }))
    }

    /// A complete entry: the .conf exists and both assets it names exist with recorded content.
    pub fn entry_complete(&self, rid: &str) -> bool {
        let e = self.entries().join(Esp::entry_id(rid));
        let d = self.assets().join(rid);
        e.is_file() && d.join("linux").is_file() && d.join("initrd").is_file()
    }

    /// Remove leftovers of interrupted writes (temp dirs/files) — never a published entry.
    pub fn clean_partials(&self) -> UR<Vec<String>> {
        let mut out = vec![];
        for dir in [self.assets(), self.entries()] {
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for d in rd.flatten() {
                    let n = d.file_name().to_string_lossy().into_owned();
                    if n.starts_with(".tmp-") || (n.starts_with('.') && n.ends_with(".tmp")) {
                        let _ = std::fs::remove_dir_all(d.path()).or_else(|_| std::fs::remove_file(d.path()));
                        out.push(n);
                    }
                }
            }
        }
        Ok(out)
    }

    /// GC of boot entries: only registered `agentos-*` entries not in `keep` are removed; every other entry
    /// (other OSes, NixOS generations, recovery, the user's own) is left alone (spec §21.3, V1-U12).
    pub fn gc(&self, keep: &[String]) -> UR<Vec<String>> {
        let reg = self.registry();
        let mut removed = vec![];
        for id in reg["entries"].as_array().cloned().unwrap_or_default() {
            let id = id.as_str().unwrap_or_default().to_string();
            let rid = id.trim_start_matches("agentos-").trim_end_matches(".conf").to_string();
            if keep.iter().any(|k| k == &rid) || !valid_rid(&rid) {
                continue;
            }
            let _ = std::fs::remove_file(self.entries().join(&id));
            fsync_dir(&self.entries())?;
            let _ = std::fs::remove_dir_all(self.assets().join(&rid));
            removed.push(rid);
        }
        let mut r = reg.clone();
        r["entries"] = json!(reg["entries"].as_array().cloned().unwrap_or_default().into_iter().filter(|x| !removed.iter().any(|rid| x == &json!(Esp::entry_id(rid)))).collect::<Vec<_>>());
        self.write_atomic(&self.assets(), "registry.json", serde_json::to_string(&r).unwrap().as_bytes())?;
        Ok(removed)
    }
}

/// The firmware loader's one-shot and default slots.
pub trait Loader {
    fn set_oneshot(&mut self, entry: &str) -> UR<()>;
    fn oneshot(&self) -> UR<Option<String>>;
    fn set_default(&mut self, entry: &str) -> UR<()>;
    fn default(&self) -> UR<Option<String>>;
    /// The entry the running system was booted from.
    fn booted(&self) -> UR<Option<String>>;
}

/// systemd-boot via `bootctl` (EFI variables LoaderEntryOneShot / LoaderEntryDefault / LoaderEntrySelected).
pub struct Bootctl;
fn bootctl(args: &[&str]) -> UR<String> {
    let o = std::process::Command::new("bootctl").args(args).output().map_err(|e| UErr("BOOTCTL_UNAVAILABLE", e.to_string()))?;
    if !o.status.success() {
        return uerr("BOOTCTL_FAILED", String::from_utf8_lossy(&o.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&o.stdout).into_owned())
}
fn efivar(name: &str) -> Option<String> {
    // LoaderEntry* variables: 4-byte attributes then UTF-16LE NUL-terminated string.
    let p = format!("/sys/firmware/efi/efivars/{name}-4a67b082-0a4c-41cf-b6c7-440b29bb8c4f");
    let b = std::fs::read(p).ok()?;
    if b.len() < 6 {
        return None;
    }
    let u: Vec<u16> = b[4..].chunks(2).map(|c| u16::from_le_bytes([c[0], *c.get(1).unwrap_or(&0)])).take_while(|&x| x != 0).collect();
    Some(String::from_utf16_lossy(&u))
}
impl Loader for Bootctl {
    fn set_oneshot(&mut self, entry: &str) -> UR<()> {
        bootctl(&["set-oneshot", entry]).map(|_| ())
    }
    fn oneshot(&self) -> UR<Option<String>> {
        Ok(efivar("LoaderEntryOneShot"))
    }
    fn set_default(&mut self, entry: &str) -> UR<()> {
        bootctl(&["set-default", entry]).map(|_| ())
    }
    fn default(&self) -> UR<Option<String>> {
        Ok(efivar("LoaderEntryDefault"))
    }
    fn booted(&self) -> UR<Option<String>> {
        Ok(efivar("LoaderEntrySelected"))
    }
}

/// File-backed loader for tests and for machines without EFI variables (state in `<dir>/loader-state.json`).
pub struct FileLoader {
    pub path: PathBuf,
}
impl FileLoader {
    fn read(&self) -> Value {
        std::fs::read_to_string(&self.path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}))
    }
    fn write(&self, v: &Value) -> UR<()> {
        let tmp = self.path.with_extension("tmp");
        std::fs::write(&tmp, serde_json::to_vec(v).unwrap()).map_err(io("WRITE_FAILED"))?;
        File::open(&tmp).and_then(|f| f.sync_all()).map_err(io("WRITE_FAILED"))?;
        std::fs::rename(&tmp, &self.path).map_err(io("WRITE_FAILED"))
    }
    /// Simulate the firmware booting: one-shot wins once and is consumed; otherwise the default.
    pub fn boot(&self) -> UR<String> {
        let mut v = self.read();
        let pick = v["oneshot"].as_str().map(String::from).or_else(|| v["default"].as_str().map(String::from)).unwrap_or_default();
        v["oneshot"] = Value::Null;
        v["booted"] = json!(pick);
        self.write(&v)?;
        Ok(pick)
    }
}
impl Loader for FileLoader {
    fn set_oneshot(&mut self, entry: &str) -> UR<()> {
        let mut v = self.read();
        v["oneshot"] = json!(entry);
        self.write(&v)
    }
    fn oneshot(&self) -> UR<Option<String>> {
        Ok(self.read()["oneshot"].as_str().map(String::from))
    }
    fn set_default(&mut self, entry: &str) -> UR<()> {
        let mut v = self.read();
        v["default"] = json!(entry);
        self.write(&v)
    }
    fn default(&self) -> UR<Option<String>> {
        Ok(self.read()["default"].as_str().map(String::from))
    }
    fn booted(&self) -> UR<Option<String>> {
        Ok(self.read()["booted"].as_str().map(String::from))
    }
}

/// Arm the trial: the one-shot points at the complete candidate and is read back; the default is untouched.
pub fn arm(esp: &Esp, l: &mut dyn Loader, rid: &str, known_good_rid: &str) -> UR<Value> {
    if !esp.entry_complete(rid) {
        return uerr("NEEDS_ATTENTION", "candidate entry is not complete");
    }
    if !esp.entry_complete(known_good_rid) {
        return uerr("NEEDS_ATTENTION", "known-good entry is missing; refusing to arm");
    }
    let before = l.default()?;
    let id = Esp::entry_id(rid);
    l.set_oneshot(&id)?;
    if l.oneshot()?.as_deref() != Some(id.as_str()) {
        return uerr("NEEDS_ATTENTION", "one-shot did not read back");
    }
    if l.default()? != before {
        return uerr("NEEDS_ATTENTION", "default changed while arming");
    }
    Ok(json!({ "oneshot": id, "default": before }))
}
