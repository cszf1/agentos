//! Root-relative file access (spec §13). Every path is resolved from an already open root directory FD with openat2
//! RESOLVE_BENEATH | NO_SYMLINKS | NO_MAGICLINKS | NO_XDEV, and file type / identity are checked on the opened FD,
//! never by a realpath check followed by a second open.
use std::ffi::CString;
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::{AsRawFd, FromRawFd, OwnedFd, RawFd};

use serde_json::Value;
use sha2::{Digest, Sha256};

const RESOLVE_NO_XDEV: u64 = 0x01;
const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
const RESOLVE_BENEATH: u64 = 0x08;
#[cfg(target_arch = "x86_64")]
const SYS_OPENAT2: libc::c_long = 437;
#[cfg(target_arch = "aarch64")]
const SYS_OPENAT2: libc::c_long = 437;

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

#[derive(Debug)]
pub struct FsError {
    pub code: &'static str,
    pub message: String,
}

impl FsError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        FsError { code, message: message.into() }
    }
    fn os(code: &'static str, what: &str) -> Self {
        let e = std::io::Error::last_os_error();
        let code = match e.raw_os_error() {
            Some(libc::EXDEV) | Some(libc::ELOOP) => "PATH_SCOPE_VIOLATION",
            Some(libc::ENOENT) => "RESOURCE_GONE",
            _ => code,
        };
        FsError { code, message: format!("{what}: {e}") }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ident {
    pub dev: u64,
    pub ino: u64,
}

pub fn fstat(fd: RawFd) -> Result<libc::stat, FsError> {
    let mut st: libc::stat = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut st) } != 0 {
        return Err(FsError::os("CONTENT_UNAVAILABLE", "fstat"));
    }
    Ok(st)
}

pub fn ident_of(st: &libc::stat) -> Ident {
    Ident { dev: st.st_dev, ino: st.st_ino }
}

/// Open a registered root directory (absolute path, no symlink at the last component).
pub fn open_root(path: &str) -> Result<(OwnedFd, libc::stat), FsError> {
    let c = CString::new(path).map_err(|_| FsError::new("PATH_SCOPE_VIOLATION", "NUL in root path"))?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(FsError::os("RESOURCE_GONE", "open root"));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd) };
    let st = fstat(fd.as_raw_fd())?;
    Ok((fd, st))
}

pub fn openat2(dir: RawFd, rel: &str, flags: i32, mode: u32) -> Result<OwnedFd, FsError> {
    let c = CString::new(if rel.is_empty() { "." } else { rel }).map_err(|_| FsError::new("PATH_SCOPE_VIOLATION", "NUL in path"))?;
    let how = OpenHow {
        flags: (flags | libc::O_CLOEXEC) as u64,
        mode: mode as u64,
        resolve: RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_XDEV,
    };
    let fd = unsafe { libc::syscall(SYS_OPENAT2, dir, c.as_ptr(), &how as *const OpenHow, std::mem::size_of::<OpenHow>()) };
    if fd < 0 {
        return Err(FsError::os("CONTENT_UNAVAILABLE", "openat2"));
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
}

pub fn kind_of(st: &libc::stat) -> &'static str {
    match st.st_mode & libc::S_IFMT {
        libc::S_IFREG => "file",
        libc::S_IFDIR => "dir",
        libc::S_IFLNK => "symlink",
        libc::S_IFIFO => "fifo",
        libc::S_IFSOCK => "socket",
        libc::S_IFCHR | libc::S_IFBLK => "device",
        _ => "other",
    }
}

/// Spec §13.2: only regular files with one link and directories are accepted.
pub fn check_supported(st: &libc::stat) -> Result<(), FsError> {
    match kind_of(st) {
        "dir" => Ok(()),
        "file" if st.st_nlink == 1 => Ok(()),
        "file" => Err(FsError::new("UNSUPPORTED_FILE_TYPE", "files with more than one hard link are refused")),
        k => Err(FsError::new("UNSUPPORTED_FILE_TYPE", format!("{k} entries are refused"))),
    }
}

pub struct Entry {
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
    pub mtime_ms: i64,
    pub supported: bool,
}

/// List a directory below the root, sorted by name, starting after `cursor`.
pub fn list(root: RawFd, rel: &str, cursor: Option<&str>, limit: usize) -> Result<(Vec<Entry>, Option<String>, libc::stat), FsError> {
    let dfd = openat2(root, rel, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    let dst = fstat(dfd.as_raw_fd())?;
    let dup = unsafe { libc::dup(dfd.as_raw_fd()) };
    let dirp = unsafe { libc::fdopendir(dup) };
    if dirp.is_null() {
        return Err(FsError::os("CONTENT_UNAVAILABLE", "fdopendir"));
    }
    let mut names = Vec::new();
    loop {
        let ent = unsafe { libc::readdir(dirp) };
        if ent.is_null() {
            break;
        }
        let name = unsafe { std::ffi::CStr::from_ptr((*ent).d_name.as_ptr()) }.to_bytes().to_vec();
        if name == b"." || name == b".." {
            continue;
        }
        if let Ok(s) = String::from_utf8(name) {
            names.push(s);
        }
        if names.len() > 100_000 {
            break;
        }
    }
    unsafe { libc::closedir(dirp) };
    names.sort();
    let mut out = Vec::new();
    let mut next = None;
    for n in names.into_iter().filter(|n| cursor.is_none_or(|c| n.as_str() > c)) {
        if out.len() == limit {
            next = out.last().map(|e: &Entry| e.name.clone());
            break;
        }
        let c = CString::new(n.as_bytes()).unwrap();
        let mut st: libc::stat = unsafe { std::mem::zeroed() };
        if unsafe { libc::fstatat(dfd.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) } != 0 {
            continue;
        }
        if n.starts_with(".aos-tmp-") {
            continue;
        }
        out.push(Entry {
            name: n,
            kind: kind_of(&st),
            size: st.st_size as u64,
            mtime_ms: st.st_mtime * 1000 + st.st_mtime_nsec / 1_000_000,
            supported: check_supported(&st).is_ok(),
        });
    }
    Ok((out, next, dst))
}

pub struct TextRead {
    pub content: String,
    pub truncated: bool,
    pub size: u64,
    pub version: String,
    pub ident: Ident,
    pub changed: bool,
}

fn same_meta(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev
        && a.st_ino == b.st_ino
        && a.st_size == b.st_size
        && a.st_mtime == b.st_mtime
        && a.st_mtime_nsec == b.st_mtime_nsec
        && a.st_ctime == b.st_ctime
        && a.st_ctime_nsec == b.st_ctime_nsec
}

/// Read a bounded UTF-8 text file; the version is the hash of the whole content. Metadata is compared before and after.
pub fn read_text(root: RawFd, rel: &str, max: usize) -> Result<TextRead, FsError> {
    let fd = openat2(root, rel, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY, 0)?;
    let before = fstat(fd.as_raw_fd())?;
    if kind_of(&before) != "file" {
        return Err(FsError::new("UNSUPPORTED_FILE_TYPE", format!("{} is not a regular file", kind_of(&before))));
    }
    check_supported(&before)?;
    if before.st_size as u64 > 64 * 1024 * 1024 {
        return Err(FsError::new("LIMIT_EXCEEDED", "file larger than 64 MiB"));
    }
    let mut f = unsafe { std::fs::File::from_raw_fd(libc::dup(fd.as_raw_fd())) };
    let mut hasher = Sha256::new();
    let mut kept: Vec<u8> = Vec::with_capacity(max.min(before.st_size as usize) + 1);
    let mut total: u64 = 0;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| FsError::new("CONTENT_UNAVAILABLE", format!("read: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
        if kept.len() < max {
            let take = (max - kept.len()).min(n);
            kept.extend_from_slice(&buf[..take]);
        }
    }
    let after = fstat(fd.as_raw_fd())?;
    let changed = !same_meta(&before, &after) || total != before.st_size as u64;
    let truncated = total as usize > kept.len();
    let content = match std::str::from_utf8(&kept) {
        Ok(s) => s.to_string(),
        Err(e) if truncated && e.error_len().is_none() => String::from_utf8(kept[..e.valid_up_to()].to_vec()).unwrap(),
        Err(_) => return Err(FsError::new("CONTENT_UNAVAILABLE", "file is not valid UTF-8")),
    };
    Ok(TextRead { content, truncated, size: total, version: format!("sha256:{}", hex::encode(hasher.finalize())), ident: ident_of(&after), changed })
}

/// Hash and identity of a target below the root; None when absent.
pub fn target_version(root: RawFd, rel: &str) -> Result<Option<(String, Ident, u64)>, FsError> {
    match openat2(root, rel, libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY, 0) {
        Ok(fd) => {
            let st = fstat(fd.as_raw_fd())?;
            if kind_of(&st) != "file" {
                return Err(FsError::new("UNSUPPORTED_FILE_TYPE", "target is not a regular file"));
            }
            let mut f = unsafe { std::fs::File::from_raw_fd(libc::dup(fd.as_raw_fd())) };
            let mut h = Sha256::new();
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                let n = f.read(&mut buf).map_err(|e| FsError::new("CONTENT_UNAVAILABLE", format!("read: {e}")))?;
                if n == 0 {
                    break;
                }
                h.update(&buf[..n]);
            }
            Ok(Some((format!("sha256:{}", hex::encode(h.finalize())), ident_of(&st), st.st_nlink as u64)))
        }
        Err(e) if e.code == "RESOURCE_GONE" => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn content_version(bytes: &[u8]) -> String {
    format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
}

/// Split a relative path into (parent, leaf).
pub fn split_parent(rel: &str) -> (&str, &str) {
    match rel.rfind('/') {
        Some(i) => (&rel[..i], &rel[i + 1..]),
        None => ("", rel),
    }
}

/// Create the operation's unique temp file in the target's directory, write all bytes and fsync it.
pub fn write_temp(root: RawFd, parent: &str, temp_name: &str, bytes: &[u8]) -> Result<(), FsError> {
    let pfd = openat2(root, parent, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    let c = CString::new(temp_name).unwrap();
    let fd = unsafe { libc::openat(pfd.as_raw_fd(), c.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o644) };
    if fd < 0 {
        return Err(FsError::os("CONTENT_UNAVAILABLE", "create temp"));
    }
    let mut f = unsafe { std::fs::File::from_raw_fd(fd) };
    f.write_all(bytes).map_err(|e| FsError::new("CONTENT_UNAVAILABLE", format!("write temp: {e}")))?;
    f.sync_all().map_err(|e| FsError::new("CONTENT_UNAVAILABLE", format!("fsync temp: {e}")))?;
    Ok(())
}

/// renameat2 within one directory: NOREPLACE for create, plain (atomic replace) otherwise; then fsync the directory.
pub fn publish(root: RawFd, parent: &str, temp_name: &str, leaf: &str, no_replace: bool) -> Result<(), FsError> {
    let pfd = openat2(root, parent, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    let a = CString::new(temp_name).unwrap();
    let b = CString::new(leaf).unwrap();
    let flags: libc::c_uint = if no_replace { 1 } else { 0 };
    let rc = unsafe { libc::syscall(libc::SYS_renameat2, pfd.as_raw_fd(), a.as_ptr(), pfd.as_raw_fd(), b.as_ptr(), flags) };
    if rc != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::EEXIST) {
            return Err(FsError::new("FILE_VERSION_STALE", "target appeared before publication (no-replace)"));
        }
        return Err(FsError::new("CONTENT_UNAVAILABLE", format!("renameat2: {e}")));
    }
    if unsafe { libc::fsync(pfd.as_raw_fd()) } != 0 {
        return Err(FsError::os("CONTENT_UNAVAILABLE", "fsync parent"));
    }
    Ok(())
}

pub fn unlink_temp(root: RawFd, parent: &str, temp_name: &str) -> Result<bool, FsError> {
    let pfd = openat2(root, parent, libc::O_RDONLY | libc::O_DIRECTORY, 0)?;
    let c = CString::new(temp_name).unwrap();
    let rc = unsafe { libc::unlinkat(pfd.as_raw_fd(), c.as_ptr(), 0) };
    if rc != 0 {
        let e = std::io::Error::last_os_error();
        if e.raw_os_error() == Some(libc::ENOENT) {
            return Ok(false);
        }
        return Err(FsError::new("CONTENT_UNAVAILABLE", format!("unlink temp: {e}")));
    }
    let _ = unsafe { libc::fsync(pfd.as_raw_fd()) };
    Ok(true)
}

pub fn temp_exists(root: RawFd, parent: &str, temp_name: &str) -> bool {
    match openat2(root, parent, libc::O_RDONLY | libc::O_DIRECTORY, 0) {
        Ok(pfd) => {
            let c = CString::new(temp_name).unwrap();
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            unsafe { libc::fstatat(pfd.as_raw_fd(), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) == 0 }
        }
        Err(_) => false,
    }
}

pub fn path_bytes(p: &std::path::Path) -> &[u8] {
    p.as_os_str().as_bytes()
}

/// Shared read implementation for file.list / file.stat / file.read_text over an already opened root FD.
pub fn read_cap(root: i32, cap: &str, p: &Value) -> Result<serde_json::Value, FsError> {
    match cap {
        "file.list" => {
            let path = p["path"].as_str().unwrap_or("");
            let (entries, next, dst) = list(root, path, p["cursor"].as_str(), p["limit"].as_u64().unwrap_or(200) as usize)?;
            Ok(serde_json::json!({
                "path": path,
                "entries": entries.iter().map(|e| serde_json::json!({"name": e.name, "kind": e.kind, "size": e.size, "mtimeMs": e.mtime_ms, "supported": e.supported})).collect::<Vec<_>>(),
                "nextCursor": next,
                "dirVersion": format!("{}:{}:{}", dst.st_ino, dst.st_mtime, dst.st_mtime_nsec),
            }))
        }
        "file.stat" => {
            let path = p["path"].as_str().unwrap_or("");
            let fd = openat2(
                root,
                path,
                libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_NOCTTY | if path.is_empty() { libc::O_DIRECTORY } else { 0 },
                0,
            )?;
            let st = fstat(fd.as_raw_fd())?;
            Ok(
                serde_json::json!({"path": path, "kind": kind_of(&st), "size": st.st_size, "nlink": st.st_nlink, "mtimeMs": st.st_mtime * 1000 + st.st_mtime_nsec / 1_000_000, "supported": check_supported(&st).is_ok()}),
            )
        }
        "file.read_text" => {
            let path = p["path"].as_str().unwrap_or("");
            let r = read_text(root, path, p["maxBytes"].as_u64().unwrap_or(262144) as usize)?;
            if r.changed {
                return Err(FsError::new("RESOURCE_CHANGED", "the file changed while it was read"));
            }
            Ok(
                serde_json::json!({"path": path, "content": r.content, "truncated": r.truncated, "size": r.size, "version": r.version, "identity": {"dev": r.ident.dev, "ino": r.ident.ino}}),
            )
        }
        _ => Err(FsError::new("CAPABILITY_VERSION_UNSUPPORTED", "unsupported file read")),
    }
}
