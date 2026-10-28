//! Kernel-provided peer credentials of a Unix socket (SO_PEERCRED). Identity claims inside JSON are never used instead.
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PeerCred {
    pub pid: i32,
    pub uid: u32,
    pub gid: u32,
}

pub fn peer_cred(s: &UnixStream) -> std::io::Result<PeerCred> {
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let rc = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(PeerCred { pid: cred.pid, uid: cred.uid, gid: cred.gid })
}
