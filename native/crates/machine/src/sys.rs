//! Real system effects of the machine directory: Linux accounts, sub-ID ranges, workspace roots, linger and the
//! per-workspace systemd units. Every call takes registered values only (never a client-supplied path or unit name)
//! and is safe to repeat: callers reconcile what already exists before acting (spec §7.2, §8.1, §26 row 1).
use crate::err::{MErr, R};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
pub struct Paths {
    pub machine_dir: PathBuf,
    pub workspaces_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub run_dir: PathBuf,
    pub snapshots_dir: PathBuf,
}

impl Default for Paths {
    fn default() -> Self {
        Paths {
            machine_dir: "/var/lib/agentos-machine".into(),
            workspaces_dir: "/var/lib/agentos/workspaces".into(),
            runtime_dir: "/var/lib/agentos-runtime".into(),
            run_dir: "/run/agentos".into(),
            snapshots_dir: "/var/lib/agentos-snapshots".into(),
        }
    }
}

impl Paths {
    pub fn ws_root(&self, ws: &str) -> PathBuf {
        self.workspaces_dir.join(ws)
    }
    pub fn ws_data(&self, ws: &str) -> PathBuf {
        self.ws_root(ws).join("data")
    }
    pub fn ws_secrets(&self, ws: &str) -> PathBuf {
        self.ws_root(ws).join("secrets")
    }
    pub fn ws_runtime(&self, ws: &str) -> PathBuf {
        self.runtime_dir.join(ws)
    }
    pub fn ws_run(&self, ws: &str) -> PathBuf {
        self.run_dir.join("workspaces").join(ws)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PwEntry {
    pub name: String,
    pub uid: u32,
    pub gecos: String,
    pub home: String,
}

pub trait System: Send {
    fn pw_by_name(&self, name: &str) -> Option<PwEntry>;
    fn pw_by_uid(&self, uid: u32) -> Option<PwEntry>;
    fn subid_overlaps(&self, start: u32, size: u32) -> bool;
    fn create_login_user(&mut self, name: &str, uid: u32, gecos: &str, admin: bool) -> R<()>;
    fn set_gecos(&mut self, name: &str, gecos: &str) -> R<()>;
    fn set_password(&mut self, name: &str, password: &[u8]) -> R<()>;
    fn lock_user(&mut self, name: &str) -> R<()>;
    fn terminate_user(&mut self, uid: u32) -> R<()>;
    fn create_exec_user(&mut self, name: &str, uid: u32, marker: &str, home: &Path, subid_start: u32, range: u32) -> R<()>;
    fn ensure_workspace_dirs(&mut self, paths: &Paths, ws: &str, uid: u32) -> R<()>;
    fn enable_linger(&mut self, name: &str) -> R<()>;
    fn disable_linger(&mut self, name: &str) -> R<()>;
    fn init_workspace(&mut self, paths: &Paths, ws: &str, store_uuid: &str, uid: u32, exec_login: &str) -> R<()>;
    fn start_workspace(&mut self, ws: &str, uid: u32) -> R<()>;
    fn stop_workspace(&mut self, ws: &str, uid: u32) -> R<()>;
    /// Whether any process still runs in the workspace's execution cgroup (user-<uid>.slice).
    fn exec_cgroup_busy(&self, uid: u32) -> bool;
    fn kill_exec_cgroup(&mut self, uid: u32) -> R<()>;
    /// Free bytes and read-only flag of the filesystem holding `path` (spec §27.1 R12). Missing path → (MAX, false).
    fn storage(&self, path: &Path) -> (u64, bool) {
        use std::os::unix::ffi::OsStrExt;
        let c = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
            Ok(c) => c,
            Err(_) => return (u64::MAX, false),
        };
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statvfs(c.as_ptr(), &mut st) } != 0 {
            return (u64::MAX, false);
        }
        ((st.f_bavail as u64).saturating_mul(st.f_frsize as u64), st.f_flag & libc::ST_RDONLY != 0)
    }
    /// Remove the registered roots of a deleted workspace (data, secrets, runtime/graphroot, run dir). Idempotent.
    fn remove_workspace_roots(&mut self, paths: &Paths, ws: &str) -> R<()>;
}

fn run(cmd: &mut Command) -> R<String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| MErr::new("SYSTEM_FAILED", format!("spawn {:?}: {e}", cmd.get_program())))?;
    if !out.status.success() {
        return Err(MErr::new("SYSTEM_FAILED", format!("{:?} exited {}: {}", cmd.get_program(), out.status, String::from_utf8_lossy(&out.stderr).trim())));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

fn read_passwd() -> Vec<PwEntry> {
    let text = std::fs::read_to_string("/etc/passwd").unwrap_or_default();
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            if f.len() < 7 {
                return None;
            }
            Some(PwEntry { name: f[0].into(), uid: f[2].parse().ok()?, gecos: f[4].into(), home: f[5].into() })
        })
        .collect()
}

fn subid_lines(file: &str) -> Vec<(String, u32, u32)> {
    std::fs::read_to_string(file)
        .unwrap_or_default()
        .lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split(':').collect();
            if f.len() != 3 {
                return None;
            }
            Some((f[0].to_string(), f[1].parse().ok()?, f[2].parse().ok()?))
        })
        .collect()
}

pub(crate) fn open_dir_nofollow(path: &Path) -> std::io::Result<std::fs::File> {
    if !path.is_absolute() { return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "absolute directory required")); }
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let mut dir = std::fs::File::open("/")?;
    for part in path.components() {
        let name = match part {
            std::path::Component::RootDir => continue,
            std::path::Component::Normal(name) => std::ffi::CString::new(name.as_bytes())?,
            _ => return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "absolute normal path required")),
        };
        let fd = unsafe { libc::openat(dir.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        dir = unsafe { std::fs::File::from_raw_fd(fd) };
    }
    Ok(dir)
}

pub(crate) fn fd_owner_mode(file: &std::fs::File, uid: u32, gid: u32, mode: u32) -> std::io::Result<()> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::PermissionsExt;
    if unsafe { libc::fchown(file.as_raw_fd(), uid, gid) } != 0 { return Err(std::io::Error::last_os_error()); }
    file.set_permissions(std::fs::Permissions::from_mode(mode))
}

fn chown_mode(p: &Path, uid: u32, gid: u32, mode: u32) -> R<()> {
    open_dir_nofollow(p).and_then(|f| fd_owner_mode(&f, uid, gid, mode))
        .map_err(|e| MErr::new("SYSTEM_FAILED", format!("directory {}: {e}", p.display())))
}

fn mkdir(p: &Path, uid: u32, gid: u32, mode: u32) -> R<()> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::{ffi::OsStrExt, fs::MetadataExt};
    let effect = || -> std::io::Result<()> {
        let parent = open_dir_nofollow(p.parent().ok_or_else(|| std::io::Error::other("missing parent"))?)?;
        let name = std::ffi::CString::new(p.file_name().ok_or_else(|| std::io::Error::other("missing name"))?.as_bytes())?;
        if unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), mode) } != 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() != std::io::ErrorKind::AlreadyExists { return Err(err); }
        }
        let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
        if fd < 0 { return Err(std::io::Error::last_os_error()); }
        let file = unsafe { std::fs::File::from_raw_fd(fd) };
        let owner = file.metadata()?.uid();
        if owner != uid && owner != 0 { return Err(std::io::Error::other("unexpected directory owner")); }
        fd_owner_mode(&file, uid, gid, mode)
    };
    effect().map_err(|e| MErr::new("SYSTEM_FAILED", format!("mkdir {}: {e}", p.display())))
}

pub fn write_workspace_file(parent: &Path, directory: &Path, name: &str, uid: u32, text: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::fs::MetadataExt;
    if directory.as_os_str().is_empty() || directory.components().any(|c| !matches!(c, std::path::Component::Normal(_))) || name.is_empty() || matches!(name, "." | "..") || name.contains('/') {
        return Err(std::io::Error::other("invalid workspace destination"));
    }
    let parent_fd = open_dir_nofollow(parent)?;
    let meta = parent_fd.metadata()?;
    if meta.uid() != unsafe { libc::geteuid() } || meta.mode() & 0o022 != 0 {
        return Err(std::io::Error::other("credential staging directory is not trusted"));
    }
    let destination = open_dir_nofollow(&parent.join(directory))?;
    let tmp = std::ffi::CString::new(format!(".workspace-{}.tmp", crate::util::uuid())).unwrap();
    let target = std::ffi::CString::new(name)?;
    let fd = unsafe { libc::openat(parent_fd.as_raw_fd(), tmp.as_ptr(), libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC, 0o600) };
    if fd < 0 { return Err(std::io::Error::last_os_error()); }
    let mut file = unsafe { std::fs::File::from_raw_fd(fd) };
    let res = (|| {
        file.write_all(text)?;
        fd_owner_mode(&file, uid, uid, 0o600)?;
        file.sync_all()?;
        if unsafe { libc::renameat(parent_fd.as_raw_fd(), tmp.as_ptr(), destination.as_raw_fd(), target.as_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        destination.sync_all()?;
        parent_fd.sync_all()
    })();
    if res.is_err() { unsafe { libc::unlinkat(parent_fd.as_raw_fd(), tmp.as_ptr(), 0); } }
    res
}

pub fn user_unit_ctl(uid: u32, args: &[&str]) -> R<String> {
    let rt = format!("/run/user/{uid}");
    run(Command::new("setpriv")
        .args(["--reuid", &uid.to_string(), "--regid", &uid.to_string(), "--init-groups", "--"])
        .arg("systemctl")
        .arg("--user")
        .args(args)
        .env_clear()
        .env("XDG_RUNTIME_DIR", &rt)
        .env("DBUS_SESSION_BUS_ADDRESS", format!("unix:path={rt}/bus"))
        .env("PATH", std::env::var("PATH").unwrap_or_else(|_| "/run/current-system/sw/bin:/usr/bin:/bin".into())))
}

/// Real Linux implementation used by the daemon.
pub struct HostSystem {
    /// Fixed workspace initialiser (agentos-admin from the release closure), run as the execution UID.
    pub init_program: PathBuf,
}

impl System for HostSystem {
    fn pw_by_name(&self, name: &str) -> Option<PwEntry> {
        read_passwd().into_iter().find(|e| e.name == name)
    }
    fn pw_by_uid(&self, uid: u32) -> Option<PwEntry> {
        read_passwd().into_iter().find(|e| e.uid == uid)
    }
    fn subid_overlaps(&self, start: u32, size: u32) -> bool {
        let end = start as u64 + size as u64;
        subid_lines("/etc/subuid").into_iter().chain(subid_lines("/etc/subgid")).any(|(_, s, n)| (s as u64) < end && start as u64 > 0 && (s as u64 + n as u64) > start as u64)
    }
    fn create_login_user(&mut self, name: &str, uid: u32, gecos: &str, _admin: bool) -> R<()> {
        // Admins are machine administrators of AgentOS only: no sudo/wheel, no Nix trusted-users (spec §7.2).
        run(Command::new("useradd").args(["-m", "-u", &uid.to_string(), "-U", "-c", gecos, "-s", "/run/current-system/sw/bin/bash", name]).env("PATH", std::env::var("PATH").unwrap_or_default()))?;
        run(Command::new("passwd").args(["-l", name])).map(|_| ())
    }
    fn set_gecos(&mut self, name: &str, gecos: &str) -> R<()> {
        run(Command::new("usermod").args(["-c", gecos, name])).map(|_| ())
    }
    fn set_password(&mut self, name: &str, password: &[u8]) -> R<()> {
        if password.is_empty() || password.contains(&b':') || password.contains(&b'\n') {
            return Err(MErr::new("INVALID_REQUEST", "password is empty or contains a separator"));
        }
        let mut child = Command::new("chpasswd").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| MErr::new("SYSTEM_FAILED", format!("chpasswd: {e}")))?;
        {
            let mut stdin = child.stdin.take().expect("piped");
            let mut line = Vec::with_capacity(name.len() + password.len() + 2);
            line.extend_from_slice(name.as_bytes());
            line.push(b':');
            line.extend_from_slice(password);
            line.push(b'\n');
            stdin.write_all(&line).map_err(|e| MErr::new("SYSTEM_FAILED", format!("chpasswd stdin: {e}")))?;
            for b in line.iter_mut() {
                *b = 0;
            }
        }
        let out = child.wait_with_output().map_err(|e| MErr::new("SYSTEM_FAILED", format!("chpasswd: {e}")))?;
        if !out.status.success() {
            return Err(MErr::new("SYSTEM_FAILED", "chpasswd rejected the password"));
        }
        let _ = run(Command::new("passwd").args(["-u", name]));
        Ok(())
    }
    fn lock_user(&mut self, name: &str) -> R<()> {
        run(Command::new("usermod").args(["-L", "-e", "1", name])).map(|_| ())
    }
    fn terminate_user(&mut self, uid: u32) -> R<()> {
        let _ = run(Command::new("loginctl").args(["terminate-user", &uid.to_string()]));
        Ok(())
    }
    fn create_exec_user(&mut self, name: &str, uid: u32, marker: &str, home: &Path, subid_start: u32, range: u32) -> R<()> {
        if self.pw_by_name(name).is_none() {
            run(Command::new("useradd").args(["--system", "-u", &uid.to_string(), "-U", "-M", "-d"]).arg(home).args(["-c", marker, "-s", "/run/current-system/sw/bin/nologin", name]))?;
        }
        let have = subid_lines("/etc/subuid").into_iter().any(|(n, s, r)| n == name && s == subid_start && r == range);
        if !have {
            let spec = format!("{}-{}", subid_start, subid_start + range - 1);
            run(Command::new("usermod").args(["--add-subuids", &spec, "--add-subgids", &spec, name]))?;
        }
        Ok(())
    }
    fn ensure_workspace_dirs(&mut self, paths: &Paths, ws: &str, uid: u32) -> R<()> {
        for (p, o, m) in [
            (paths.workspaces_dir.clone(), 0u32, 0o711u32),
            (paths.runtime_dir.clone(), 0, 0o711),
            (paths.run_dir.clone(), 0, 0o755),
            (paths.run_dir.join("workspaces"), 0, 0o711),
        ] {
            std::fs::create_dir_all(&p).map_err(|e| MErr::new("SYSTEM_FAILED", format!("mkdir {}: {e}", p.display())))?;
            chown_mode(&p, o, o, m)?;
        }
        // The home is traverse-only (0711, no listing) down to the rootless Podman graphroot: with
        // --userns=keep-id the OCI runtime resolves the container rootfs as the mapped container root, which cannot
        // pass a 0700 home ("crun: readlink ``", m5). Everything with content below stays 0700 (W01).
        mkdir(&paths.ws_root(ws), uid, uid, 0o711)?;
        let local = paths.ws_root(ws).join(".local");
        mkdir(&local, uid, uid, 0o711)?;
        mkdir(&local.join("share"), uid, uid, 0o711)?;
        mkdir(&local.join("share").join("containers"), uid, uid, 0o711)?;
        mkdir(&paths.ws_data(ws), uid, uid, 0o700)?;
        mkdir(&paths.ws_secrets(ws), uid, uid, 0o700)?;
        mkdir(&paths.ws_runtime(ws), uid, uid, 0o700)?;
        mkdir(&paths.ws_run(ws), uid, uid, 0o700)?;
        Ok(())
    }
    fn enable_linger(&mut self, name: &str) -> R<()> {
        run(Command::new("loginctl").args(["enable-linger", name])).map(|_| ())
    }
    fn disable_linger(&mut self, name: &str) -> R<()> {
        run(Command::new("loginctl").args(["disable-linger", name])).map(|_| ())
    }
    fn init_workspace(&mut self, paths: &Paths, ws: &str, store_uuid: &str, uid: u32, _exec_login: &str) -> R<()> {
        let data = paths.ws_data(ws);
        run(Command::new("setpriv")
            .args(["--reuid", &uid.to_string(), "--regid", &uid.to_string(), "--init-groups", "--"])
            .arg(&self.init_program)
            .args(["workspace-init", "--workspace-id", ws, "--store-uuid", store_uuid, "--data-dir"])
            .arg(&data)
            .env_clear()
            .env("HOME", paths.ws_root(ws))
            .env("AGENTOS_DATA_DIR", &data)
            .env("PATH", std::env::var("PATH").unwrap_or_default()))
        .map(|_| ())
    }
    fn start_workspace(&mut self, ws: &str, uid: u32) -> R<()> {
        run(Command::new("systemctl").args(["start", &format!("user@{uid}.service")]))?;
        user_unit_ctl(uid, &["start", &format!("agentos-workspace@{ws}.target")]).map(|_| ())
    }
    fn stop_workspace(&mut self, ws: &str, uid: u32) -> R<()> {
        user_unit_ctl(uid, &["stop", &format!("agentos-workspace@{ws}.target"), &format!("agentos-host@{ws}.service")])?;
        // The rest of this execution identity ends with it (spec §8.2): the socket-activated rootless Podman service,
        // its long-lived pause process (a transient scope in user.slice) and any container/conmon left behind. Only
        // the user manager itself (init.scope) and its session bus stay; the busy check below then sees no process.
        let _ = user_unit_ctl(uid, &["stop", "podman.socket", "podman.service"]);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while self.exec_cgroup_busy(uid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        if self.exec_cgroup_busy(uid) {
            let _ = user_unit_ctl(uid, &["kill", "--signal=SIGKILL", "app.slice", "user.slice", "background.slice"]);
        }
        Ok(())
    }
    fn exec_cgroup_busy(&self, uid: u32) -> bool {
        // Any process of the execution UID counts (Host, Pi workers, rootless Podman, conmon), except the UID's own
        // systemd user manager (`user@<uid>.service/init.scope`) and its session bus (`session.slice`): the manager
        // starts the Host and stays up between instances. A process anywhere else under that UID — the Host unit in
        // app.slice, Podman containers, conmon, or anything outside the manager — is a previous execution.
        std::fs::read_dir("/proc")
            .map(|d| {
                d.flatten().any(|e| {
                    use std::os::unix::fs::MetadataExt;
                    let name = e.file_name().to_string_lossy().into_owned();
                    if !name.chars().all(|c| c.is_ascii_digit()) || e.metadata().map(|m| m.uid() != uid).unwrap_or(true) {
                        return false;
                    }
                    let cg = std::fs::read_to_string(format!("/proc/{name}/cgroup")).unwrap_or_default();
                    let mgr = format!("/user@{uid}.service/");
                    // manager infrastructure: the manager itself (init.scope) and its session bus (session.slice)
                    !cg.lines().any(|l| l.contains(&mgr) && (l.ends_with("/init.scope") || l.contains("/session.slice/")))
                })
            })
            .unwrap_or(false)
    }
    fn remove_workspace_roots(&mut self, paths: &Paths, ws: &str) -> R<()> {
        for p in [paths.ws_root(ws), paths.ws_runtime(ws), paths.ws_run(ws)] {
            // Registered paths only (built from the workspace UUID); never follow a link out of the parent.
            match std::fs::symlink_metadata(&p) {
                Ok(m) if m.file_type().is_symlink() => std::fs::remove_file(&p).map_err(|e| MErr::new("SYSTEM_FAILED", format!("{}: {e}", p.display())))?,
                Ok(_) => std::fs::remove_dir_all(&p).map_err(|e| MErr::new("SYSTEM_FAILED", format!("{}: {e}", p.display())))?,
                Err(_) => {}
            }
        }
        Ok(())
    }
    fn kill_exec_cgroup(&mut self, uid: u32) -> R<()> {
        let _ = run(Command::new("systemctl").args(["kill", "--signal=SIGKILL", &format!("user-{uid}.slice")]));
        Ok(())
    }
}

#[cfg(test)]
mod secure_directory_tests {
    use super::*;
    #[test]
    fn refuses_symlink_components_without_changing_the_target() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let tmp = std::env::temp_dir().join(format!("agentos-secure-{}", crate::util::uuid()));
        std::fs::create_dir(&tmp).unwrap();
        let target = tmp.as_path().join("target");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = tmp.as_path().join("link");
        symlink(&target, &link).unwrap();
        let uid = unsafe { libc::geteuid() };
        assert!(open_dir_nofollow(Path::new("relative")).is_err());
        assert!(mkdir(&link, uid, uid, 0o700).is_err());
        assert!(mkdir(&link.join("child"), uid, uid, 0o700).is_err());
        assert_eq!(std::fs::metadata(&target).unwrap().permissions().mode() & 0o777, 0o755);
        assert!(!target.join("child").exists());
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
