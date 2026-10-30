//! Machine directory: install identity, accounts, workspaces, members, revocations, registry outbox and instances
//! (spec §6, §7, §8, §14.2, §15.1). One writer: this process. Provisioning is a fixed step catalogue with stable IDs
//! and receipts so a crash between steps is reconciled against the real system instead of re-running blindly.
use crate::db;
use crate::err::{MErr, R};
use crate::sys::{Paths, System};
use crate::util::{boot_id, canon, hash, is_uuid, now_ms, random_bytes, sha256, uuid};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub const LOGIN_UID_START: u32 = 10000;
pub const LOGIN_UID_END: u32 = 19999;
pub const EXEC_UID_START: u32 = 20000;
pub const EXEC_UID_END: u32 = 20999;
pub const SUBID_START: u32 = 1_000_000_000;
pub const SUBID_RANGE: u32 = 65536;
pub const MAX_USERS: i64 = 4;
pub const MAX_WORKSPACES: i64 = 4;
pub const MAX_RUNNING: i64 = 2;
/// Space kept free for receipts and audit of work already accepted (spec §27.1).
pub const MIN_FREE_BYTES: u64 = 256 * 1024 * 1024;
pub const TRANSFER_MS: i64 = 86_400_000;

pub const USER_STEPS: [&str; 3] = ["allocate", "account", "registry"];
pub const WORKSPACE_STEPS: [&str; 7] = ["allocate", "account", "directory", "databases", "broker", "linger", "registry"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Viewer,
    Editor,
    Owner,
}

impl Role {
    pub fn parse(s: &str) -> R<Role> {
        match s {
            "viewer" => Ok(Role::Viewer),
            "editor" => Ok(Role::Editor),
            "owner" => Ok(Role::Owner),
            _ => Err(MErr::new("INVALID_REQUEST", "unknown role")),
        }
    }
    pub fn as_str(&self) -> &'static str {
        match self {
            Role::Viewer => "viewer",
            Role::Editor => "editor",
            Role::Owner => "owner",
        }
    }
}

/// Product authorisation of spec §7.1. root can read local data anyway; this is what the product grants.
pub fn member_allows(role: Role, action: &str, own: bool) -> bool {
    match action {
        "read" => true,
        "write" | "app.modify" | "revision.switch" | "run.create" => role != Role::Viewer,
        "run.transcript" | "run.cancel" => role == Role::Owner || (role == Role::Editor && own),
        "maintenance.propose" => role != Role::Viewer,
        "maintenance.approve" | "grant.system" | "candidate.confirm" | "model.config" | "workspace.export" | "workspace.restore" | "members.manage" | "workspace.settings" => role == Role::Owner,
        _ => false,
    }
}

pub struct Machine {
    pub c: Connection,
    pub paths: Paths,
    pub sys: Box<dyn System>,
    pub boot: String,
}

fn opt_i64(c: &Connection, sql: &str, p: impl rusqlite::Params) -> R<Option<i64>> {
    Ok(c.query_row(sql, p, |r| r.get::<_, i64>(0)).optional()?)
}

fn tx<T>(c: &Connection, f: impl FnOnce(&Connection) -> R<T>) -> R<T> {
    c.execute_batch("BEGIN IMMEDIATE")?;
    match f(c) {
        Ok(v) => {
            c.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = c.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

impl Machine {
    pub fn open(paths: Paths, sys: Box<dyn System>) -> R<Machine> {
        std::fs::create_dir_all(&paths.machine_dir).map_err(|e| MErr::new("STORE_UNAVAILABLE", format!("{e}")))?;
        let file = paths.machine_dir.join("machine.sqlite");
        let c = db::open(&file.to_string_lossy())?;
        set_mode(&file, 0o600);
        Ok(Machine { c, paths, sys, boot: boot_id() })
    }

    pub fn tx<T>(&self, f: impl FnOnce(&Connection) -> R<T>) -> R<T> {
        tx(&self.c, f)
    }

    pub fn audit(c: &Connection, actor: &str, kind: &str, scope: Option<&str>, outcome: &str, operation: Option<&str>) -> R<()> {
        c.execute(
            "INSERT INTO root_audit (operation_id, actor_id, kind, scope_id, outcome, timestamp) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![operation, actor, kind, scope, outcome, now_ms()],
        )?;
        Ok(())
    }

    // ---------------- install identity (§19.4) ----------------

    pub fn installed(&self) -> R<bool> {
        Ok(opt_i64(&self.c, "SELECT 1 FROM machine_meta WHERE id = 1", [])?.is_some())
    }

    /// First boot: one machine identity per firstBootId; a repeat with the same ID returns the same identity.
    pub fn ensure_install(&self, first_boot_id: &str) -> R<Value> {
        if !is_uuid(first_boot_id) {
            return Err(MErr::new("INVALID_REQUEST", "firstBootId must be a uuid"));
        }
        let secret = self.paths.machine_dir.join("machine.secret");
        self.tx(|c| {
            if let Some((mid, fb)) = c.query_row("SELECT machine_install_id, first_boot_id FROM machine_meta WHERE id = 1", [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? {
                if fb != first_boot_id {
                    return Err(MErr::new("CONFLICT", "machine already has an install identity from another first boot"));
                }
                return Ok(json!({ "machineInstallId": mid, "created": false }));
            }
            if !secret.exists() {
                write_private(&secret, &random_bytes::<32>())?;
            }
            let mid = uuid();
            c.execute(
                "INSERT INTO machine_meta (id, machine_install_id, first_boot_id, machine_control_epoch, registry_seq, schema_version, restore_state, first_boot_state, machine_secret_ref, created_at) VALUES (1, ?1, ?2, 1, 0, 2, 'idle', 'open', 'file:machine.secret#1', ?3)",
                params![mid, first_boot_id, now_ms()],
            )?;
            Self::audit(c, "root", "install.identity", Some(&mid), "created", None)?;
            Ok(json!({ "machineInstallId": mid, "created": true }))
        })
    }

    pub fn meta(&self) -> R<Value> {
        let m = self.c.query_row(
            "SELECT machine_install_id, machine_control_epoch, registry_seq, schema_version, current_release_id, known_good_release_id, restore_state, first_boot_state, accepted_release_sequence FROM machine_meta WHERE id = 1",
            [],
            |r| {
                Ok(json!({
                    "machineInstallId": r.get::<_, String>(0)?, "machineControlEpoch": r.get::<_, i64>(1)?, "registrySeq": r.get::<_, i64>(2)?,
                    "schemaVersion": r.get::<_, i64>(3)?, "currentReleaseId": r.get::<_, Option<String>>(4)?, "knownGoodReleaseId": r.get::<_, Option<String>>(5)?,
                    "restoreState": r.get::<_, String>(6)?, "firstBootState": r.get::<_, String>(7)?, "acceptedReleaseSequence": r.get::<_, i64>(8)?,
                }))
            },
        ).optional()?;
        let mut m = m.ok_or_else(|| MErr::new("MIGRATION_REQUIRED", "machine is not installed"))?;
        // Highest registry message the broker ever acknowledged: proof that a broker log existed (V1-R11).
        m["brokerAckedSeq"] = json!(opt_i64(&self.c, "SELECT COALESCE(MAX(ack_seq), 0) FROM registry_outbox WHERE target_kind = 'broker' AND state = 'acked'", [])?.unwrap_or(0));
        Ok(m)
    }

    pub fn control_epoch(&self) -> R<i64> {
        opt_i64(&self.c, "SELECT machine_control_epoch FROM machine_meta WHERE id = 1", [])?.ok_or_else(|| MErr::new("MIGRATION_REQUIRED", "machine is not installed"))
    }

    pub fn install_id(&self) -> R<String> {
        self.c.query_row("SELECT machine_install_id FROM machine_meta WHERE id = 1", [], |r| r.get(0)).optional()?.ok_or_else(|| MErr::new("MIGRATION_REQUIRED", "machine is not installed"))
    }

    pub fn close_first_boot(&self) -> R<()> {
        self.tx(|c| {
            let admins = opt_i64(c, "SELECT COUNT(*) FROM users WHERE role = 'admin' AND state = 'active'", [])?.unwrap_or(0);
            if admins < 1 {
                return Err(MErr::new("PLAN_STALE", "first boot needs an active administrator before it closes"));
            }
            c.execute("UPDATE machine_meta SET first_boot_state = 'closed' WHERE id = 1", [])?;
            Self::audit(c, "root", "install.first_boot_closed", None, "closed", None)
        })
    }

    pub fn first_boot_open(&self) -> R<bool> {
        Ok(self.c.query_row("SELECT first_boot_state FROM machine_meta WHERE id = 1", [], |r| r.get::<_, String>(0)).optional()?.as_deref() == Some("open"))
    }

    fn bump_registry(c: &Connection) -> R<i64> {
        c.execute("UPDATE machine_meta SET registry_seq = registry_seq + 1 WHERE id = 1", [])?;
        Ok(c.query_row("SELECT registry_seq FROM machine_meta WHERE id = 1", [], |r| r.get(0))?)
    }

    pub fn bump_control_epoch(c: &Connection) -> R<i64> {
        c.execute("UPDATE machine_meta SET machine_control_epoch = machine_control_epoch + 1 WHERE id = 1", [])?;
        Ok(c.query_row("SELECT machine_control_epoch FROM machine_meta WHERE id = 1", [], |r| r.get(0))?)
    }

    /// Queue one registry message per target in the same transaction as the directory change it reports.
    pub fn enqueue(c: &Connection, targets: &[(&str, &str)], kind: &str, body: &Value) -> R<i64> {
        let seq = Self::bump_registry(c)?;
        let text = canon(body);
        let h = sha256(text.as_bytes());
        for (tk, tid) in targets {
            c.execute(
                "INSERT INTO registry_outbox (registry_seq, target_kind, target_id, kind, body_json, body_hash, state) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
                params![seq, tk, tid, kind, text, h],
            )?;
        }
        Ok(seq)
    }

    pub fn pending_outbox(&self, target_kind: &str, target_id: &str, limit: i64) -> R<Vec<Value>> {
        let mut st = self.c.prepare("SELECT registry_seq, kind, body_json, body_hash FROM registry_outbox WHERE target_kind = ?1 AND target_id = ?2 AND state = 'pending' ORDER BY registry_seq LIMIT ?3")?;
        let rows = st.query_map(params![target_kind, target_id, limit], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })?;
        let mut out = vec![];
        for row in rows {
            let (seq, kind, body, h) = row?;
            let body: Value = serde_json::from_str(&body).map_err(|e| MErr::new("INTERNAL", e.to_string()))?;
            out.push(json!({ "registrySeq": seq, "kind": kind, "body": body, "bodyHash": h }));
        }
        self.c.execute("UPDATE registry_outbox SET attempt_count = attempt_count + 1 WHERE target_kind = ?1 AND target_id = ?2 AND state = 'pending'", params![target_kind, target_id])?;
        Ok(out)
    }

    /// Ordered ack: a target confirms every message up to and including `seq`. Revocation acks follow from it.
    pub fn ack_outbox(&self, target_kind: &str, target_id: &str, seq: i64) -> R<i64> {
        self.tx(|c| {
            let n = c.execute(
                "UPDATE registry_outbox SET state = 'acked', ack_seq = ?3 WHERE target_kind = ?1 AND target_id = ?2 AND state = 'pending' AND registry_seq <= ?3",
                params![target_kind, target_id, seq],
            )?;
            let col = match target_kind {
                "host" => "host_ack",
                "broker" => "broker_ack",
                _ => "gateway_ack",
            };
            let mut st = c.prepare("SELECT revocation_id, workspace_id FROM revocations WHERE state = 'revoking' AND registry_seq <= ?1")?;
            let revs: Vec<(String, Option<String>)> = st.query_map([seq], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            for (rid, ws) in revs {
                let applies = match target_kind {
                    "host" => ws.as_deref() == Some(target_id),
                    _ => true,
                };
                if !applies {
                    continue;
                }
                // Host ack counts only when every affected workspace's Host acked; with a ws-scoped revocation that is one.
                let still = opt_i64(c, "SELECT COUNT(*) FROM registry_outbox o JOIN revocations v ON v.revocation_id = ?1 WHERE o.target_kind = ?2 AND o.registry_seq = v.registry_seq AND o.state = 'pending'", params![rid, target_kind])?.unwrap_or(0);
                if still == 0 {
                    c.execute(&format!("UPDATE revocations SET {col} = 1 WHERE revocation_id = ?1"), [&rid])?;
                }
                Self::finish_revocation(c, &rid)?;
            }
            Ok(n as i64)
        })
    }

    fn finish_revocation(c: &Connection, rid: &str) -> R<()> {
        let done: Option<(i64, i64, i64, String, Option<String>, Option<String>, String)> = c
            .query_row(
                "SELECT gateway_ack, host_ack, broker_ack, scope_kind, workspace_id, user_id, state FROM revocations WHERE revocation_id = ?1",
                [rid],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?)),
            )
            .optional()?;
        if let Some((g, h, b, scope, ws, user, state)) = done {
            if state == "revoking" && g == 1 && h == 1 && b == 1 {
                c.execute("UPDATE revocations SET state = 'revoked', completed_at = ?2 WHERE revocation_id = ?1", params![rid, now_ms()])?;
                if scope == "member" {
                    c.execute("UPDATE workspace_members SET state = 'revoked', changed_at = ?3 WHERE workspace_id = ?1 AND user_id = ?2 AND state = 'revoking'", params![ws, user, now_ms()])?;
                } else if scope == "user" {
                    c.execute("UPDATE workspace_members SET state = 'revoked', changed_at = ?2 WHERE user_id = ?1 AND state = 'revoking'", params![user, now_ms()])?;
                }
                Self::audit(c, "root", "revocation.complete", Some(rid), "revoked", None)?;
            }
        }
        Ok(())
    }

    pub fn revocation(&self, rid: &str) -> R<Value> {
        self.c
            .query_row(
                "SELECT revocation_id, scope_kind, scope_id, old_version, new_version, gateway_ack, host_ack, broker_ack, state, registry_seq FROM revocations WHERE revocation_id = ?1",
                [rid],
                |r| {
                    Ok(json!({ "revocationId": r.get::<_, String>(0)?, "scopeKind": r.get::<_, String>(1)?, "scopeId": r.get::<_, String>(2)?,
                        "oldVersion": r.get::<_, i64>(3)?, "newVersion": r.get::<_, i64>(4)?, "gatewayAck": r.get::<_, i64>(5)? == 1,
                        "hostAck": r.get::<_, i64>(6)? == 1, "brokerAck": r.get::<_, i64>(7)? == 1, "state": r.get::<_, String>(8)?, "registrySeq": r.get::<_, i64>(9)? }))
                },
            )
            .optional()?
            .ok_or_else(MErr::hidden)
    }

    // ---------------- provisioning steps ----------------

    fn step_done(c: &Connection, pid: &str, step: &str) -> R<Option<Value>> {
        let r: Option<(String, Option<String>)> = c
            .query_row("SELECT state, receipt_json FROM provisioning_steps WHERE provisioning_id = ?1 AND step_id = ?2", params![pid, step], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?;
        Ok(match r {
            Some((s, rec)) if s == "done" => Some(rec.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null)),
            _ => None,
        })
    }

    fn step_intent(c: &Connection, pid: &str, step: &str, kind: &str, target: &str, intent: &Value) -> R<()> {
        let h = hash("agentos.machine.provisioning.v1", intent);
        let existing: Option<String> = c.query_row("SELECT intent_hash FROM provisioning_steps WHERE provisioning_id = ?1 AND step_id = ?2", params![pid, step], |r| r.get(0)).optional()?;
        match existing {
            Some(e) if e != h => Err(MErr::new("CONFLICT", "provisioning id reused with a different request")),
            Some(_) => Ok(()),
            None => {
                c.execute(
                    "INSERT INTO provisioning_steps (provisioning_id, step_id, kind, target_identity, intent_hash, state) VALUES (?1, ?2, ?3, ?4, ?5, 'intent')",
                    params![pid, step, kind, target, h],
                )?;
                Ok(())
            }
        }
    }

    fn step_finish(c: &Connection, pid: &str, step: &str, receipt: &Value) -> R<()> {
        c.execute("UPDATE provisioning_steps SET state = 'done', receipt_json = ?3 WHERE provisioning_id = ?1 AND step_id = ?2", params![pid, step, canon(receipt)])?;
        Ok(())
    }

    // ---------------- users (§7.2) ----------------

    pub fn provision_user(&mut self, provisioning_id: &str, login_name: &str, role: &str) -> R<Value> {
        if !is_uuid(provisioning_id) {
            return Err(MErr::new("INVALID_REQUEST", "provisioningId must be a uuid"));
        }
        if !valid_login(login_name) || !matches!(role, "admin" | "user") {
            return Err(MErr::new("INVALID_REQUEST", "login name must match ^[a-z][a-z0-9-]{0,31}$ and role admin|user"));
        }
        self.meta()?;
        let marker = format!("agentos-user {provisioning_id}");
        let intent = json!({ "loginName": login_name, "role": role });
        // allocate: pick the login UID and the userId in one transaction with the intent, so a retry reuses them.
        let (user_id, uid) = self.tx(|c| {
            Self::step_intent(c, provisioning_id, "allocate", "user", login_name, &intent)?;
            if let Some(rec) = Self::step_done(c, provisioning_id, "allocate")? {
                return Ok((rec["userId"].as_str().unwrap_or_default().to_string(), rec["loginUid"].as_u64().unwrap_or(0) as u32));
            }
            let n = opt_i64(c, "SELECT COUNT(*) FROM users WHERE state != 'disabled'", [])?.unwrap_or(0);
            if n >= MAX_USERS {
                return Err(MErr::new("MACHINE_CAPACITY", "the machine already has the maximum number of local accounts"));
            }
            if opt_i64(c, "SELECT 1 FROM users WHERE login_name = ?1", [login_name])?.is_some() {
                return Err(MErr::new("CONFLICT", "login name is already registered (tombstones are not reused)"));
            }
            let mut uid = LOGIN_UID_START;
            loop {
                let used = opt_i64(c, "SELECT 1 FROM users WHERE login_uid = ?1", [uid])?.is_some();
                let taken = self.sys.pw_by_uid(uid).map(|e| e.gecos != marker).unwrap_or(false);
                if !used && !taken {
                    break;
                }
                uid += 1;
                if uid > LOGIN_UID_END {
                    return Err(MErr::new("MACHINE_CAPACITY", "login UID pool exhausted"));
                }
            }
            let user_id = uuid();
            c.execute(
                "INSERT INTO users (user_id, login_uid, login_name, role, state, auth_version, provisioning_id, created_at) VALUES (?1, ?2, ?3, ?4, 'provisioning', 1, ?5, ?6)",
                params![user_id, uid, login_name, role, provisioning_id, now_ms()],
            )?;
            Self::step_finish(c, provisioning_id, "allocate", &json!({ "userId": user_id, "loginUid": uid }))?;
            Ok((user_id, uid))
        })?;
        // account: create the Linux account, or adopt it only if it carries this provisioning marker.
        let account_done = Self::step_done(&self.c, provisioning_id, "account")?.is_some();
        if !account_done {
            self.tx(|c| Self::step_intent(c, provisioning_id, "account", "user", login_name, &intent))?;
            match self.sys.pw_by_name(login_name) {
                Some(e) if e.gecos == marker && e.uid == uid => {}
                Some(_) => {
                    return Err(MErr::new("CONFLICT", "a Linux account with this name already exists and is not ours; it is never taken over"));
                }
                None => self.sys.create_login_user(login_name, uid, &marker, role == "admin")?,
            }
            self.tx(|c| Self::step_finish(c, provisioning_id, "account", &json!({ "loginUid": uid })))?;
        }
        self.tx(|c| {
            Self::step_intent(c, provisioning_id, "registry", "user", login_name, &intent)?;
            if Self::step_done(c, provisioning_id, "registry")?.is_none() {
                c.execute("UPDATE users SET state = 'active' WHERE user_id = ?1 AND state = 'provisioning'", [&user_id])?;
                Self::enqueue(c, &[("gateway", "*")], "user.active", &json!({ "userId": user_id, "loginUid": uid }))?;
                Self::step_finish(c, provisioning_id, "registry", &json!({ "userId": user_id }))?;
                Self::audit(c, "root", "user.provision", Some(&user_id), "active", None)?;
            }
            Ok(())
        })?;
        self.user(&user_id)
    }

    pub fn set_password(&mut self, user_id: &str, password: &[u8]) -> R<()> {
        let u = self.user(user_id)?;
        if u["state"] != "active" {
            return Err(MErr::new("MEMBERSHIP_REVOKED", "account is not active"));
        }
        let name = u["loginName"].as_str().unwrap_or_default().to_string();
        self.sys.set_password(&name, password)?;
        self.tx(|c| {
            c.execute("UPDATE users SET auth_version = auth_version + 1 WHERE user_id = ?1", [user_id])?;
            Self::audit(c, "root", "user.password", Some(user_id), "set", None)
        })
    }

    pub fn user(&self, user_id: &str) -> R<Value> {
        self.c
            .query_row("SELECT user_id, login_uid, login_name, role, state, auth_version FROM users WHERE user_id = ?1", [user_id], user_json)
            .optional()?
            .ok_or_else(MErr::hidden)
    }

    pub fn user_by_uid(&self, uid: u32) -> R<Option<Value>> {
        Ok(self.c.query_row("SELECT user_id, login_uid, login_name, role, state, auth_version FROM users WHERE login_uid = ?1", [uid], user_json).optional()?)
    }

    pub fn users(&self) -> R<Vec<Value>> {
        let mut st = self.c.prepare("SELECT user_id, login_uid, login_name, role, state, auth_version FROM users ORDER BY created_at")?;
        let v = st.query_map([], user_json)?.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }

    /// Disable keeps the identity tombstone; it closes sessions, memberships and future rights (spec §7.2, V1-I09).
    pub fn disable_user(&mut self, user_id: &str, revocation_id: &str) -> R<Value> {
        let u = self.user(user_id)?;
        if u["state"] == "disabled" {
            return self.revocation_for_user(user_id);
        }
        let owned = opt_i64(&self.c, "SELECT COUNT(*) FROM workspace_members m JOIN workspaces w USING (workspace_id) WHERE m.user_id = ?1 AND m.role = 'owner' AND m.state = 'active' AND w.state NOT IN ('archived','deleting','deleted')", [user_id])?.unwrap_or(0);
        if owned > 0 {
            return Err(MErr::new("CONFLICT", "transfer ownership of this user's workspaces before disabling the account"));
        }
        let name = u["loginName"].as_str().unwrap_or_default().to_string();
        let uid = u["loginUid"].as_u64().unwrap_or(0) as u32;
        let out = self.tx(|c| {
            let av: i64 = c.query_row("SELECT auth_version FROM users WHERE user_id = ?1", [user_id], |r| r.get(0))?;
            c.execute("UPDATE users SET state = 'disabled', disabled_at = ?2, auth_version = auth_version + 1 WHERE user_id = ?1", params![user_id, now_ms()])?;
            let mut targets: Vec<(String, String)> = vec![("gateway".into(), "*".into()), ("broker".into(), "*".into())];
            let mut st = c.prepare("SELECT workspace_id FROM workspace_members WHERE user_id = ?1 AND state = 'active'")?;
            let wss: Vec<String> = st.query_map([user_id], |r| r.get(0))?.collect::<Result<_, _>>()?;
            for ws in &wss {
                c.execute("UPDATE workspace_members SET state = 'revoking', member_version = member_version + 1, changed_at = ?3 WHERE workspace_id = ?1 AND user_id = ?2", params![ws, user_id, now_ms()])?;
                c.execute("UPDATE machine_permits SET state = 'revoked', usage_status = 'unused' WHERE workspace_id = ?1 AND user_id = ?2 AND state IN ('queued','reserved')", params![ws, user_id])?;
                targets.push(("host".into(), ws.clone()));
            }
            let t: Vec<(&str, &str)> = targets.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            let body = json!({ "revocationId": revocation_id, "scopeKind": "user", "userId": user_id, "workspaces": wss, "authVersion": av + 1 });
            let seq = Self::enqueue(c, &t, "user.disabled", &body)?;
            let host_ack = if wss.is_empty() { 1 } else { 0 };
            c.execute(
                "INSERT INTO revocations (revocation_id, scope_kind, scope_id, user_id, old_version, new_version, registry_seq, reason, host_ack, state, created_at) VALUES (?1, 'user', ?2, ?2, ?3, ?4, ?5, 'account_disabled', ?6, 'revoking', ?7)",
                params![revocation_id, user_id, av, av + 1, seq, host_ack, now_ms()],
            )?;
            Self::audit(c, "root", "user.disable", Some(user_id), "revoking", None)?;
            Ok(())
        });
        out?;
        self.sys.lock_user(&name)?;
        self.sys.terminate_user(uid)?;
        self.revocation(revocation_id)
    }

    fn revocation_for_user(&self, user_id: &str) -> R<Value> {
        let rid: Option<String> = self.c.query_row("SELECT revocation_id FROM revocations WHERE scope_kind = 'user' AND scope_id = ?1 ORDER BY created_at DESC LIMIT 1", [user_id], |r| r.get(0)).optional()?;
        rid.map(|r| self.revocation(&r)).unwrap_or_else(|| Err(MErr::hidden()))
    }

    // ---------------- workspaces (§8) ----------------

    pub fn create_workspace(&mut self, create_id: &str, owner_user_id: &str, display_name: &str, store_uuid: Option<&str>, origin: &str) -> R<Value> {
        if !is_uuid(create_id) {
            return Err(MErr::new("INVALID_REQUEST", "createId must be a uuid"));
        }
        if display_name.is_empty() || display_name.chars().count() > 80 || display_name.chars().any(|c| c.is_control()) {
            return Err(MErr::new("INVALID_REQUEST", "display name must be 1–80 printable characters"));
        }
        let owner = self.user(owner_user_id)?;
        if owner["state"] != "active" {
            return Err(MErr::hidden());
        }
        self.require_no_barrier()?;
        if Self::step_done(&self.c, create_id, "allocate")?.is_none() {
            self.storage_guard()?;
        }
        let intent = json!({ "ownerUserId": owner_user_id, "displayName": display_name, "storeUUID": store_uuid, "origin": origin });
        let ws = self.tx(|c| {
            Self::step_intent(c, create_id, "allocate", "workspace", owner_user_id, &intent)?;
            if let Some(rec) = Self::step_done(c, create_id, "allocate")? {
                return Ok(rec["workspaceId"].as_str().unwrap_or_default().to_string());
            }
            let n = opt_i64(c, "SELECT COUNT(*) FROM workspaces WHERE state != 'deleted'", [])?.unwrap_or(0);
            if n >= MAX_WORKSPACES {
                return Err(MErr::new("MACHINE_CAPACITY", "the machine already has the maximum number of registered workspaces"));
            }
            let store = store_uuid.map(|s| s.to_string()).unwrap_or_else(uuid);
            if opt_i64(c, "SELECT 1 FROM workspaces WHERE store_uuid = ?1", [&store])?.is_some() {
                return Err(MErr::new("STORE_ALREADY_REGISTERED", "this store is already registered on the machine"));
            }
            // Execution UID and sub-ID range: lowest free slot that no tombstone, Linux account or subuid line uses.
            let mut slot = 0u32;
            let (uid, sub) = loop {
                let uid = EXEC_UID_START + slot;
                let sub = SUBID_START + slot * SUBID_RANGE;
                if uid > EXEC_UID_END {
                    return Err(MErr::new("MACHINE_CAPACITY", "execution UID pool exhausted"));
                }
                let used = opt_i64(c, "SELECT 1 FROM workspaces WHERE execution_uid = ?1 OR subuid_start = ?2", params![uid, sub])?.is_some();
                if !used && self.sys.pw_by_uid(uid).is_none() && !self.sys.subid_overlaps(sub, SUBID_RANGE) {
                    break (uid, sub);
                }
                slot += 1;
            };
            let ws = uuid();
            c.execute(
                "INSERT INTO workspaces (workspace_id, create_id, store_uuid, display_name, owner_user_id, execution_uid, exec_login, subuid_start, subgid_start, range_size, state, instance_epoch, workspace_incarnation, data_path_id, origin, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?9, 'creating', 1, 1, ?10, ?11, ?12)",
                params![ws, create_id, store, display_name, owner_user_id, uid, format!("aows{}", uid - EXEC_UID_START), sub, SUBID_RANGE, format!("data:{ws}:1"), origin, now_ms()],
            )?;
            Self::step_finish(c, create_id, "allocate", &json!({ "workspaceId": ws, "executionUid": uid, "subuidStart": sub }))?;
            Ok(ws)
        })?;
        self.continue_workspace_create(create_id, &ws)
    }

    /// Resume the fixed step catalogue of one workspace creation; called again after a crash with the same createId.
    pub fn continue_workspace_create(&mut self, create_id: &str, ws: &str) -> R<Value> {
        let row = self.ws_row(ws)?;
        let uid = row["executionUid"].as_u64().unwrap_or(0) as u32;
        let login = row["execLogin"].as_str().unwrap_or_default().to_string();
        let store = row["storeUUID"].as_str().unwrap_or_default().to_string();
        let sub = row["subuidStart"].as_u64().unwrap_or(0) as u32;
        let marker = format!("agentos-ws {create_id}");
        let home = self.paths.ws_root(ws);
        let intent = json!({ "workspaceId": ws, "executionUid": uid });
        for step in &WORKSPACE_STEPS[1..] {
            if Self::step_done(&self.c, create_id, step)?.is_some() {
                continue;
            }
            self.tx(|c| Self::step_intent(c, create_id, step, "workspace", ws, &intent))?;
            let receipt = match *step {
                "account" => {
                    match self.sys.pw_by_name(&login) {
                        Some(e) if e.gecos == marker && e.uid == uid => {}
                        Some(_) => return Err(MErr::new("CONFLICT", "an account with the execution name exists and is not ours")),
                        None => {
                            if self.sys.pw_by_uid(uid).is_some() {
                                return Err(MErr::new("CONFLICT", "the allocated execution UID is now used by another account"));
                            }
                        }
                    }
                    self.sys.create_exec_user(&login, uid, &marker, &home, sub, SUBID_RANGE)?;
                    json!({ "executionUid": uid, "login": login, "subuidStart": sub })
                }
                "directory" => {
                    self.sys.ensure_workspace_dirs(&self.paths, ws, uid)?;
                    json!({ "dataPathId": format!("data:{ws}:1") })
                }
                "databases" => {
                    self.sys.init_workspace(&self.paths, ws, &store, uid, &login)?;
                    json!({ "schema": 5 })
                }
                "broker" => {
                    self.tx(|c| {
                        let mid: String = c.query_row("SELECT machine_install_id FROM machine_meta WHERE id = 1", [], |r| r.get(0))?;
                        Self::enqueue(c, &[("broker", "*")], "workspace.registered", &json!({ "machineInstallId": mid, "workspaceId": ws, "storeUUID": store, "executionUid": uid, "workspaceIncarnation": 1, "minWriteProtocol": 3 }))
                    })?;
                    json!({ "queued": true })
                }
                "linger" => {
                    self.sys.enable_linger(&login)?;
                    json!({ "linger": true })
                }
                "registry" => {
                    self.tx(|c| {
                        let owner: String = c.query_row("SELECT owner_user_id FROM workspaces WHERE workspace_id = ?1", [ws], |r| r.get(0))?;
                        if opt_i64(c, "SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2", params![ws, owner])?.is_none() {
                            c.execute("INSERT INTO workspace_members (workspace_id, user_id, role, member_version, state, changed_at) VALUES (?1, ?2, 'owner', 1, 'active', ?3)", params![ws, owner, now_ms()])?;
                        }
                        c.execute("UPDATE workspaces SET state = 'stopped' WHERE workspace_id = ?1 AND state = 'creating'", [ws])?;
                        Self::enqueue(c, &[("gateway", "*"), ("host", ws)], "members.snapshot", &Self::member_snapshot(c, ws)?)?;
                        Self::audit(c, "root", "workspace.create", Some(ws), "stopped", None)
                    })?;
                    json!({ "state": "stopped" })
                }
                _ => unreachable!(),
            };
            crate::util::test_fault(&format!("create.{step}"));
            self.tx(|c| Self::step_finish(c, create_id, step, &receipt))?;
        }
        self.ws_row(ws)
    }

    /// Restart reconciliation: every creation left in `creating` resumes from its last receipt (spec §26 row 1, V1-W03).
    pub fn resume_creations(&mut self) -> R<Vec<String>> {
        let mut st = self.c.prepare("SELECT create_id, workspace_id FROM workspaces WHERE state = 'creating'")?;
        let rows: Vec<(String, String)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        drop(st);
        let mut done = vec![];
        for (cid, ws) in rows {
            if self.continue_workspace_create(&cid, &ws).is_ok() {
                done.push(ws);
            }
        }
        Ok(done)
    }

    /// Root view of every workspace (backup/restore orchestration only; never reaches a session).
    pub fn all_workspaces(&self) -> R<Vec<Value>> {
        let ids: Vec<String> = {
            let mut st = self.c.prepare("SELECT workspace_id FROM workspaces ORDER BY workspace_id")?;
            let v = st.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<Vec<_>, _>>()?;
            v
        };
        ids.iter().map(|w| self.ws_row(w)).collect()
    }

    pub fn ws_row(&self, ws: &str) -> R<Value> {
        self.c
            .query_row(
                "SELECT workspace_id, store_uuid, display_name, owner_user_id, execution_uid, exec_login, subuid_start, range_size, state, instance_epoch, workspace_incarnation, run_when_logged_out, origin, create_id FROM workspaces WHERE workspace_id = ?1",
                [ws],
                |r| {
                    Ok(json!({ "workspaceId": r.get::<_, String>(0)?, "storeUUID": r.get::<_, String>(1)?, "displayName": r.get::<_, String>(2)?,
                        "ownerUserId": r.get::<_, String>(3)?, "executionUid": r.get::<_, i64>(4)?, "execLogin": r.get::<_, String>(5)?,
                        "subuidStart": r.get::<_, i64>(6)?, "rangeSize": r.get::<_, i64>(7)?, "state": r.get::<_, String>(8)?,
                        "instanceEpoch": r.get::<_, i64>(9)?, "workspaceIncarnation": r.get::<_, i64>(10)?, "runWhenLoggedOut": r.get::<_, i64>(11)? == 1,
                        "origin": r.get::<_, String>(12)?, "createId": r.get::<_, String>(13)? }))
                },
            )
            .optional()?
            .ok_or_else(MErr::hidden)
    }

    pub fn ws_by_exec_uid(&self, uid: u32) -> R<Option<String>> {
        Ok(self.c.query_row("SELECT workspace_id FROM workspaces WHERE execution_uid = ?1 AND state NOT IN ('archived','deleting','deleted')", [uid], |r| r.get(0)).optional()?)
    }

    /// Membership of an active user in a workspace, or the uniform hidden error (spec §16.1, V1-I03).
    pub fn membership(&self, user_id: &str, ws: &str) -> R<(Role, i64)> {
        let r: Option<(String, i64, String)> = self
            .c
            .query_row(
                "SELECT m.role, m.member_version, m.state FROM workspace_members m JOIN users u ON u.user_id = m.user_id JOIN workspaces w ON w.workspace_id = m.workspace_id WHERE m.workspace_id = ?1 AND m.user_id = ?2 AND u.state = 'active' AND w.state != 'deleted'",
                params![ws, user_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        match r {
            Some((role, v, state)) if state == "active" => Ok((Role::parse(&role)?, v)),
            Some((_, _, state)) if state == "revoking" => Err(MErr::new("MEMBERSHIP_REVOKED", "membership is being revoked")),
            _ => Err(MErr::hidden()),
        }
    }

    pub fn list_visible(&self, user_id: &str) -> R<Vec<Value>> {
        let mut st = self.c.prepare(
            "SELECT w.workspace_id, w.display_name, w.state, m.role, m.member_version, w.store_uuid FROM workspaces w JOIN workspace_members m ON m.workspace_id = w.workspace_id JOIN users u ON u.user_id = m.user_id WHERE m.user_id = ?1 AND m.state = 'active' AND u.state = 'active' AND w.state NOT IN ('creating','deleted') ORDER BY w.created_at",
        )?;
        let v = st
            .query_map([user_id], |r| {
                Ok(json!({ "workspaceId": r.get::<_, String>(0)?, "displayName": r.get::<_, String>(1)?, "state": r.get::<_, String>(2)?,
                    "role": r.get::<_, String>(3)?, "memberVersion": r.get::<_, i64>(4)?, "storeUUID": r.get::<_, String>(5)? }))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }

    fn set_ws_state(c: &Connection, ws: &str, from: &[&str], to: &str) -> R<()> {
        let cur: String = c.query_row("SELECT state FROM workspaces WHERE workspace_id = ?1", [ws], |r| r.get(0)).optional()?.ok_or_else(MErr::hidden)?;
        if !from.contains(&cur.as_str()) {
            return Err(MErr::new("CONFLICT", format!("workspace is {cur}")));
        }
        c.execute("UPDATE workspaces SET state = ?2 WHERE workspace_id = ?1", params![ws, to])?;
        Ok(())
    }

    pub fn start_workspace(&mut self, ws: &str) -> R<Value> {
        // A held machine barrier freezes every participant (spec §24, V1-R02): no workspace may start under it.
        self.require_no_barrier()?;
        let row = self.ws_row(ws)?;
        let state = row["state"].as_str().unwrap_or_default();
        if state == "running" || state == "starting" {
            return Ok(row);
        }
        let uid = row["executionUid"].as_u64().unwrap_or(0) as u32;
        self.tx(|c| {
            let running = opt_i64(c, "SELECT COUNT(*) FROM workspaces WHERE state IN ('starting','running','quiescing')", [])?.unwrap_or(0);
            if running >= MAX_RUNNING {
                return Err(MErr::new("MACHINE_CAPACITY", "two workspaces are already running; stop one first"));
            }
            // A Host process of this UID still alive means a second writer; refuse rather than start another (V1-B05).
            Self::set_ws_state(c, ws, &["stopped", "recovery_required"], "starting")?;
            c.execute("UPDATE workspaces SET instance_epoch = instance_epoch + 1 WHERE workspace_id = ?1", [ws])?;
            Self::audit(c, "root", "workspace.start", Some(ws), "starting", None)
        })?;
        if self.sys.exec_cgroup_busy(uid) {
            // The old instance is still alive: keep it fenced until it is proven gone.
            self.tx(|c| Self::set_ws_state(c, ws, &["starting"], "recovery_required"))?;
            return Err(MErr::new("WORKSPACE_FENCED", "a previous execution of this workspace is still running"));
        }
        if let Err(e) = self.sys.start_workspace(ws, uid) {
            self.tx(|c| Self::set_ws_state(c, ws, &["starting"], "stopped"))?;
            return Err(e);
        }
        self.ws_row(ws)
    }

    pub fn stop_workspace(&mut self, ws: &str) -> R<Value> {
        let row = self.ws_row(ws)?;
        let uid = row["executionUid"].as_u64().unwrap_or(0) as u32;
        let st = row["state"].as_str().unwrap_or_default().to_string();
        if st == "stopped" || st == "archived" {
            return Ok(row);
        }
        self.tx(|c| {
            if st == "running" || st == "starting" {
                Self::set_ws_state(c, ws, &["running", "starting"], "quiescing")?;
                Self::enqueue(c, &[("host", ws)], "workspace.quiesce", &json!({ "workspaceId": ws }))?;
            }
            Ok(())
        })?;
        self.sys.stop_workspace(ws, uid)?;
        // Stopped means the execution identity has no process left (spec §8.2): check the real process table.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while self.sys.exec_cgroup_busy(uid) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(200));
        }
        let busy = self.sys.exec_cgroup_busy(uid);
        self.tx(|c| {
            c.execute("UPDATE workspace_instances SET state = 'stopped' WHERE workspace_id = ?1 AND state IN ('starting','running','stopping')", [ws])?;
            if busy {
                Self::set_ws_state(c, ws, &["quiescing", "starting", "running"], "recovery_required")?;
            } else {
                Self::set_ws_state(c, ws, &["quiescing", "starting", "running", "recovery_required"], "stopped")?;
            }
            Self::audit(c, "root", "workspace.stop", Some(ws), if busy { "fenced" } else { "stopped" }, None)
        })?;
        if busy {
            return Err(MErr::new("WORKSPACE_FENCED", "execution processes did not exit; the workspace stays fenced"));
        }
        self.ws_row(ws)
    }

    pub fn archive_workspace(&mut self, actor: &str, ws: &str) -> R<Value> {
        let (role, _) = self.membership(actor, ws)?;
        if role != Role::Owner {
            return Err(MErr::hidden());
        }
        self.stop_workspace(ws)?;
        let login = self.ws_row(ws)?["execLogin"].as_str().unwrap_or_default().to_string();
        self.tx(|c| {
            Self::set_ws_state(c, ws, &["stopped"], "archived")?;
            Self::enqueue(c, &[("gateway", "*"), ("broker", "*")], "workspace.archived", &json!({ "workspaceId": ws }))?;
            Self::audit(c, actor, "workspace.archive", Some(ws), "archived", None)
        })?;
        let _ = self.sys.disable_linger(&login);
        self.ws_row(ws)
    }

    pub fn unarchive_workspace(&mut self, actor: &str, ws: &str) -> R<Value> {
        let row = self.ws_row(ws)?;
        let ok = self.c.query_row("SELECT 1 FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2 AND role = 'owner' AND state = 'active'", params![ws, actor], |_| Ok(())).optional()?.is_some();
        if !ok {
            return Err(MErr::hidden());
        }
        let login = row["execLogin"].as_str().unwrap_or_default().to_string();
        self.tx(|c| {
            Self::set_ws_state(c, ws, &["archived"], "stopped")?;
            Self::enqueue(c, &[("gateway", "*")], "workspace.state_changed", &json!({ "workspaceId": ws, "state": "stopped" }))?;
            Self::audit(c, actor, "workspace.unarchive", Some(ws), "stopped", None)
        })?;
        self.sys.enable_linger(&login)?;
        self.ws_row(ws)
    }

    // ---------------- deletion and tombstones (spec §8.2, V1-W10) ----------------

    /// Local preconditions of a full deletion. Returns the reason it must not proceed, or None.
    pub fn delete_blocker(&self, ws: &str) -> R<Option<Value>> {
        let row = self.ws_row(ws)?;
        if db::live_schema(&self.c) < 2 {
            return Ok(Some(json!({ "code": "CONFLICT", "reason": "the machine schema upgrade that records deletions completes when the open update is committed" })));
        }
        let state = row["state"].as_str().unwrap_or_default();
        if state != "archived" {
            return Ok(Some(json!({ "code": "CONFLICT", "reason": format!("workspace is {state}; archive it first") })));
        }
        let live = opt_i64(&self.c, "SELECT COUNT(*) FROM workspace_instances WHERE workspace_id = ?1 AND state IN ('starting','running','stopping')", [ws])?.unwrap_or(0);
        let uid = row["executionUid"].as_u64().unwrap_or(0) as u32;
        if live > 0 || self.sys.exec_cgroup_busy(uid) {
            return Ok(Some(json!({ "code": "WORKSPACE_FENCED", "reason": "an execution instance or process of this workspace is still alive" })));
        }
        // Snapshot references: a pinned local recovery set whose barrier covered this workspace (a set taken with
        // no explicit list covered every workspace then registered, so it counts too).
        let mut st = self.c.prepare("SELECT s.set_id, b.scope_json FROM checkpoint_sets s LEFT JOIN barriers b ON b.barrier_id = s.barrier_id WHERE s.pinned = 1 AND s.state = 'complete'")?;
        let pins: Vec<(String, Option<String>)> = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
        drop(st);
        for (set, scope) in pins {
            let covers = match scope.and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.get("workspaces").cloned()) {
                Some(Value::Array(a)) => a.iter().any(|x| x.as_str() == Some(ws)),
                _ => true,
            };
            if covers {
                return Ok(Some(json!({ "code": "CONFLICT", "reason": "a pinned local recovery set still references this workspace", "setId": set })));
            }
        }
        // The broker must have applied every registry message about this workspace before it can judge its effects.
        let unsynced = opt_i64(&self.c, "SELECT COUNT(*) FROM registry_outbox WHERE target_kind = 'broker' AND state = 'pending'", [])?.unwrap_or(0);
        if unsynced > 0 {
            return Ok(Some(json!({ "code": "STORE_UNAVAILABLE", "reason": "the broker has not caught up with the machine directory" })));
        }
        Ok(None)
    }

    /// Owner consent for a deletion (non-admin machine action by the active owner).
    pub fn delete_consent_check(&self, actor: &str, ws: &str) -> R<()> {
        let (role, _) = self.membership(actor, ws)?;
        if role != Role::Owner {
            return Err(MErr::hidden());
        }
        Ok(())
    }

    /// Owner consent is either the administrator being the active owner, or a succeeded `workspaces.deleteConsent`
    /// operation of the current active owner for this workspace and data disposition.
    pub fn owner_consented(&self, admin: &str, ws: &str, disposition: &str, consent_op: Option<&str>) -> R<bool> {
        let owner: Option<String> = self.c.query_row("SELECT user_id FROM workspace_members WHERE workspace_id = ?1 AND role = 'owner' AND state = 'active'", [ws], |r| r.get(0)).optional()?;
        let owner = match owner {
            Some(o) => o,
            None => return Ok(false),
        };
        if owner == admin {
            return Ok(true);
        }
        let op = match consent_op {
            Some(o) => o,
            None => return Ok(false),
        };
        let r: Option<(String, String, String, String)> = self
            .c
            .query_row("SELECT principal_user_id, kind, state, params_json FROM machine_operations WHERE operation_id = ?1", [op], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()?;
        Ok(match r {
            Some((who, kind, state, params)) => {
                let p: Value = serde_json::from_str(&params).unwrap_or(Value::Null);
                who == owner && kind == "workspaces.deleteConsent" && state == "succeeded" && p["workspaceId"] == ws && p["dataDisposition"] == disposition
            }
            None => false,
        })
    }

    /// Phase 1 (dispatch of the admin action): verify, then enter `deleting` and ask the broker for its verdict on
    /// unknown effects. Nothing is removed yet. Idempotent for the same deleteId.
    pub fn begin_delete(&mut self, actor: &str, ws: &str, delete_id: &str, disposition: &str, export_set: Option<&str>, consent_op: Option<&str>) -> R<Value> {
        let row = self.ws_row(ws)?;
        if row["state"] == "deleting" || row["state"] == "deleted" {
            let cur: Option<String> = self.c.query_row("SELECT delete_json FROM workspaces WHERE workspace_id = ?1", [ws], |r| r.get(0))?;
            let same = cur.and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| v["deleteId"] == delete_id).unwrap_or(false);
            return if same { self.ws_row(ws) } else { Err(MErr::new("CONFLICT", "another deletion of this workspace is recorded")) };
        }
        if !matches!(disposition, "exported" | "discard") {
            return Err(MErr::new("INVALID_REQUEST", "dataDisposition must be exported or discard"));
        }
        if !self.owner_consented(actor, ws, disposition, consent_op)? {
            return Err(MErr::new("CONFLICT", "the workspace owner has not confirmed this deletion and data disposition"));
        }
        if disposition == "exported" {
            let set = export_set.ok_or_else(|| MErr::new("INVALID_REQUEST", "exportSetId is required for an exported deletion"))?;
            let ok: Option<(String, String)> = self.c.query_row("SELECT state, export_state FROM checkpoint_sets WHERE set_id = ?1", [set], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            match ok {
                Some((st, ex)) if st == "complete" && (ex == "exported" || ex == "verified") => {}
                _ => return Err(MErr::new("CONFLICT", "the export set is not a complete, exported recovery set")),
            }
        }
        if let Some(b) = self.delete_blocker(ws)? {
            return Err(blocker_err(&b));
        }
        let store = row["storeUUID"].as_str().unwrap_or_default().to_string();
        let body = json!({ "deleteId": delete_id, "dataDisposition": disposition, "exportSetId": export_set, "requestedBy": actor, "requestedAt": now_ms() });
        self.tx(|c| {
            Self::set_ws_state(c, ws, &["archived"], "deleting")?;
            c.execute("UPDATE workspaces SET delete_json = ?2 WHERE workspace_id = ?1", params![ws, canon(&body)])?;
            Self::enqueue(c, &[("broker", "*")], "workspace.deleting", &json!({ "workspaceId": ws, "storeUUID": store, "deleteId": delete_id }))?;
            Self::enqueue(c, &[("gateway", "*")], "workspace.state_changed", &json!({ "workspaceId": ws, "state": "deleting" }))?;
            Self::audit(c, actor, "workspace.delete", Some(ws), "deleting", None)
        })?;
        self.ws_row(ws)
    }

    /// Phase 2: the broker's verdict. Unknown/in-flight effects or quarantines block (back to archived, reason
    /// recorded); otherwise the registered roots are removed, the execution account is locked and kept (its UID is
    /// never reused) and the row stays as an identity tombstone (`deleted`, UID and storeUUID still UNIQUE).
    pub fn delete_verdict(&mut self, ws: &str, delete_id: &str, unresolved: i64, detail: &Value) -> R<Value> {
        let row = self.ws_row(ws)?;
        let cur: Option<String> = self.c.query_row("SELECT delete_json FROM workspaces WHERE workspace_id = ?1", [ws], |r| r.get(0))?;
        let mut body = cur.and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(Value::Null);
        if row["state"] != "deleting" || body["deleteId"] != delete_id {
            return Ok(row); // stale or repeated verdict: no effect
        }
        let uid = row["executionUid"].as_u64().unwrap_or(0) as u32;
        let login = row["execLogin"].as_str().unwrap_or_default().to_string();
        let live = self.sys.exec_cgroup_busy(uid);
        if unresolved > 0 || live {
            body["blocked"] = json!({ "unresolvedEffects": unresolved, "executionAlive": live, "detail": detail, "at": now_ms() });
            self.tx(|c| {
                Self::set_ws_state(c, ws, &["deleting"], "archived")?;
                c.execute("UPDATE workspaces SET delete_json = ?2 WHERE workspace_id = ?1", params![ws, canon(&body)])?;
                Self::enqueue(c, &[("broker", "*"), ("gateway", "*")], "workspace.archived", &json!({ "workspaceId": ws }))?;
                Self::audit(c, "root", "workspace.delete", Some(ws), "blocked", None)
            })?;
            return Err(MErr::new("CONFLICT", if live { "an execution process appeared; deletion refused".to_string() } else { format!("{unresolved} external effect(s) of this workspace are not reconciled") }));
        }
        let _ = self.sys.disable_linger(&login);
        self.sys.lock_user(&login)?;
        self.sys.remove_workspace_roots(&self.paths, ws)?;
        body["removedAt"] = json!(now_ms());
        self.tx(|c| {
            Self::set_ws_state(c, ws, &["deleting"], "deleted")?;
            c.execute("UPDATE workspaces SET delete_json = ?2, deleted_at = ?3, run_when_logged_out = 0 WHERE workspace_id = ?1", params![ws, canon(&body), now_ms()])?;
            c.execute("UPDATE workspace_members SET state = 'revoked', changed_at = ?2 WHERE workspace_id = ?1 AND state != 'revoked'", params![ws, now_ms()])?;
            Self::enqueue(c, &[("broker", "*"), ("gateway", "*")], "workspace.deleted", &json!({ "workspaceId": ws }))?;
            Self::audit(c, "root", "workspace.delete", Some(ws), "deleted", None)
        })?;
        self.ws_row(ws)
    }

    /// New boot (power cut, crash, reboot without a clean stop): a workspace the registry still calls running/starting/
    /// quiescing has no live Host on THIS boot. Its instances from earlier boots are `lost` and the workspace is
    /// `stopped`, so the next attach/start really starts a Host instead of waiting for one that cannot come (O06).
    /// Instances of the current boot (machined itself was restarted) are left alone.
    pub fn reconcile_boot(&mut self) -> R<usize> {
        let boot = self.boot.clone();
        self.tx(|c| {
            let wss: Vec<String> = {
                let mut st = c.prepare(
                    "SELECT w.workspace_id FROM workspaces w WHERE w.state IN ('starting','running','quiescing') AND NOT EXISTS (SELECT 1 FROM workspace_instances i WHERE i.workspace_id = w.workspace_id AND i.boot_id = ?1 AND i.state IN ('starting','running','stopping'))",
                )?;
                let v = st.query_map([&boot], |r| r.get(0))?.collect::<Result<_, _>>()?;
                v
            };
            for w in &wss {
                c.execute("UPDATE workspace_instances SET state = 'lost' WHERE workspace_id = ?1 AND boot_id != ?2 AND state IN ('starting','running','stopping')", params![w, boot])?;
                c.execute("UPDATE workspaces SET state = 'stopped' WHERE workspace_id = ?1", [w])?;
                Self::audit(c, "machine", "workspace.boot_reconcile", Some(w), "stopped", None)?;
            }
            Ok(wss.len())
        })
    }

    /// Restart: a deletion still `deleting` asks the broker again (its verdict may have been lost in a crash).
    pub fn resume_deletions(&mut self) -> R<usize> {
        let rows: Vec<(String, String, Option<String>)> = {
            let mut st = self.c.prepare("SELECT workspace_id, store_uuid, delete_json FROM workspaces WHERE state = 'deleting'")?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<_, _>>()?;
            v
        };
        for (ws, store, body) in &rows {
            let id = body.as_deref().and_then(|t| serde_json::from_str::<Value>(t).ok()).map(|v| v["deleteId"].clone()).unwrap_or(Value::Null);
            self.tx(|c| Self::enqueue(c, &[("broker", "*")], "workspace.deleting", &json!({ "workspaceId": ws, "storeUUID": store, "deleteId": id })).map(|_| ()))?;
        }
        Ok(rows.len())
    }

    pub fn set_run_when_logged_out(&self, actor: &str, ws: &str, enabled: bool) -> R<()> {
        let (role, _) = self.membership(actor, ws)?;
        if role != Role::Owner {
            return Err(MErr::hidden());
        }
        self.tx(|c| {
            // Machine quota (spec §9.3, §27.1): at most as many logged-out workspaces as may run at once.
            if enabled {
                let others: i64 = c.query_row(
                    "SELECT COUNT(*) FROM workspaces WHERE run_when_logged_out = 1 AND workspace_id != ?1 AND state NOT IN ('archived','creating','deleting','deleted')",
                    [ws],
                    |r| r.get(0),
                )?;
                if others >= MAX_RUNNING {
                    return Err(MErr::new("MACHINE_CAPACITY", "the machine already lets the maximum number of workspaces run while logged out"));
                }
            }
            c.execute("UPDATE workspaces SET run_when_logged_out = ?2 WHERE workspace_id = ?1", params![ws, enabled as i64])?;
            Self::enqueue(c, &[("host", ws)], "workspace.settings", &json!({ "workspaceId": ws, "runWhenLoggedOut": enabled }))?;
            Self::audit(c, actor, "workspace.run_when_logged_out", Some(ws), if enabled { "on" } else { "off" }, None)
        })
    }

    // ---------------- members (§7.1, §7.3) ----------------

    pub fn member_snapshot(c: &Connection, ws: &str) -> R<Value> {
        let mut st = c.prepare("SELECT m.user_id, m.role, m.member_version, m.state, u.state FROM workspace_members m JOIN users u USING (user_id) WHERE m.workspace_id = ?1 ORDER BY m.user_id")?;
        let members: Vec<Value> = st
            .query_map([ws], |r| {
                let us: String = r.get(4)?;
                let ms: String = r.get(3)?;
                Ok(json!({ "userId": r.get::<_, String>(0)?, "role": r.get::<_, String>(1)?, "memberVersion": r.get::<_, i64>(2)?, "state": if us != "active" { "revoked".to_string() } else { ms } }))
            })?
            .collect::<Result<_, _>>()?;
        let (inc, epoch): (i64, i64) = c.query_row("SELECT workspace_incarnation, (SELECT machine_control_epoch FROM machine_meta WHERE id = 1) FROM workspaces WHERE workspace_id = ?1", [ws], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(json!({ "workspaceId": ws, "workspaceIncarnation": inc, "machineControlEpoch": epoch, "members": members }))
    }

    pub fn members(&self, actor: &str, ws: &str) -> R<Vec<Value>> {
        // Member management, listing included, is an owner action (spec §9.2 table: members.list … owner).
        if self.membership(actor, ws)?.0 != Role::Owner {
            return Err(MErr::hidden());
        }
        let snap = Self::member_snapshot(&self.c, ws)?;
        Ok(snap["members"].as_array().cloned().unwrap_or_default())
    }

    /// Add (initial viewer) or change a role. Owner only; the target's memberVersion must match what the owner saw.
    pub fn set_role(&self, actor: &str, ws: &str, target: &str, role: &str, expected_version: Option<i64>) -> R<Value> {
        let (arole, _) = self.membership(actor, ws)?;
        if arole != Role::Owner {
            return Err(MErr::hidden());
        }
        let role = Role::parse(role)?;
        if role == Role::Owner {
            return Err(MErr::new("INVALID_REQUEST", "ownership moves only through transferOwner"));
        }
        if target == actor {
            return Err(MErr::new("CONFLICT", "the owner cannot change their own role"));
        }
        let tu = self.user(target)?;
        if tu["state"] != "active" {
            return Err(MErr::hidden());
        }
        self.tx(|c| {
            let cur: Option<(String, i64, String)> = c
                .query_row("SELECT role, member_version, state FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2", params![ws, target], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?;
            let new_version = match &cur {
                None => {
                    // New members always start as viewer (spec §7.1); an editor grant is a second explicit step.
                    if role != Role::Viewer {
                        return Err(MErr::new("INVALID_REQUEST", "a new member starts as viewer"));
                    }
                    if expected_version.is_some() {
                        return Err(MErr::new("PLAN_STALE", "member does not exist yet"));
                    }
                    c.execute("INSERT INTO workspace_members (workspace_id, user_id, role, member_version, state, changed_at) VALUES (?1, ?2, 'viewer', 1, 'active', ?3)", params![ws, target, now_ms()])?;
                    1
                }
                Some((r, v, st)) => {
                    if r == "owner" {
                        return Err(MErr::new("CONFLICT", "the owner's role changes only through transfer"));
                    }
                    if st == "revoking" {
                        return Err(MErr::new("MEMBERSHIP_REVOKED", "revocation is in progress"));
                    }
                    if st == "active" && expected_version != Some(*v) {
                        return Err(MErr::new("PLAN_STALE", "memberVersion changed; reload members"));
                    }
                    if st == "revoked" && role != Role::Viewer {
                        return Err(MErr::new("INVALID_REQUEST", "a re-added member starts as viewer"));
                    }
                    c.execute("UPDATE workspace_members SET role = ?3, member_version = member_version + 1, state = 'active', changed_at = ?4 WHERE workspace_id = ?1 AND user_id = ?2", params![ws, target, role.as_str(), now_ms()])?;
                    v + 1
                }
            };
            let snap = Self::member_snapshot(c, ws)?;
            Self::enqueue(c, &[("gateway", "*"), ("host", ws), ("broker", "*")], "members.snapshot", &snap)?;
            Self::audit(c, actor, "member.set_role", Some(ws), role.as_str(), None)?;
            Ok(json!({ "workspaceId": ws, "userId": target, "role": role.as_str(), "memberVersion": new_version }))
        })
    }

    /// Revocation transaction (§7.3): new memberVersion + revocationId + `revoking`, and one outbox message per
    /// authority. It reads `revoked` only after gateway, Host and broker each acked that sequence.
    pub fn revoke_member(&self, actor: &str, revocation_id: &str, ws: &str, target: &str) -> R<Value> {
        if !is_uuid(revocation_id) {
            return Err(MErr::new("INVALID_REQUEST", "revocationId must be a uuid"));
        }
        if let Ok(v) = self.revocation(revocation_id) {
            return Ok(v);
        }
        let (arole, _) = self.membership(actor, ws)?;
        if arole != Role::Owner {
            return Err(MErr::hidden());
        }
        if target == actor {
            return Err(MErr::new("CONFLICT", "the last owner cannot be removed"));
        }
        self.tx(|c| {
            let cur: (String, i64, String) = c
                .query_row("SELECT role, member_version, state FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2", params![ws, target], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()?
                .ok_or_else(MErr::hidden)?;
            if cur.2 != "active" {
                return Err(MErr::new("CONFLICT", "member is not active"));
            }
            if cur.0 == "owner" {
                return Err(MErr::new("CONFLICT", "the owner cannot be revoked"));
            }
            let nv = cur.1 + 1;
            c.execute("UPDATE workspace_members SET state = 'revoking', member_version = ?3, changed_at = ?4 WHERE workspace_id = ?1 AND user_id = ?2", params![ws, target, nv, now_ms()])?;
            // Waiting machine permits of the revoked member's runs never reach a provider; the Host fences the rest.
            c.execute("UPDATE machine_permits SET state = 'revoked', usage_status = 'unused' WHERE workspace_id = ?1 AND user_id = ?2 AND state IN ('queued','reserved')", params![ws, target])?;
            let mut body = Self::member_snapshot(c, ws)?;
            body["revocationId"] = json!(revocation_id);
            body["revokedUserId"] = json!(target);
            body["newMemberVersion"] = json!(nv);
            let seq = Self::enqueue(c, &[("gateway", "*"), ("host", ws), ("broker", "*")], "member.revoking", &body)?;
            c.execute(
                "INSERT INTO revocations (revocation_id, scope_kind, scope_id, workspace_id, user_id, old_version, new_version, registry_seq, reason, state, created_at) VALUES (?1, 'member', ?2, ?3, ?4, ?5, ?6, ?7, 'member_revoked', 'revoking', ?8)",
                params![revocation_id, format!("{ws}:{target}"), ws, target, cur.1, nv, seq, now_ms()],
            )?;
            Self::audit(c, actor, "member.revoke", Some(ws), "revoking", None)?;
            Ok(())
        })?;
        self.revocation(revocation_id)
    }

    pub fn begin_transfer(&self, actor: &str, transfer_id: &str, ws: &str, to: &str) -> R<Value> {
        if !is_uuid(transfer_id) {
            return Err(MErr::new("INVALID_REQUEST", "transferId must be a uuid"));
        }
        let (arole, av) = self.membership(actor, ws)?;
        if arole != Role::Owner {
            return Err(MErr::hidden());
        }
        let (_, tv) = self.membership(to, ws).map_err(|_| MErr::new("INVALID_REQUEST", "the new owner must already be an active member"))?;
        self.tx(|c| {
            if let Some(st) = c.query_row("SELECT state FROM owner_transfers WHERE transfer_id = ?1", [transfer_id], |r| r.get::<_, String>(0)).optional()? {
                return Ok(json!({ "transferId": transfer_id, "state": st }));
            }
            c.execute(
                "INSERT INTO owner_transfers (transfer_id, workspace_id, from_user_id, to_user_id, from_member_version, to_member_version, expires_at, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'pending', ?8)",
                params![transfer_id, ws, actor, to, av, tv, now_ms() + TRANSFER_MS, now_ms()],
            )?;
            Self::audit(c, actor, "owner.transfer_begin", Some(ws), "pending", None)?;
            Ok(json!({ "transferId": transfer_id, "state": "pending", "expiresAt": now_ms() + TRANSFER_MS }))
        })
    }

    pub fn confirm_transfer(&self, actor: &str, transfer_id: &str) -> R<Value> {
        self.tx(|c| {
            let t: (String, String, String, i64, i64, i64, String) = c
                .query_row("SELECT workspace_id, from_user_id, to_user_id, from_member_version, to_member_version, expires_at, state FROM owner_transfers WHERE transfer_id = ?1", [transfer_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?))
                })
                .optional()?
                .ok_or_else(MErr::hidden)?;
            if t.2 != actor {
                return Err(MErr::hidden());
            }
            if t.6 == "confirmed" {
                return Ok(json!({ "transferId": transfer_id, "state": "confirmed" }));
            }
            if t.6 != "pending" || now_ms() > t.5 {
                c.execute("UPDATE owner_transfers SET state = 'expired' WHERE transfer_id = ?1 AND state = 'pending'", [transfer_id])?;
                return Err(MErr::new("PLAN_STALE", "the transfer expired"));
            }
            let from: Option<(String, i64, String)> = c.query_row("SELECT role, member_version, state FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2", params![t.0, t.1], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
            let to: Option<(i64, String)> = c.query_row("SELECT member_version, state FROM workspace_members WHERE workspace_id = ?1 AND user_id = ?2", params![t.0, t.2], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let from_ok = matches!(&from, Some((r, v, s)) if r == "owner" && *v == t.3 && s == "active");
            let to_ok = matches!(&to, Some((v, s)) if *v == t.4 && s == "active");
            if !from_ok || !to_ok {
                return Err(MErr::new("PLAN_STALE", "the owner or the receiver changed since the transfer started"));
            }
            c.execute("UPDATE workspace_members SET role = 'editor', member_version = member_version + 1, changed_at = ?3 WHERE workspace_id = ?1 AND user_id = ?2", params![t.0, t.1, now_ms()])?;
            c.execute("UPDATE workspace_members SET role = 'owner', member_version = member_version + 1, changed_at = ?3 WHERE workspace_id = ?1 AND user_id = ?2", params![t.0, t.2, now_ms()])?;
            c.execute("UPDATE workspaces SET owner_user_id = ?2 WHERE workspace_id = ?1", params![t.0, t.2])?;
            c.execute("UPDATE owner_transfers SET state = 'confirmed' WHERE transfer_id = ?1", [transfer_id])?;
            let mut snap = Self::member_snapshot(c, &t.0)?;
            snap["ownerChangedFrom"] = json!(t.1);
            Self::enqueue(c, &[("gateway", "*"), ("host", &t.0), ("broker", "*")], "owner.changed", &snap)?;
            Self::audit(c, actor, "owner.transfer_confirm", Some(&t.0), "confirmed", None)?;
            Ok(json!({ "transferId": transfer_id, "state": "confirmed" }))
        })
    }

    // ---------------- instances (§13.2, §17.1 step 6) ----------------

    /// A Host connected from the workspace's execution UID: record its instance and move the workspace to running.
    pub fn host_hello(&self, ws: &str, instance_id: &str, pid: i32, boot: &str) -> R<Value> {
        if !is_uuid(instance_id) {
            return Err(MErr::new("INVALID_REQUEST", "instanceId must be a uuid"));
        }
        // Nor may a Host that its user manager started on its own join while a barrier or restore holds the machine.
        self.require_no_barrier()?;
        self.tx(|c| {
            let (state, epoch): (String, i64) = c.query_row("SELECT state, instance_epoch FROM workspaces WHERE workspace_id = ?1", [ws], |r| Ok((r.get(0)?, r.get(1)?)))?;
            if c.query_row("SELECT 1 FROM workspace_instances WHERE instance_id = ?1", [instance_id], |_| Ok(())).optional()?.is_none() {
                c.execute("UPDATE workspace_instances SET state = 'lost' WHERE workspace_id = ?1 AND state IN ('starting','running','stopping')", [ws])?;
                c.execute(
                    "INSERT INTO workspace_instances (instance_id, workspace_id, instance_epoch, boot_id, host_pid, cgroup_id, state, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'running', ?7)",
                    params![instance_id, ws, epoch, boot, pid, format!("pid:{pid}"), now_ms()],
                )?;
            } else {
                c.execute("UPDATE workspace_instances SET last_seen_at = ?2, host_pid = ?3 WHERE instance_id = ?1", params![instance_id, now_ms(), pid])?;
            }
            if state == "starting" || state == "stopped" {
                c.execute("UPDATE workspaces SET state = 'running' WHERE workspace_id = ?1", [ws])?;
            }
            let snap = Self::member_snapshot(c, ws)?;
            Ok(json!({ "workspaceId": ws, "instanceEpoch": epoch, "membership": snap }))
        })
    }

    pub fn host_gone(&self, ws: &str, instance_id: &str) -> R<()> {
        self.tx(|c| {
            c.execute("UPDATE workspace_instances SET state = 'stopped' WHERE instance_id = ?1 AND state IN ('starting','running','stopping')", [instance_id])?;
            Ok(())
        })?;
        let _ = ws;
        Ok(())
    }

    /// Disk full or read-only (spec §26 row "磁盘满/只读", §27.1): new effects stop; receipts, releases,
    /// revocations, viewing and export continue. The floor leaves room to write the receipts of what already runs.
    pub fn storage_guard(&self) -> R<()> {
        for p in [&self.paths.machine_dir, &self.paths.workspaces_dir, &self.paths.snapshots_dir] {
            let (free, ro) = self.sys.storage(p);
            if ro || free < MIN_FREE_BYTES {
                return Err(MErr::new("MACHINE_CAPACITY", format!("storage {} is {}: new effects are stopped until space is freed", p.display(), if ro { "read-only" } else { "almost full" })));
            }
        }
        Ok(())
    }

    pub fn require_restore_idle(&self) -> R<()> {
        let st: Option<String> = self.c.query_row("SELECT restore_state FROM machine_meta WHERE id = 1", [], |r| r.get(0)).optional()?;
        match st.as_deref() {
            Some("idle") => Ok(()),
            Some(_) => Err(MErr::new("RESTORE_IN_PROGRESS", "a machine restore is in progress")),
            None => Err(MErr::new("MIGRATION_REQUIRED", "machine is not installed")),
        }
    }

    pub fn require_no_barrier(&self) -> R<()> {
        self.require_restore_idle()?;
        if opt_i64(&self.c, "SELECT 1 FROM barriers WHERE state = 'held'", [])?.is_some() {
            return Err(MErr::new("CHECKPOINT_INCOMPLETE", "a machine barrier is held; try after it is released"));
        }
        Ok(())
    }

    pub fn status(&self) -> R<Value> {
        let meta = self.meta()?;
        let ws = opt_i64(&self.c, "SELECT COUNT(*) FROM workspaces WHERE state NOT IN ('archived','deleting','deleted')", [])?.unwrap_or(0);
        let running = opt_i64(&self.c, "SELECT COUNT(*) FROM workspaces WHERE state IN ('starting','running','quiescing')", [])?.unwrap_or(0);
        let users = opt_i64(&self.c, "SELECT COUNT(*) FROM users WHERE state = 'active'", [])?.unwrap_or(0);
        let barrier: Option<String> = self.c.query_row("SELECT owner_kind FROM barriers WHERE state = 'held'", [], |r| r.get(0)).optional()?;
        // Every registered workspace (stopped and archived ones too) with the data schema of its os.sqlite, read
        // read-only: the update health gate refuses a release that does not cover one of them (spec §21.3, V1-U09).
        let mut list = vec![];
        {
            let mut q = self.c.prepare("SELECT workspace_id, state FROM workspaces WHERE state NOT IN ('deleting','deleted') ORDER BY created_at")?;
            let rows: Vec<(String, String)> = q.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
            for (id, st) in rows {
                let db = self.paths.ws_data(&id).join("os.sqlite");
                let initialized = db.exists();
                let schema = workspace_schema(&db);
                list.push(json!({ "workspaceId": id, "state": st, "schemaVersion": schema, "initialized": initialized }));
            }
        }
        Ok(json!({ "meta": meta, "bootId": self.boot, "workspaces": ws, "workspaceList": list, "runningWorkspaces": running, "users": users, "barrier": barrier,
            "limits": { "maxUsers": MAX_USERS, "maxWorkspaces": MAX_WORKSPACES, "maxRunningWorkspaces": MAX_RUNNING } }))
    }
}

/// meta.schema_version of a workspace os.sqlite, opened read-only (immutable when it cannot take the WAL lock).
fn workspace_schema(db: &std::path::Path) -> Option<i64> {
    use rusqlite::OpenFlags;
    if !db.exists() {
        return None;
    }
    let ro = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let q = |uri: String| Connection::open_with_flags(uri, ro).ok().and_then(|c| c.query_row("SELECT schema_version FROM meta WHERE id = 1", [], |r| r.get::<_, i64>(0)).ok());
    let p = db.to_string_lossy();
    q(format!("file:{p}?mode=ro")).or_else(|| q(format!("file:{p}?immutable=1")))
}

fn user_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({ "userId": r.get::<_, String>(0)?, "loginUid": r.get::<_, i64>(1)?, "loginName": r.get::<_, String>(2)?, "role": r.get::<_, String>(3)?, "state": r.get::<_, String>(4)?, "authVersion": r.get::<_, i64>(5)? }))
}

/// A delete_blocker reason as an error with a fixed code.
pub fn blocker_err(b: &Value) -> MErr {
    let code = match b["code"].as_str() {
        Some("WORKSPACE_FENCED") => "WORKSPACE_FENCED",
        Some("STORE_UNAVAILABLE") => "STORE_UNAVAILABLE",
        _ => "CONFLICT",
    };
    MErr::new(code, b["reason"].as_str().unwrap_or("blocked").to_string())
}

pub fn valid_login(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty() && b.len() <= 32 && b[0].is_ascii_lowercase() && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}

pub fn set_mode(p: &std::path::Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
}

pub fn write_private(p: &std::path::Path, bytes: &[u8]) -> R<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = p.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&tmp).map_err(|e| MErr::new("STORE_UNAVAILABLE", e.to_string()))?;
    f.write_all(bytes).and_then(|_| f.sync_all()).map_err(|e| MErr::new("STORE_UNAVAILABLE", e.to_string()))?;
    std::fs::rename(&tmp, p).map_err(|e| MErr::new("STORE_UNAVAILABLE", e.to_string()))?;
    if let Some(d) = p.parent() {
        if let Ok(f) = std::fs::File::open(d) {
            let _ = f.sync_all();
        }
    }
    Ok(())
}
