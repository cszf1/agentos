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
    fn create_login_user(&mut self, name: &str, uid: u32, marker: &str, admin: bool) -> R<()>;
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

fn chown_mode(p: &Path, uid: u32, gid: u32, mode: u32) -> R<()> {
    use std::os::unix::fs::PermissionsExt;
    std::os::unix::fs::chown(p, Some(uid), Some(gid)).map_err(|e| MErr::new("SYSTEM_FAILED", format!("chown {}: {e}", p.display())))?;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode)).map_err(|e| MErr::new("SYSTEM_FAILED", format!("chmod {}: {e}", p.display())))
}

fn mkdir(p: &Path, uid: u32, gid: u32, mode: u32) -> R<()> {
    use std::os::unix::fs::MetadataExt;
    match std::fs::symlink_metadata(p) {
        Ok(m) => {
            if !m.is_dir() || m.file_type().is_symlink() {
                return Err(MErr::new("SYSTEM_FAILED", format!("{} exists and is not a directory", p.display())));
            }
            // An existing directory owned by an unexpected account is never adopted (spec §7.2: no takeover).
            if m.uid() != uid && m.uid() != 0 {
                return Err(MErr::new("SYSTEM_FAILED", format!("{} is owned by uid {}", p.display(), m.uid())));
            }
        }
        Err(_) => std::fs::create_dir(p).map_err(|e| MErr::new("SYSTEM_FAILED", format!("mkdir {}: {e}", p.display())))?,
    }
    chown_mode(p, uid, gid, mode)
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
    fn create_login_user(&mut self, name: &str, uid: u32, marker: &str, _admin: bool) -> R<()> {
        // Admins are machine administrators of AgentOS only: no sudo/wheel, no Nix trusted-users (spec §7.2).
        run(Command::new("useradd").args(["-m", "-u", &uid.to_string(), "-U", "-c", marker, "-s", "/run/current-system/sw/bin/bash", name]).env("PATH", std::env::var("PATH").unwrap_or_default()))?;
        run(Command::new("passwd").args(["-l", name])).map(|_| ())
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
        mkdir(&paths.ws_root(ws), uid, uid, 0o700)?;
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
        user_unit_ctl(uid, &["stop", &format!("agentos-workspace@{ws}.target"), &format!("agentos-host@{ws}.service")]).map(|_| ())
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
    fn kill_exec_cgroup(&mut self, uid: u32) -> R<()> {
        let _ = run(Command::new("systemctl").args(["kill", "--signal=SIGKILL", &format!("user-{uid}.slice")]));
        Ok(())
    }
}
