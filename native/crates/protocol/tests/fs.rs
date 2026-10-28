//! Real-filesystem checks of the root-relative resolver (V3-F01/F02/F03/F05/F06 at the library level): every path
//! is resolved from an open root FD with openat2, and type/identity are checked on the opened FD.
use agentos_protocol::fsutil::{self, open_root};
use std::os::unix::fs::symlink;
use std::os::unix::io::AsRawFd;

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("aos-fs-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn escapes_are_refused() {
    let d = tmp("esc");
    let root = d.join("root");
    std::fs::create_dir_all(root.join("sub")).unwrap();
    std::fs::write(d.join("secret.txt"), "outside").unwrap();
    std::fs::write(root.join("ok.txt"), "inside").unwrap();
    symlink(d.join("secret.txt"), root.join("link-out")).unwrap();
    symlink("ok.txt", root.join("link-in")).unwrap();
    symlink("/proc/self/root/etc/passwd", root.join("magic")).unwrap();
    let (fd, _) = open_root(root.to_str().unwrap()).unwrap();
    let r = fd.as_raw_fd();
    assert!(fsutil::read_text(r, "ok.txt", 1000).is_ok());
    for p in ["link-out", "link-in", "magic", "../secret.txt", "sub/../../secret.txt"] {
        assert!(fsutil::read_text(r, p, 1000).is_err(), "{p} must be refused");
    }
    // /proc magic links from inside the root
    assert!(fsutil::openat2(r, "../../../../proc/self/root/etc/passwd", libc::O_RDONLY, 0).is_err());
}

#[test]
fn special_files_and_hardlinks_are_refused() {
    let d = tmp("special");
    std::fs::write(d.join("a.txt"), "a").unwrap();
    std::fs::hard_link(d.join("a.txt"), d.join("b.txt")).unwrap();
    let fifo = std::ffi::CString::new(d.join("fifo").to_str().unwrap()).unwrap();
    unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) };
    let (fd, _) = open_root(d.to_str().unwrap()).unwrap();
    let e = fsutil::read_text(fd.as_raw_fd(), "a.txt", 100).err().expect("hard-linked file refused");
    assert_eq!(e.code, "UNSUPPORTED_FILE_TYPE");
    assert!(fsutil::read_text(fd.as_raw_fd(), "fifo", 100).is_err());
}

#[test]
fn reads_report_truncation_and_encoding() {
    let d = tmp("read");
    std::fs::write(d.join("big.txt"), "x".repeat(5000)).unwrap();
    std::fs::write(d.join("bin.dat"), [0xffu8, 0xfe, 0x00]).unwrap();
    let (fd, _) = open_root(d.to_str().unwrap()).unwrap();
    let r = fsutil::read_text(fd.as_raw_fd(), "big.txt", 100).unwrap();
    assert!(r.truncated, "a partial read is labelled truncated");
    assert_eq!(r.size, 5000);
    assert_eq!(r.content.len(), 100);
    // The version is the hash of the WHOLE file, not of the returned prefix.
    assert_eq!(r.version, format!("sha256:{}", agentos_protocol::sha256_hex("x".repeat(5000).as_bytes())));
    assert!(fsutil::read_text(fd.as_raw_fd(), "bin.dat", 100).is_err(), "non UTF-8 is refused");
}

#[test]
fn atomic_publish_conditions() {
    let d = tmp("pub");
    let (fd, _) = open_root(d.to_str().unwrap()).unwrap();
    let r = fd.as_raw_fd();
    fsutil::write_temp(r, "", ".aos-tmp-1", b"one").unwrap();
    fsutil::publish(r, "", ".aos-tmp-1", "f.txt", true).unwrap();
    // expectedAbsent never overwrites
    fsutil::write_temp(r, "", ".aos-tmp-2", b"two").unwrap();
    assert!(fsutil::publish(r, "", ".aos-tmp-2", "f.txt", true).is_err());
    assert_eq!(std::fs::read_to_string(d.join("f.txt")).unwrap(), "one");
    // replace path
    fsutil::publish(r, "", ".aos-tmp-2", "f.txt", false).unwrap();
    assert_eq!(std::fs::read_to_string(d.join("f.txt")).unwrap(), "two");
    assert!(fsutil::unlink_temp(r, "", ".aos-tmp-9").map(|x| !x).unwrap_or(true));
}
