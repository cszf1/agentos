//! Machine-level admission (spec §13). machined allocates permits only; it never sees prompts or tool bodies.
//! Stable key (workspaceId, executionEpoch, ownerKind, ownerId, attemptId, resourceClass): same key → same record,
//! same key with a different body → rejected. queued → reserved → in_use → released; lost holders go reconciling.
use crate::dir::Machine;
use crate::err::{MErr, R};
use crate::util::{is_uuid, now_ms, uuid};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

pub const MODEL_TOTAL: i64 = 2;
pub const MODEL_BACKGROUND: i64 = 1;
pub const BUILD_TOTAL: i64 = 1;
pub const IO_TOTAL: i64 = 1;
pub const MODEL_DAY: i64 = 256;
pub const MODEL_DAY_BACKGROUND: i64 = 16;
pub const DAY_MS: i64 = 86_400_000;
pub const DEFAULT_DEADLINE_MS: i64 = 15 * 60_000;

fn capacity(class: &str) -> i64 {
    match class {
        "model" => MODEL_TOTAL,
        "build" => BUILD_TOTAL,
        _ => IO_TOTAL,
    }
}

const HELD: &str = "('reserved','in_use','reconciling')";

#[derive(Debug, Clone)]
pub struct PermitRequest {
    pub workspace_id: String,
    pub execution_epoch: i64,
    pub owner_kind: String,
    pub owner_id: String,
    pub attempt_id: String,
    pub resource_class: String,
    pub background: bool,
    pub body_hash: String,
    pub member_version: i64,
    pub user_id: Option<String>,
    pub instance_id: String,
    pub deadline_ms: Option<i64>,
}

fn permit_json(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(json!({
        "permitId": r.get::<_, String>(0)?, "workspaceId": r.get::<_, String>(1)?, "resourceClass": r.get::<_, String>(2)?,
        "priority": r.get::<_, String>(3)?, "state": r.get::<_, String>(4)?, "usageStatus": r.get::<_, String>(5)?,
        "seq": r.get::<_, i64>(6)?, "deadlineAt": r.get::<_, i64>(7)?, "executionEpoch": r.get::<_, i64>(8)?, "memberVersion": r.get::<_, i64>(9)?,
    }))
}
const COLS: &str = "permit_id, workspace_id, resource_class, priority, state, usage_status, seq, deadline_at, execution_epoch, member_version";

impl Machine {
    pub fn permit(&self, permit_id: &str) -> R<Value> {
        self.c.query_row(&format!("SELECT {COLS} FROM machine_permits WHERE permit_id = ?1"), [permit_id], permit_json).optional()?.ok_or_else(MErr::hidden)
    }

    pub fn request_permit(&self, ws_of_peer: &str, rq: &PermitRequest) -> R<Value> {
        if rq.workspace_id != ws_of_peer {
            return Err(MErr::hidden());
        }
        if !matches!(rq.resource_class.as_str(), "model" | "build" | "io") || !matches!(rq.owner_kind.as_str(), "run" | "maintenance" | "compaction" | "deployment" | "backup") {
            return Err(MErr::new("INVALID_REQUEST", "unknown resource class or owner kind"));
        }
        if rq.execution_epoch < 1 || rq.owner_id.is_empty() || rq.owner_id.len() > 128 || !is_uuid(&rq.attempt_id) || !rq.body_hash.starts_with("sha256:") || !is_uuid(&rq.instance_id) {
            return Err(MErr::new("INVALID_REQUEST", "malformed permit key"));
        }
        self.require_restore_idle()?;
        let p = self.tx(|c| {
            let existing: Option<(String, String)> = c
                .query_row(
                    "SELECT permit_id, body_hash FROM machine_permits WHERE workspace_id = ?1 AND execution_epoch = ?2 AND owner_kind = ?3 AND owner_id = ?4 AND attempt_id = ?5 AND resource_class = ?6",
                    params![rq.workspace_id, rq.execution_epoch, rq.owner_kind, rq.owner_id, rq.attempt_id, rq.resource_class],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if let Some((id, h)) = existing {
                if h != rq.body_hash {
                    return Err(MErr::new("CONFLICT", "permit key reused with a different request body"));
                }
                return Ok(id);
            }
            if rq.resource_class == "model" {
                let since = now_ms() - DAY_MS;
                let day: i64 = c.query_row("SELECT COUNT(*) FROM machine_permits WHERE resource_class = 'model' AND created_at >= ?1 AND (state IN ('queued','reserved','in_use','reconciling') OR usage_status IN ('used','unknown'))", [since], |r| r.get(0))?;
                if day >= MODEL_DAY {
                    return Err(MErr::new("MACHINE_CAPACITY", "the machine's 24-hour model request budget is used up"));
                }
                if rq.background {
                    let bg: i64 = c.query_row("SELECT COUNT(*) FROM machine_permits WHERE resource_class = 'model' AND priority = 'background' AND created_at >= ?1 AND (state IN ('queued','reserved','in_use','reconciling') OR usage_status IN ('used','unknown'))", [since], |r| r.get(0))?;
                    if bg >= MODEL_DAY_BACKGROUND {
                        return Err(MErr::new("MACHINE_CAPACITY", "the machine's 24-hour background model budget is used up"));
                    }
                }
            }
            // §13.2 / V1-S03: no waiting for one class while holding another (a run holding a model permit must
            // not queue for the build slot, or two workspaces can wait on each other's slots).
            let holds_other: i64 = c.query_row(
                "SELECT COUNT(*) FROM machine_permits WHERE workspace_id = ?1 AND owner_kind = ?2 AND owner_id = ?3 AND resource_class != ?4 AND state IN ('reserved','in_use')",
                params![rq.workspace_id, rq.owner_kind, rq.owner_id, rq.resource_class],
                |r| r.get(0),
            )?;
            if holds_other > 0 {
                return Err(MErr::new("MACHINE_CAPACITY", "release the permit this owner already holds before waiting for another resource class"));
            }
            let ws_state: Option<String> = c.query_row("SELECT state FROM workspaces WHERE workspace_id = ?1", [&rq.workspace_id], |r| r.get(0)).optional()?;
            if ws_state.as_deref() != Some("running") {
                return Err(MErr::new("WORKSPACE_FENCED", "workspace is not running"));
            }
            let seq: i64 = c.query_row("SELECT COALESCE(MAX(seq), 0) + 1 FROM machine_permits", [], |r| r.get(0))?;
            let id = uuid();
            c.execute(
                "INSERT INTO machine_permits (permit_id, workspace_id, execution_epoch, owner_kind, owner_id, attempt_id, resource_class, priority, body_hash, member_version, user_id, instance_id, boot_id, seq, state, deadline_at, usage_status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?16, ?11, ?12, ?13, 'queued', ?14, 'none', ?15)",
                params![id, rq.workspace_id, rq.execution_epoch, rq.owner_kind, rq.owner_id, rq.attempt_id, rq.resource_class, if rq.background { "background" } else { "foreground" }, rq.body_hash, rq.member_version, rq.instance_id, self.boot, seq, now_ms() + rq.deadline_ms.unwrap_or(DEFAULT_DEADLINE_MS), now_ms(), rq.user_id],
            )?;
            Ok(id)
        })?;
        self.schedule()?;
        self.permit(&p)
    }

    /// Grant free slots per class. Foreground first, round-robin across workspaces: while another workspace waits,
    /// one workspace holds at most one model permit. Background only when no foreground is waiting or holding and no
    /// other background permit is held (spec §13.2).
    pub fn schedule(&self) -> R<Vec<String>> {
        self.tx(|c| {
            let mut granted = vec![];
            for class in ["model", "build", "io"] {
                loop {
                    let held: i64 = c.query_row(&format!("SELECT COUNT(*) FROM machine_permits WHERE resource_class = ?1 AND state IN {HELD}"), [class], |r| r.get(0))?;
                    if held >= capacity(class) {
                        break;
                    }
                    match choose(c, class)? {
                        Some(id) => {
                            c.execute("UPDATE machine_permits SET state = 'reserved', reserved_at = ?2 WHERE permit_id = ?1 AND state = 'queued'", params![id, now_ms()])?;
                            granted.push(id);
                        }
                        None => break,
                    }
                }
            }
            Ok(granted)
        })
    }

    /// The Host has made its final checks (cancel, revocation, pause, observe, policy, deadline) and is about to send.
    pub fn use_permit(&self, ws_of_peer: &str, permit_id: &str, member_version: i64) -> R<Value> {
        self.tx(|c| {
            let (ws, state, mv, deadline): (String, String, i64, i64) = c
                .query_row("SELECT workspace_id, state, member_version, deadline_at FROM machine_permits WHERE permit_id = ?1", [permit_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
                .optional()?
                .ok_or_else(MErr::hidden)?;
            if ws != ws_of_peer {
                return Err(MErr::hidden());
            }
            if state == "in_use" {
                return Ok(None);
            }
            if state != "reserved" {
                return Err(MErr::new(if state == "reconciling" { "PERMIT_RECONCILING" } else { "MEMBERSHIP_REVOKED" }, format!("permit is {state}")));
            }
            if mv != member_version || now_ms() > deadline {
                // Committed (not rolled back with the error): the slot goes to the next waiter at once.
                c.execute("UPDATE machine_permits SET state = 'revoked', usage_status = 'unused' WHERE permit_id = ?1", [permit_id])?;
                return Ok(Some(MErr::new("MEMBERSHIP_REVOKED", "permit was issued for an older membership or expired")));
            }
            c.execute("UPDATE machine_permits SET state = 'in_use', used_at = ?2 WHERE permit_id = ?1", params![permit_id, now_ms()])?;
            Ok(None)
        })?
        .map_or(Ok(()), |e| {
            let _ = self.schedule();
            Err(e)
        })?;
        self.permit(permit_id)
    }

    /// Release with the real usage. `unknown` (the request may have reached the provider) is charged like `used`.
    pub fn release_permit(&self, ws_of_peer: &str, permit_id: &str, usage: &str, usage_json: Option<&Value>) -> R<Value> {
        if !matches!(usage, "used" | "unused" | "unknown") {
            return Err(MErr::new("INVALID_REQUEST", "usage must be used, unused or unknown"));
        }
        self.tx(|c| {
            let (ws, state): (String, String) = c.query_row("SELECT workspace_id, state FROM machine_permits WHERE permit_id = ?1", [permit_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?.ok_or_else(MErr::hidden)?;
            if ws != ws_of_peer {
                return Err(MErr::hidden());
            }
            match state.as_str() {
                "released" | "revoked" => return Ok(()),
                "queued" | "reserved" if usage != "unused" => return Err(MErr::new("INVALID_REQUEST", "a permit that was never used cannot report usage")),
                _ => {}
            }
            let to = if state == "queued" || (state == "reserved" && usage == "unused") { "revoked" } else { "released" };
            c.execute(
                "UPDATE machine_permits SET state = ?2, usage_status = ?3, usage_json = ?4 WHERE permit_id = ?1",
                params![permit_id, to, usage, usage_json.map(crate::util::canon)],
            )?;
            Ok(())
        })?;
        self.schedule()?;
        self.permit(permit_id)
    }

    /// Revocation of a member: waiting permits of the old membership never reach a provider (V1-I07, V1-S04).
    pub fn revoke_permits_for(c: &Connection, ws: &str, below_member_version: Option<i64>) -> R<usize> {
        let n = match below_member_version {
            Some(v) => c.execute("UPDATE machine_permits SET state = 'revoked', usage_status = 'unused' WHERE workspace_id = ?1 AND state IN ('queued','reserved') AND member_version < ?2", params![ws, v])?,
            None => c.execute("UPDATE machine_permits SET state = 'revoked', usage_status = 'unused' WHERE workspace_id = ?1 AND state IN ('queued','reserved')", [ws])?,
        };
        Ok(n)
    }

    /// machined start (spec §13.2, V1-S05): never mark permits free on restart. Held permits go reconciling; a
    /// permit is freed only when its holder is proven gone (other boot, or no process left of the execution UID),
    /// and then `in_use` is charged as unknown usage while `reserved` was never used.
    pub fn reconcile_permits(&mut self) -> R<Value> {
        let rows: Vec<(String, String, String, Option<i64>, String, u32)> = {
            let mut st = self.c.prepare(
                "SELECT p.permit_id, p.state, p.boot_id, p.used_at, p.instance_id, w.execution_uid FROM machine_permits p JOIN workspaces w USING (workspace_id) WHERE p.state IN ('reserved','in_use','reconciling')",
            )?;
            let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get::<_, i64>(5)? as u32)))?.collect::<Result<Vec<_>, _>>()?;
            v
        };
        let mut freed = 0;
        let mut waiting = 0;
        for (id, state, boot, used_at, _inst, uid) in rows {
            let gone = boot != self.boot || !self.sys.exec_cgroup_busy(uid);
            self.tx(|c| {
                if gone {
                    let (to, usage) = if state == "reserved" || (state == "reconciling" && used_at.is_none()) { ("revoked", "unused") } else { ("released", "unknown") };
                    c.execute("UPDATE machine_permits SET state = ?2, usage_status = ?3 WHERE permit_id = ?1", params![id, to, usage])?;
                    freed += 1;
                } else {
                    c.execute("UPDATE machine_permits SET state = 'reconciling' WHERE permit_id = ?1", [&id])?;
                    waiting += 1;
                }
                Ok(())
            })?;
        }
        self.schedule()?;
        Ok(json!({ "freed": freed, "reconciling": waiting }))
    }

    /// A Host that reconnected reports the true state of an attempt it held before machined restarted.
    pub fn report_permit(&self, ws_of_peer: &str, permit_id: &str, holder_state: &str) -> R<Value> {
        self.tx(|c| {
            let (ws, state): (String, String) = c.query_row("SELECT workspace_id, state FROM machine_permits WHERE permit_id = ?1", [permit_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?.ok_or_else(MErr::hidden)?;
            if ws != ws_of_peer {
                return Err(MErr::hidden());
            }
            if state != "reconciling" {
                return Ok(());
            }
            match holder_state {
                "in_use" => c.execute("UPDATE machine_permits SET state = 'in_use', used_at = COALESCE(used_at, ?2) WHERE permit_id = ?1", params![permit_id, now_ms()])?,
                "reserved" => c.execute("UPDATE machine_permits SET state = 'reserved' WHERE permit_id = ?1", [permit_id])?,
                "unused" => c.execute("UPDATE machine_permits SET state = 'revoked', usage_status = 'unused' WHERE permit_id = ?1", [permit_id])?,
                "used" | "unknown" => c.execute("UPDATE machine_permits SET state = 'released', usage_status = ?2 WHERE permit_id = ?1", params![permit_id, holder_state])?,
                _ => return Err(MErr::new("INVALID_REQUEST", "unknown holder state")),
            };
            Ok(())
        })?;
        self.schedule()?;
        self.permit(permit_id)
    }

    pub fn permits_of(&self, ws: &str) -> R<Vec<Value>> {
        let mut st = self.c.prepare(&format!("SELECT {COLS} FROM machine_permits WHERE workspace_id = ?1 AND state NOT IN ('released','revoked') ORDER BY seq"))?;
        let v = st.query_map([ws], permit_json)?.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }

    pub fn permit_summary(&self) -> R<Value> {
        let mut out = serde_json::Map::new();
        for class in ["model", "build", "io"] {
            let held: i64 = self.c.query_row(&format!("SELECT COUNT(*) FROM machine_permits WHERE resource_class = ?1 AND state IN {HELD}"), [class], |r| r.get(0))?;
            let queued: i64 = self.c.query_row("SELECT COUNT(*) FROM machine_permits WHERE resource_class = ?1 AND state = 'queued'", [class], |r| r.get(0))?;
            out.insert(class.into(), json!({ "held": held, "queued": queued, "capacity": capacity(class) }));
        }
        let since = now_ms() - DAY_MS;
        let day: i64 = self.c.query_row("SELECT COUNT(*) FROM machine_permits WHERE resource_class = 'model' AND created_at >= ?1 AND (state IN ('queued','reserved','in_use','reconciling') OR usage_status IN ('used','unknown'))", [since], |r| r.get(0))?;
        out.insert("modelDay".into(), json!({ "charged": day, "limit": MODEL_DAY, "backgroundLimit": MODEL_DAY_BACKGROUND }));
        Ok(Value::Object(out))
    }
}

fn choose(c: &Connection, class: &str) -> R<Option<String>> {
    let mut st = c.prepare("SELECT permit_id, workspace_id, priority, seq FROM machine_permits WHERE resource_class = ?1 AND state = 'queued' ORDER BY seq")?;
    let waiters: Vec<(String, String, String, i64)> = st.query_map([class], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?.collect::<Result<_, _>>()?;
    let mut st = c.prepare(&format!("SELECT workspace_id, priority FROM machine_permits WHERE resource_class = ?1 AND state IN {HELD}"))?;
    let held: Vec<(String, String)> = st.query_map([class], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<Result<_, _>>()?;
    let fg_wait: Vec<&(String, String, String, i64)> = waiters.iter().filter(|w| w.2 == "foreground").collect();
    let fg_held: Vec<&(String, String)> = held.iter().filter(|h| h.1 == "foreground").collect();
    if !fg_wait.is_empty() {
        // Round robin: among waiting workspaces prefer the one holding fewest permits, then the oldest waiter.
        let mut best: Option<(&(String, String, String, i64), usize)> = None;
        for w in &fg_wait {
            let mine = held.iter().filter(|h| h.0 == w.1).count();
            let others_waiting = fg_wait.iter().any(|o| o.1 != w.1);
            if mine >= 2 || (mine >= 1 && others_waiting) {
                continue;
            }
            match best {
                Some((_, m)) if m <= mine => {}
                _ => best = Some((w, mine)),
            }
        }
        return Ok(best.map(|(w, _)| w.0.clone()));
    }
    if !fg_held.is_empty() || held.iter().any(|h| h.1 == "background") {
        return Ok(None);
    }
    if class == "model" && held.len() as i64 >= MODEL_BACKGROUND + 1 {
        return Ok(None);
    }
    Ok(waiters.iter().find(|w| w.2 == "background").map(|w| w.0.clone()))
}
