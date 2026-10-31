//! Signed ReleaseManifest verification and the update/trial-boot state machine (spec §20, §21).
//! Trust: Ed25519 over the domain hash `agentos.release.manifest.v1` of the canonical manifest. Highest accepted
//! releaseSequence and revoked keys live in machine.sqlite and do not follow workspace restores or rollbacks.
use crate::dir::Machine;
use crate::err::{MErr, R};
use crate::util::{canon, hash, is_uuid, now_ms};
use ed25519_dalek::{Signature, VerifyingKey};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

pub const RELEASE_DOMAIN: &str = "agentos.release.manifest.v1";
pub const ROTATION_DOMAIN: &str = "agentos.release.key-rotation.v1";

#[cfg(test)]
thread_local! {
    /// Test-only: make the next rotate_key fail after its writes, before the commit (review R2-3 interruption test).
    pub static ROTATE_FAULT: std::cell::Cell<bool> = std::cell::Cell::new(false);
}

const KEYS: &[&str] = &[
    "formatVersion", "releaseId", "releaseSequence", "version", "channel", "publishedAt", "expiresAt", "supportUntil", "sourceCommit",
    "flakeLockHash", "nixpkgsRevision", "platform", "hardwareProfiles", "baseClosurePath", "baseClosureHash", "closureContentHashes",
    "kernelVersion", "initrdHash", "ociDigests", "sbomHash", "compatibility", "migrationClass", "healthProfile", "minRecoveryVersion", "keyId",
];

fn is_sha(v: &Value) -> bool {
    v.as_str().map(|s| s.len() == 71 && s.starts_with("sha256:") && s[7..].bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).unwrap_or(false)
}
fn is_commit(v: &Value) -> bool {
    v.as_str().map(|s| s.len() == 40 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))).unwrap_or(false)
}
fn pos(v: &Value) -> bool {
    v.as_i64().map(|n| n >= 1 && n <= 9_007_199_254_740_991).unwrap_or(false)
}

/// Strict schema: unknown or missing fields, wrong types, unsorted/duplicate hashes all reject the manifest.
pub fn parse_manifest(v: &Value) -> R<()> {
    let o = v.as_object().ok_or_else(|| MErr::new("UPDATE_SIGNATURE_INVALID", "manifest must be an object"))?;
    let bad = |m: &str| MErr::new("UPDATE_SIGNATURE_INVALID", m.to_string());
    for k in o.keys() {
        if !KEYS.contains(&k.as_str()) {
            return Err(bad(&format!("unknown field {k}")));
        }
    }
    for k in KEYS {
        if !o.contains_key(*k) {
            return Err(bad(&format!("missing {k}")));
        }
    }
    if o["formatVersion"] != 1 || !o["releaseId"].as_str().map(is_uuid).unwrap_or(false) || !pos(&o["releaseSequence"]) {
        return Err(bad("bad formatVersion/releaseId/releaseSequence"));
    }
    for k in ["publishedAt", "expiresAt", "supportUntil"] {
        if !pos(&o[k]) {
            return Err(bad(&format!("bad {k}")));
        }
    }
    if o["expiresAt"].as_i64() < o["publishedAt"].as_i64() || o["supportUntil"].as_i64() < o["publishedAt"].as_i64() {
        return Err(bad("bad time order"));
    }
    if !is_commit(&o["sourceCommit"]) || !is_commit(&o["nixpkgsRevision"]) {
        return Err(bad("bad revision"));
    }
    for k in ["flakeLockHash", "baseClosureHash", "initrdHash", "sbomHash"] {
        if !is_sha(&o[k]) {
            return Err(bad(&format!("bad {k}")));
        }
    }
    if o["platform"] != "x86_64-linux" {
        return Err(bad("unsupported platform"));
    }
    let path = o["baseClosurePath"].as_str().unwrap_or_default();
    if !path.starts_with("/nix/store/") || path.contains("..") || path.len() > 200 {
        return Err(bad("bad baseClosurePath"));
    }
    let hp = o["hardwareProfiles"].as_array().ok_or_else(|| bad("bad hardwareProfiles"))?;
    if hp.is_empty() || hp.iter().any(|p| !matches!(p.as_str(), Some("qemu-virtio") | Some("intel-amd-mesa-ref1"))) {
        return Err(bad("unknown hardware profile"));
    }
    for k in ["closureContentHashes", "ociDigests"] {
        let a = o[k].as_array().ok_or_else(|| bad(&format!("bad {k}")))?;
        if a.len() > 4096 || a.iter().any(|h| !is_sha(h)) {
            return Err(bad(&format!("bad {k}")));
        }
        let mut s: Vec<&str> = a.iter().filter_map(|x| x.as_str()).collect();
        s.sort();
        s.dedup();
        if s.len() != a.len() {
            return Err(bad(&format!("{k} has duplicates")));
        }
    }
    if !matches!(o["migrationClass"].as_str(), Some("none") | Some("compatible_expand") | Some("offline_breaking")) {
        return Err(bad("bad migrationClass"));
    }
    let comp = o["compatibility"].as_object().ok_or_else(|| bad("bad compatibility"))?;
    for k in ["workspaceSchema", "machineSchema", "brokerSchema", "brokerProtocol", "nativeRpc"] {
        let r = comp.get(k).and_then(|v| v.as_array()).ok_or_else(|| bad(&format!("compatibility.{k} missing")))?;
        if r.len() != 2 || !pos(&r[0]) || !pos(&r[1]) || r[0].as_i64() > r[1].as_i64() {
            return Err(bad(&format!("compatibility.{k} must be [min, max]")));
        }
    }
    if comp.len() != 5 {
        return Err(bad("unknown compatibility field"));
    }
    for k in ["version", "channel", "kernelVersion", "healthProfile", "minRecoveryVersion", "keyId"] {
        let s = o[k].as_str().unwrap_or_default();
        if s.is_empty() || s.len() > 64 || s.chars().any(|c| c.is_control()) {
            return Err(bad(&format!("bad {k}")));
        }
    }
    Ok(())
}

pub fn manifest_hash(v: &Value) -> String {
    hash(RELEASE_DOMAIN, v)
}

pub fn verify_sig(pubkey_hex: &str, digest: &str, sig_hex: &str) -> R<()> {
    let bad = || MErr::new("UPDATE_SIGNATURE_INVALID", "signature does not verify");
    let pk: [u8; 32] = hex::decode(pubkey_hex).map_err(|_| bad())?.try_into().map_err(|_| bad())?;
    let key = VerifyingKey::from_bytes(&pk).map_err(|_| bad())?;
    let sig: [u8; 64] = hex::decode(sig_hex).map_err(|_| bad())?.try_into().map_err(|_| bad())?;
    let d = hex::decode(digest.strip_prefix("sha256:").ok_or_else(bad)?).map_err(|_| bad())?;
    key.verify_strict(&d, &Signature::from_bytes(&sig)).map_err(|_| bad())
}

pub const UPDATE_EDGES: &[(&str, &[&str])] = &[
    ("discovered", &["verified", "failed_no_switch"]),
    ("verified", &["downloading", "failed_no_switch", "cancelled"]),
    ("downloading", &["staged", "failed_no_switch", "cancelled", "downloading"]),
    ("staged", &["waiting_confirmation", "failed_no_switch", "cancelled", "needs_attention"]),
    ("waiting_confirmation", &["quiescing", "cancelled"]),
    ("quiescing", &["armed", "needs_attention", "cancelled"]),
    ("armed", &["trial_boot", "needs_attention", "rollback_pending"]),
    ("trial_boot", &["validating", "rollback_pending"]),
    ("validating", &["committed", "rollback_pending", "needs_attention"]),
    ("rollback_pending", &["rolled_back"]),
    ("needs_attention", &["cancelled", "rollback_pending", "validating"]),
];

pub fn update_edge_ok(from: &str, to: &str) -> bool {
    UPDATE_EDGES.iter().any(|(f, t)| *f == from && t.contains(&to))
}

impl Machine {
    pub fn add_trusted_key(&self, key_id: &str, pubkey_hex: &str, added_by: &str) -> R<()> {
        self.tx(|c| {
            if Self::insert_trusted_key(c, key_id, pubkey_hex, added_by)? {
                Self::audit(c, added_by, "release.key_added", Some(key_id), "trusted", None)?;
            }
            Ok(())
        })
    }

    /// Trust one key inside the caller's transaction (review R2-3). A key id that is already trusted is idempotent
    /// only with the very same public key; a different key under that id is a conflict, never silently ignored.
    /// Returns whether a row was added.
    fn insert_trusted_key(c: &rusqlite::Connection, key_id: &str, pubkey_hex: &str, added_by: &str) -> R<bool> {
        if key_id.is_empty() || key_id.len() > 64 || key_id.chars().any(|ch| ch.is_control()) {
            return Err(MErr::new("INVALID_REQUEST", "bad key id"));
        }
        if hex::decode(pubkey_hex).map(|b| b.len()).unwrap_or(0) != 32 {
            return Err(MErr::new("INVALID_REQUEST", "public key must be 32 bytes hex"));
        }
        let pk = pubkey_hex.to_ascii_lowercase();
        if c.query_row("SELECT 1 FROM revoked_keys WHERE key_id = ?1", [key_id], |_| Ok(())).optional()?.is_some() {
            return Err(MErr::new("UPDATE_SIGNATURE_INVALID", "key was revoked"));
        }
        let existing: Option<String> = c.query_row("SELECT public_key_hex FROM trusted_keys WHERE key_id = ?1", [key_id], |r| r.get(0)).optional()?;
        match existing {
            Some(e) if e.to_ascii_lowercase() == pk => Ok(false),
            Some(_) => Err(MErr::new("CONFLICT", format!("key id {key_id} is already trusted with a different public key"))),
            None => {
                c.execute("INSERT INTO trusted_keys (key_id, public_key_hex, added_by, added_at) VALUES (?1, ?2, ?3, ?4)", params![key_id, pk, added_by, now_ms()])?;
                Ok(true)
            }
        }
    }

    /// Key rotation signed by a currently trusted key (spec §20.1). One transaction (review R2-3): the signer is
    /// re-read inside it, the new key is trusted (with the conflict check), the listed keys are revoked and the audit
    /// row written together; any failure leaves the key set exactly as before.
    pub fn rotate_key(&self, statement: &Value, signed_by: &str, sig_hex: &str) -> R<()> {
        let o = statement.as_object().ok_or_else(|| MErr::new("INVALID_REQUEST", "rotation must be an object"))?;
        let new_id = o.get("newKeyId").and_then(|v| v.as_str()).ok_or_else(|| MErr::new("INVALID_REQUEST", "newKeyId"))?;
        let new_pk = o.get("newPublicKey").and_then(|v| v.as_str()).ok_or_else(|| MErr::new("INVALID_REQUEST", "newPublicKey"))?;
        let revoke: Vec<String> = o.get("revokeKeyIds").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        if revoke.iter().any(|k| k == new_id) {
            return Err(MErr::new("INVALID_REQUEST", "a rotation cannot revoke the key it introduces"));
        }
        let digest = hash(ROTATION_DOMAIN, statement);
        self.tx(|c| {
            if c.query_row("SELECT 1 FROM revoked_keys WHERE key_id = ?1", [signed_by], |_| Ok(())).optional()?.is_some() {
                return Err(MErr::new("UPDATE_SIGNATURE_INVALID", "signing key was revoked"));
            }
            let signer: String = c
                .query_row("SELECT public_key_hex FROM trusted_keys WHERE key_id = ?1", [signed_by], |r| r.get(0))
                .optional()?
                .ok_or_else(|| MErr::new("UPDATE_SIGNATURE_INVALID", "signing key is unknown"))?;
            verify_sig(&signer, &digest, sig_hex)?;
            Self::insert_trusted_key(c, new_id, new_pk, &format!("rotation:{signed_by}"))?;
            for k in &revoke {
                c.execute("INSERT OR IGNORE INTO revoked_keys (key_id, revoked_at) VALUES (?1, ?2)", params![k, now_ms()])?;
                c.execute("DELETE FROM trusted_keys WHERE key_id = ?1", [k])?;
            }
            #[cfg(test)]
            if ROTATE_FAULT.with(|f| f.replace(false)) {
                return Err(MErr::new("INTERNAL", "test fault: rotation interrupted before commit"));
            }
            Self::audit(c, "root", "release.key_rotated", Some(new_id), "rotated", None)
        })
    }

    fn trusted_key(&self, key_id: &str) -> R<String> {
        if self.c.query_row("SELECT 1 FROM revoked_keys WHERE key_id = ?1", [key_id], |_| Ok(())).optional()?.is_some() {
            return Err(MErr::new("UPDATE_SIGNATURE_INVALID", "signing key was revoked"));
        }
        self.c.query_row("SELECT public_key_hex FROM trusted_keys WHERE key_id = ?1", [key_id], |r| r.get(0)).optional()?.ok_or_else(|| MErr::new("UPDATE_SIGNATURE_INVALID", "signing key is unknown"))
    }

    /// Verify a manifest + detached signature. `trusted_time` must be true; without trusted time no new manifest is
    /// accepted automatically (spec §20.2). Replays below the high-water mark are refused.
    pub fn verify_release(&self, manifest: &Value, sig_hex: &str, trusted_time: bool) -> R<Value> {
        parse_manifest(manifest)?;
        let key = self.trusted_key(manifest["keyId"].as_str().unwrap_or_default())?;
        let digest = manifest_hash(manifest);
        verify_sig(&key, &digest, sig_hex)?;
        if !trusted_time {
            return Err(MErr::new("UPDATE_SIGNATURE_INVALID", "no trusted time; fix the clock or use the offline verification flow"));
        }
        let now = now_ms();
        if now > manifest["expiresAt"].as_i64().unwrap_or(0) || now > manifest["supportUntil"].as_i64().unwrap_or(0) {
            return Err(MErr::new("UPDATE_SIGNATURE_INVALID", "manifest expired or out of support"));
        }
        let hw: i64 = self.c.query_row("SELECT accepted_release_sequence FROM machine_meta WHERE id = 1", [], |r| r.get(0))?;
        let seq = manifest["releaseSequence"].as_i64().unwrap_or(0);
        let rid = manifest["releaseId"].as_str().unwrap_or_default();
        let known: Option<String> = self.c.query_row("SELECT manifest_hash FROM releases WHERE release_id = ?1", [rid], |r| r.get(0)).optional()?;
        if let Some(h) = known {
            if h != digest {
                return Err(MErr::new("RELEASE_REPLAYED", "release id reused with different content"));
            }
        } else if seq <= hw {
            return Err(MErr::new("RELEASE_REPLAYED", "release sequence is not above the accepted high-water mark"));
        }
        if manifest["migrationClass"] == "offline_breaking" {
            return Err(MErr::new("ROLLBACK_INCOMPATIBLE", "offline_breaking releases are not accepted by the ordinary updater"));
        }
        Ok(json!({ "releaseId": rid, "releaseSequence": seq, "manifestHash": digest }))
    }

    /// Record a verified release (does not raise the high-water mark until it is committed after a trial boot).
    pub fn register_release(&self, manifest: &Value, sig_hex: &str, trusted_time: bool) -> R<Value> {
        let v = self.verify_release(manifest, sig_hex, trusted_time)?;
        self.tx(|c| {
            c.execute(
                "INSERT OR IGNORE INTO releases (release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, verification_state, support_until, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'verified', ?7, ?8)",
                params![v["releaseId"].as_str(), v["manifestHash"].as_str(), v["releaseSequence"].as_i64(), manifest["baseClosurePath"].as_str(), canon(&manifest["compatibility"]), manifest["migrationClass"].as_str(), manifest["supportUntil"].as_i64(), now_ms()],
            )?;
            Self::audit(c, "root", "release.verified", v["releaseId"].as_str(), "verified", None)
        })?;
        Ok(v)
    }

    /// Installed base release (first boot or installer): becomes current and known-good without a trial.
    pub fn adopt_base_release(&self, manifest: &Value, sig_hex: &str, trusted_time: bool) -> R<Value> {
        let v = self.register_release(manifest, sig_hex, trusted_time)?;
        self.tx(|c| {
            c.execute("UPDATE machine_meta SET current_release_id = ?1, known_good_release_id = ?1, accepted_release_sequence = MAX(accepted_release_sequence, ?2) WHERE id = 1", params![v["releaseId"].as_str(), v["releaseSequence"].as_i64()])?;
            Ok(())
        })?;
        Ok(v)
    }

    pub fn release(&self, rid: &str) -> R<Value> {
        self.c
            .query_row("SELECT release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, support_until FROM releases WHERE release_id = ?1", [rid], |r| {
                Ok(json!({ "releaseId": r.get::<_, String>(0)?, "manifestHash": r.get::<_, String>(1)?, "releaseSequence": r.get::<_, i64>(2)?, "closurePath": r.get::<_, String>(3)?,
                    "compatibility": serde_json::from_str::<Value>(&r.get::<_, String>(4)?).unwrap_or(Value::Null), "migrationClass": r.get::<_, String>(5)?, "supportUntil": r.get::<_, i64>(6)? }))
            })
            .optional()?
            .ok_or_else(|| MErr::new("NOT_FOUND_OR_FORBIDDEN", "unknown release"))
    }

    pub fn open_update(&self, update_id: &str, to_release: &str, plan: &Value) -> R<Value> {
        if !is_uuid(update_id) {
            return Err(MErr::new("INVALID_REQUEST", "updateId must be a uuid"));
        }
        self.release(to_release)?;
        let from: Option<String> = self.c.query_row("SELECT current_release_id FROM machine_meta WHERE id = 1", [], |r| r.get(0))?;
        let plan_hash = hash("agentos.machine.update.plan.v1", plan);
        self.tx(|c| {
            if let Some((t, ph)) = c.query_row("SELECT to_release_id, plan_hash FROM update_jobs WHERE update_id = ?1", [update_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).optional()? {
                if t != to_release || ph != plan_hash {
                    return Err(MErr::new("CONFLICT", "updateId reused with another plan"));
                }
                return Ok(());
            }
            c.execute(
                "INSERT INTO update_jobs (update_id, from_release_id, to_release_id, plan_hash, state, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'verified', ?5, ?5)",
                params![update_id, from, to_release, plan_hash, now_ms()],
            )
            .map_err(|e| match MErr::from(e) {
                m if m.code == "CONFLICT" => MErr::new("CONFLICT", "another update is already open"),
                m => m,
            })?;
            Self::audit(c, "root", "update.open", Some(update_id), "verified", None)
        })?;
        self.update(update_id)
    }

    pub fn update(&self, update_id: &str) -> R<Value> {
        self.c
            .query_row(
                "SELECT update_id, from_release_id, to_release_id, plan_hash, state, trial_boot_id, previous_entry_id, candidate_entry_id, checkpoint_set_id, barrier_id, error_json FROM update_jobs WHERE update_id = ?1",
                [update_id],
                |r| {
                    Ok(json!({ "updateId": r.get::<_, String>(0)?, "fromReleaseId": r.get::<_, Option<String>>(1)?, "toReleaseId": r.get::<_, String>(2)?, "planHash": r.get::<_, String>(3)?,
                        "state": r.get::<_, String>(4)?, "trialBootId": r.get::<_, Option<String>>(5)?, "previousEntryId": r.get::<_, Option<String>>(6)?, "candidateEntryId": r.get::<_, Option<String>>(7)?,
                        "checkpointSetId": r.get::<_, Option<String>>(8)?, "barrierId": r.get::<_, Option<String>>(9)?, "error": r.get::<_, Option<String>>(10)?.and_then(|t| serde_json::from_str::<Value>(&t).ok()) }))
                },
            )
            .optional()?
            .ok_or_else(MErr::hidden)
            .and_then(|mut v| {
                v["commitIntent"] = json!(self.commit_intent_recorded(update_id)?);
                Ok(v)
            })
    }

    /// The commit intent of an update (spec §21.3 step 7, V1-U10): written once, in its own transaction, after the
    /// trial boot passed its health gate and before the worker writes the persistent default. It lives in the
    /// append-only root audit, so a crash anywhere after it resolves from facts: default not yet the candidate →
    /// write it again; default already the candidate → finish the commit. Only a validating update takes it.
    pub fn record_commit_intent(&self, update_id: &str) -> R<Value> {
        self.tx(|c| {
            let st: String = c.query_row("SELECT state FROM update_jobs WHERE update_id = ?1", [update_id], |r| r.get(0)).optional()?.ok_or_else(MErr::hidden)?;
            let have: i64 = c.query_row("SELECT COUNT(*) FROM root_audit WHERE kind = 'update.commit_intent' AND scope_id = ?1", [update_id], |r| r.get(0))?;
            if have > 0 {
                return Ok(());
            }
            if st != "validating" {
                return Err(MErr::new("CONFLICT", format!("a commit intent needs a validating update (this one is {st})")));
            }
            Self::audit(c, "root", "update.commit_intent", Some(update_id), "recorded", None)
        })?;
        self.update(update_id)
    }

    pub fn commit_intent_recorded(&self, update_id: &str) -> R<bool> {
        Ok(self.c.query_row("SELECT COUNT(*) FROM root_audit WHERE kind = 'update.commit_intent' AND scope_id = ?1", [update_id], |r| r.get::<_, i64>(0))? > 0)
    }

    pub fn open_update_id(&self) -> R<Option<String>> {
        Ok(self.c.query_row("SELECT update_id FROM update_jobs WHERE state NOT IN ('committed','cancelled','failed_no_switch','rolled_back')", [], |r| r.get(0)).optional()?)
    }

    /// Persisted transition with the fields that step records. Repeating the same transition is a no-op (re-entry).
    pub fn advance_update(&self, update_id: &str, to: &str, fields: &Value) -> R<Value> {
        self.tx(|c| {
            let cur: String = c.query_row("SELECT state FROM update_jobs WHERE update_id = ?1", [update_id], |r| r.get(0)).optional()?.ok_or_else(MErr::hidden)?;
            if cur == to && to != "downloading" {
                return Ok(());
            }
            if !update_edge_ok(&cur, to) {
                return Err(MErr::new("CONFLICT", format!("update cannot move {cur} → {to}")));
            }
            c.execute("UPDATE update_jobs SET state = ?2, updated_at = ?3 WHERE update_id = ?1", params![update_id, to, now_ms()])?;
            for (k, col) in [("trialBootId", "trial_boot_id"), ("previousEntryId", "previous_entry_id"), ("candidateEntryId", "candidate_entry_id"), ("checkpointSetId", "checkpoint_set_id"), ("barrierId", "barrier_id")] {
                if let Some(v) = fields.get(k).and_then(|v| v.as_str()) {
                    c.execute(&format!("UPDATE update_jobs SET {col} = ?2 WHERE update_id = ?1"), params![update_id, v])?;
                }
            }
            if let Some(e) = fields.get("error") {
                c.execute("UPDATE update_jobs SET error_json = ?2 WHERE update_id = ?1", params![update_id, canon(e)])?;
            }
            if to == "committed" {
                let (rid, seq): (String, i64) = c.query_row("SELECT u.to_release_id, r.release_sequence FROM update_jobs u JOIN releases r ON r.release_id = u.to_release_id WHERE u.update_id = ?1", [update_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
                c.execute("UPDATE machine_meta SET current_release_id = ?1, known_good_release_id = ?1, accepted_release_sequence = MAX(accepted_release_sequence, ?2) WHERE id = 1", params![rid, seq])?;
            }
            if matches!(to, "committed" | "cancelled" | "failed_no_switch" | "rolled_back") {
                c.execute("UPDATE barriers SET state = 'released', released_at = ?2 WHERE owner_kind = 'update' AND owner_id = ?1 AND state = 'held'", params![update_id, now_ms()])?;
            }
            Self::audit(c, "root", "update.state", Some(update_id), to, None)
        })?;
        if to == "committed" {
            // the deferred schema migration runs only now that the new generation is the default (U10/U11)
            crate::db::migrate(&self.c)?;
        }
        self.update(update_id)
    }

    /// Live data versions this machine holds now (spec §20.3 compatibility ranges).
    pub fn live_versions(&self) -> Value {
        json!({ "machineSchema": crate::db::live_schema(&self.c), "workspaceSchema": 5, "brokerSchema": 4, "brokerProtocol": 3, "nativeRpc": 1 })
    }

    /// V1-U11: a switch to another release (known-good rollback included) is allowed only when that release declares
    /// every live data version inside its compatibility ranges; otherwise it is refused before anything boots it.
    pub fn check_compatible(&self, rid: &str) -> R<()> {
        let rel = self.release(rid)?;
        let live = self.live_versions();
        for (k, v) in live.as_object().unwrap() {
            let r = &rel["compatibility"][k];
            let (lo, hi) = (r[0].as_i64().unwrap_or(i64::MAX), r[1].as_i64().unwrap_or(i64::MIN));
            let v = v.as_i64().unwrap_or(0);
            if v < lo || v > hi {
                return Err(MErr::new("ROLLBACK_INCOMPATIBLE", format!("release {rid} supports {k} {lo}..{hi}; this machine holds {v}")));
            }
        }
        Ok(())
    }

    /// Known-good rollback is a separate authorised recovery action; it never lowers the high-water mark (V1-U05).
    pub fn set_current_release(&self, rid: &str, as_known_good: bool) -> R<()> {
        self.check_compatible(rid)?;
        self.tx(|c| {
            if as_known_good {
                c.execute("UPDATE machine_meta SET current_release_id = ?1, known_good_release_id = ?1 WHERE id = 1", [rid])?;
            } else {
                c.execute("UPDATE machine_meta SET current_release_id = ?1 WHERE id = 1", [rid])?;
            }
            Self::audit(c, "root", "release.current", Some(rid), "set", None)
        })
    }
}

/// OCI content binding (review R2-1, spec §20.1 "OCI digest 列表"): the signed manifest's sbomHash pins the SBOM, the
/// SBOM's `ociArchive` pins the archive bytes (sha256) and lists the image IDs; the shipped index must name exactly
/// the signed ociDigests, the archive bytes must hash to the SBOM value, and the image IDs recomputed by importing
/// the archive into an isolated store must be exactly the signed ociDigests. `imported` is None only when the caller
/// has not imported yet (then only the static checks run).
pub fn check_oci_bundle(manifest: &Value, sbom_bytes: &[u8], index: &Value, archive_sha256: &str, imported: Option<&[String]>) -> R<()> {
    use sha2::{Digest, Sha256};
    let bad = |m: String| MErr::new("UPDATE_CONTENT_MISMATCH", m);
    let sorted = |v: &Value| -> Vec<String> {
        let mut x: Vec<String> = v.as_array().cloned().unwrap_or_default().iter().filter_map(|i| i.as_str().map(String::from)).collect();
        x.sort();
        x
    };
    let want = sorted(&manifest["ociDigests"]);
    let sh = format!("sha256:{}", hex::encode(Sha256::digest(sbom_bytes)));
    if manifest["sbomHash"].as_str() != Some(sh.as_str()) {
        return Err(bad(format!("sbom.json hashes to {sh}, the signed sbomHash is {}", manifest["sbomHash"])));
    }
    let sbom: Value = serde_json::from_slice(sbom_bytes).map_err(|_| bad("sbom.json is not JSON".into()))?;
    let oa = &sbom["ociArchive"];
    if !oa.is_object() {
        return Err(bad("the signed SBOM carries no ociArchive entry".into()));
    }
    if sorted(&oa["imageIds"]) != want {
        return Err(bad("the SBOM's OCI image IDs are not exactly the signed ociDigests".into()));
    }
    let mut got: Vec<String> = index["images"].as_array().cloned().unwrap_or_default().iter().filter_map(|i| i["imageId"].as_str().map(String::from)).collect();
    got.sort();
    if got != want {
        return Err(bad("the shipped OCI index does not name exactly the signed ociDigests".into()));
    }
    if oa["sha256"].as_str() != Some(archive_sha256) {
        return Err(bad(format!("the OCI archive hashes to {archive_sha256}, the signed SBOM says {}", oa["sha256"])));
    }
    if let Some(ids) = imported {
        let mut ids: Vec<String> = ids.iter().map(|i| if i.starts_with("sha256:") { i.clone() } else { format!("sha256:{i}") }).collect();
        ids.sort();
        ids.dedup();
        if ids != want {
            return Err(bad(format!("importing the archive gave image IDs {ids:?}, not the signed ociDigests")));
        }
    }
    Ok(())
}
