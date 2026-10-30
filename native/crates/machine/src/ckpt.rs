//! One machine-exclusive barrier shared by update, checkpoint and restore flows (spec §15.3, §21.2 step 3, §23.2),
//! checkpoint sets (complete marks the only recoverable publish point) and restore journals (§24.1).
use crate::dir::Machine;
use crate::err::{MErr, R};
use crate::util::{canon, is_uuid, now_ms, uuid};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub const KEEP_COMPLETE: i64 = 3;

pub const RESTORE_EDGES: &[(&str, &[&str])] = &[
    ("planned", &["verified", "recovery_required", "abandoned"]),
    ("verified", &["quiescing", "recovery_required", "abandoned"]),
    ("quiescing", &["staging", "recovery_required"]),
    ("staging", &["replacing", "recovery_required"]),
    ("replacing", &["reconciling", "recovery_required"]),
    ("reconciling", &["complete", "recovery_required"]),
    ("recovery_required", &["replacing", "reconciling", "abandoned"]),
];

impl Machine {
    /// Acquire the machine barrier for an owner, or return the one this owner already holds (re-entry).
    pub fn hold_barrier(&self, owner_kind: &str, owner_id: &str, scope: &Value) -> R<String> {
        self.tx(|c| {
            if let Some((id, ok, oid)) = c.query_row("SELECT barrier_id, owner_kind, owner_id FROM barriers WHERE state = 'held'", [], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).optional()? {
                if ok == owner_kind && oid == owner_id {
                    return Ok(id);
                }
                // An update creating its pre-update checkpoint reuses the update's barrier (spec §21.2).
                if owner_kind == "checkpoint" && ok == "update" && scope.get("barrierId").and_then(|v| v.as_str()) == Some(id.as_str()) {
                    return Ok(id);
                }
                return Err(MErr::new("CHECKPOINT_INCOMPLETE", format!("the machine barrier is held by {ok}")));
            }
            let id = uuid();
            c.execute("INSERT INTO barriers (barrier_id, owner_kind, owner_id, scope_json, state, created_at) VALUES (?1, ?2, ?3, ?4, 'held', ?5)", params![id, owner_kind, owner_id, canon(scope), now_ms()])?;
            let mut targets: Vec<(String, String)> = vec![("gateway".into(), "*".into()), ("broker".into(), "*".into())];
            let wss: Vec<String> = match scope.get("workspaces").and_then(|v| v.as_array()) {
                Some(a) => a.iter().filter_map(|v| v.as_str().map(String::from)).collect(),
                None => {
                    let mut st = c.prepare("SELECT workspace_id FROM workspaces WHERE state != 'archived'")?;
                    let v = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
                    v
                }
            };
            for w in &wss {
                targets.push(("host".into(), w.clone()));
            }
            let t: Vec<(&str, &str)> = targets.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
            Self::enqueue(c, &t, "barrier.held", &json!({ "barrierId": id, "ownerKind": owner_kind, "workspaces": wss }))?;
            Self::audit(c, "root", &format!("barrier.hold:{owner_kind}"), Some(&id), "held", Some(owner_id))?;
            Ok(id)
        })
    }

    pub fn release_barrier(&self, barrier_id: &str) -> R<()> {
        self.tx(|c| {
            let n = c.execute("UPDATE barriers SET state = 'released', released_at = ?2 WHERE barrier_id = ?1 AND state = 'held'", params![barrier_id, now_ms()])?;
            if n > 0 {
                let mut st = c.prepare("SELECT workspace_id FROM workspaces WHERE state != 'archived'")?;
                let wss: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
                let mut targets: Vec<(String, String)> = vec![("gateway".into(), "*".into()), ("broker".into(), "*".into())];
                for w in wss {
                    targets.push(("host".into(), w));
                }
                let t: Vec<(&str, &str)> = targets.iter().map(|(a, b)| (a.as_str(), b.as_str())).collect();
                Self::enqueue(c, &t, "barrier.released", &json!({ "barrierId": barrier_id }))?;
                Self::audit(c, "root", "barrier.release", Some(barrier_id), "released", None)?;
            }
            Ok(())
        })
    }

    pub fn held_barrier(&self) -> R<Option<Value>> {
        Ok(self
            .c
            .query_row("SELECT barrier_id, owner_kind, owner_id, scope_json FROM barriers WHERE state = 'held'", [], |r| {
                Ok(json!({ "barrierId": r.get::<_, String>(0)?, "ownerKind": r.get::<_, String>(1)?, "ownerId": r.get::<_, String>(2)?, "scope": serde_json::from_str::<Value>(&r.get::<_, String>(3)?).unwrap_or(Value::Null) }))
            })
            .optional()?)
    }

    pub fn begin_checkpoint(&self, set_id: &str, scope: &str, barrier_id: &str) -> R<Value> {
        if !is_uuid(set_id) || !matches!(scope, "workspace" | "machine") {
            return Err(MErr::new("INVALID_REQUEST", "bad checkpoint request"));
        }
        let rid: Option<String> = self.c.query_row("SELECT current_release_id FROM machine_meta WHERE id = 1", [], |r| r.get(0))?;
        self.tx(|c| {
            let held: Option<String> = c.query_row("SELECT barrier_id FROM barriers WHERE state = 'held'", [], |r| r.get(0)).optional()?;
            if held.as_deref() != Some(barrier_id) {
                return Err(MErr::new("CHECKPOINT_INCOMPLETE", "the checkpoint barrier is not held"));
            }
            c.execute("INSERT OR IGNORE INTO checkpoint_sets (set_id, scope, state, release_id, barrier_id, created_at) VALUES (?1, ?2, 'building', ?3, ?4, ?5)", params![set_id, scope, rid, barrier_id, now_ms()])?;
            Ok(())
        })?;
        self.checkpoint(set_id)
    }

    /// The only publish point of a set: after every component hash was verified the manifest hash is written.
    pub fn complete_checkpoint(&self, set_id: &str, manifest_hash: &str, pinned: bool) -> R<Value> {
        self.tx(|c| {
            let st: String = c.query_row("SELECT state FROM checkpoint_sets WHERE set_id = ?1", [set_id], |r| r.get(0)).optional()?.ok_or_else(MErr::hidden)?;
            if st == "complete" {
                return Ok(());
            }
            if st != "building" {
                return Err(MErr::new("CHECKPOINT_INCOMPLETE", "set was abandoned"));
            }
            c.execute("UPDATE checkpoint_sets SET state = 'complete', manifest_hash = ?2, completed_at = ?3, pinned = ?4 WHERE set_id = ?1", params![set_id, manifest_hash, now_ms(), pinned as i64])?;
            Self::audit(c, "root", "checkpoint.complete", Some(set_id), "complete", None)
        })?;
        self.checkpoint(set_id)
    }

    pub fn abandon_checkpoint(&self, set_id: &str) -> R<()> {
        self.tx(|c| {
            c.execute("UPDATE checkpoint_sets SET state = 'abandoned' WHERE set_id = ?1 AND state = 'building'", [set_id])?;
            Ok(())
        })
    }

    pub fn checkpoint(&self, set_id: &str) -> R<Value> {
        self.c
            .query_row("SELECT set_id, scope, state, manifest_hash, release_id, barrier_id, pinned, export_state, created_at FROM checkpoint_sets WHERE set_id = ?1", [set_id], |r| {
                Ok(json!({ "setId": r.get::<_, String>(0)?, "scope": r.get::<_, String>(1)?, "state": r.get::<_, String>(2)?, "manifestHash": r.get::<_, Option<String>>(3)?,
                    "releaseId": r.get::<_, Option<String>>(4)?, "barrierId": r.get::<_, String>(5)?, "pinned": r.get::<_, i64>(6)? == 1, "exportState": r.get::<_, String>(7)?, "createdAt": r.get::<_, i64>(8)? }))
            })
            .optional()?
            .ok_or_else(MErr::hidden)
    }

    pub fn checkpoints(&self) -> R<Vec<Value>> {
        let ids: Vec<String> = {
            let mut st = self.c.prepare("SELECT set_id FROM checkpoint_sets ORDER BY created_at DESC")?;
            let v = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<_>, _>>()?;
            v
        };
        ids.iter().map(|i| self.checkpoint(i)).collect()
    }

    /// Retention (§23.3): keep the newest KEEP_COMPLETE complete sets plus every pinned one; the caller deletes
    /// only what this returns, and never the only complete set.
    pub fn prunable_checkpoints(&self) -> R<Vec<String>> {
        let mut st = self.c.prepare("SELECT set_id FROM checkpoint_sets WHERE state = 'complete' AND pinned = 0 ORDER BY created_at DESC")?;
        let all: Vec<String> = st.query_map([], |r| r.get(0))?.collect::<Result<_, _>>()?;
        let pinned_in_use: Vec<String> = {
            let mut st = self.c.prepare("SELECT checkpoint_set_id FROM update_jobs WHERE checkpoint_set_id IS NOT NULL AND state NOT IN ('committed','cancelled','failed_no_switch','rolled_back') UNION SELECT set_id FROM restore_jobs WHERE state NOT IN ('complete','abandoned')")?;
            let v = st.query_map([], |r| r.get(0))?.collect::<Result<Vec<String>, _>>()?;
            v
        };
        Ok(all.into_iter().skip(KEEP_COMPLETE as usize).filter(|s| !pinned_in_use.contains(s)).collect())
    }

    pub fn set_export_state(&self, set_id: &str, state: &str) -> R<()> {
        self.tx(|c| {
            c.execute("UPDATE checkpoint_sets SET export_state = ?2 WHERE set_id = ?1", params![set_id, state])?;
            Ok(())
        })
    }

    pub fn plan_restore(&self, restore_id: &str, set_id: &str, mode: &str) -> R<Value> {
        if !is_uuid(restore_id) || !matches!(mode, "same-machine" | "clone" | "workspace") {
            return Err(MErr::new("INVALID_REQUEST", "bad restore request"));
        }
        let set = self.checkpoint(set_id)?;
        if set["state"] != "complete" {
            return Err(MErr::new("CHECKPOINT_INCOMPLETE", "only complete sets can be restored"));
        }
        let epoch = self.control_epoch()?;
        self.tx(|c| {
            if let Some((s, m)) = c.query_row("SELECT set_id, mode FROM restore_jobs WHERE restore_id = ?1", [restore_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? {
                if s != set_id || m != mode {
                    return Err(MErr::new("CONFLICT", "restoreId reused"));
                }
                return Ok(());
            }
            c.execute("INSERT INTO restore_jobs (restore_id, set_id, mode, state, old_control_epoch, created_at) VALUES (?1, ?2, ?3, 'planned', ?4, ?5)", params![restore_id, set_id, mode, epoch, now_ms()])
                .map_err(|e| match MErr::from(e) {
                    m if m.code == "CONFLICT" => MErr::new("RESTORE_IN_PROGRESS", "another restore is open"),
                    m => m,
                })?;
            Self::audit(c, "root", "restore.plan", Some(restore_id), mode, None)
        })?;
        self.restore(restore_id)
    }

    pub fn restore(&self, restore_id: &str) -> R<Value> {
        self.c
            .query_row("SELECT restore_id, set_id, mode, state, old_control_epoch, new_control_epoch, staging_identity, step_cursor FROM restore_jobs WHERE restore_id = ?1", [restore_id], |r| {
                Ok(json!({ "restoreId": r.get::<_, String>(0)?, "setId": r.get::<_, String>(1)?, "mode": r.get::<_, String>(2)?, "state": r.get::<_, String>(3)?,
                    "oldControlEpoch": r.get::<_, i64>(4)?, "newControlEpoch": r.get::<_, Option<i64>>(5)?, "stagingIdentity": r.get::<_, Option<String>>(6)?, "stepCursor": r.get::<_, Option<String>>(7)? }))
            })
            .optional()?
            .ok_or_else(MErr::hidden)
    }

    /// Restore journal step. Entering `quiescing` writes restore-in-progress (root-owned marker + machine state) and,
    /// for a machine restore, raises machineControlEpoch so every interactive session must rebind (§24.1 step 1, 3).
    pub fn advance_restore(&self, restore_id: &str, to: &str, cursor: Option<&str>) -> R<Value> {
        let marker = self.paths.machine_dir.join("restore-in-progress");
        self.tx(|c| {
            let (cur, mode): (String, String) = c.query_row("SELECT state, mode FROM restore_jobs WHERE restore_id = ?1", [restore_id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?.ok_or_else(MErr::hidden)?;
            if cur == to {
                if let Some(cu) = cursor {
                    c.execute("UPDATE restore_jobs SET step_cursor = ?2 WHERE restore_id = ?1", params![restore_id, cu])?;
                }
                return Ok(());
            }
            if !RESTORE_EDGES.iter().any(|(f, t)| *f == cur && t.contains(&to)) {
                return Err(MErr::new("CONFLICT", format!("restore cannot move {cur} → {to}")));
            }
            if to == "quiescing" {
                c.execute("UPDATE machine_meta SET restore_state = 'in_progress' WHERE id = 1", [])?;
                crate::dir::write_private(&marker, restore_id.as_bytes())?;
                if mode != "workspace" {
                    let e = Self::bump_control_epoch(c)?;
                    c.execute("UPDATE restore_jobs SET new_control_epoch = ?2 WHERE restore_id = ?1", params![restore_id, e])?;
                    Self::enqueue(c, &[("gateway", "*"), ("broker", "*")], "machine.control_epoch", &json!({ "machineControlEpoch": e, "restoreId": restore_id }))?;
                } else {
                    Self::enqueue(c, &[("gateway", "*"), ("broker", "*")], "restore.started", &json!({ "restoreId": restore_id }))?;
                }
            }
            c.execute("UPDATE restore_jobs SET state = ?2, step_cursor = COALESCE(?3, step_cursor) WHERE restore_id = ?1", params![restore_id, to, cursor])?;
            if to == "complete" || to == "abandoned" {
                c.execute("UPDATE machine_meta SET restore_state = 'idle' WHERE id = 1", [])?;
                let _ = std::fs::remove_file(&marker);
                Self::enqueue(c, &[("gateway", "*"), ("broker", "*")], "restore.finished", &json!({ "restoreId": restore_id, "state": to }))?;
            }
            Self::audit(c, "root", "restore.state", Some(restore_id), to, None)
        })?;
        self.restore(restore_id)
    }

    /// Bump a restored workspace's incarnation (and with it every old session, run and plan of it).
    pub fn bump_incarnation(&self, ws: &str, restore_id: &str) -> R<i64> {
        self.tx(|c| {
            c.execute("UPDATE workspaces SET workspace_incarnation = workspace_incarnation + 1 WHERE workspace_id = ?1", [ws])?;
            let inc: i64 = c.query_row("SELECT workspace_incarnation FROM workspaces WHERE workspace_id = ?1", [ws], |r| r.get(0))?;
            let mut snap = Self::member_snapshot(c, ws)?;
            snap["restoreId"] = json!(restore_id);
            Self::enqueue(c, &[("gateway", "*"), ("broker", "*"), ("host", ws)], "workspace.incarnation", &snap)?;
            Self::audit(c, "root", "workspace.incarnation", Some(ws), &inc.to_string(), Some(restore_id))?;
            Ok(inc)
        })
    }

    /// Apply a backup's member list without letting it override current authority (§24.1 last paragraph):
    /// a user disabled now stays disabled, a member revoked now stays revoked, nobody is promoted.
    pub fn reconcile_member_snapshot(&self, ws: &str, backup: &[Value]) -> R<Value> {
        let mut rejected = vec![];
        let mut kept = vec![];
        for m in backup {
            let uid = m["userId"].as_str().unwrap_or_default();
            let cur: Option<(String, String)> = self.c.query_row("SELECT m.state, u.state FROM workspace_members m JOIN users u USING (user_id) WHERE m.workspace_id = ?1 AND m.user_id = ?2", params![ws, uid], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            match cur {
                Some((ms, us)) if ms == "active" && us == "active" => kept.push(uid.to_string()),
                _ => rejected.push(uid.to_string()),
            }
        }
        Ok(json!({ "kept": kept, "rejected": rejected }))
    }
}
