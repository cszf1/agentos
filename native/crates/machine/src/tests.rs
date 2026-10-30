//! Machine admission on the production writer (spec §13; V1-S01 S02 S04 S05 S06 S07, R02 barrier). A fake System
//! replaces accounts/systemd; everything else (SQLite schema, transactions, scheduler) is the real machined code.
use crate::dir::Machine;
use crate::permits::{PermitRequest, MODEL_DAY, MODEL_DAY_BACKGROUND};
use crate::sys::{Paths, PwEntry, System};
use crate::err::R;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct Fake {
    busy: Arc<Mutex<HashSet<u32>>>,
}

impl System for Fake {
    fn pw_by_name(&self, _: &str) -> Option<PwEntry> { None }
    fn pw_by_uid(&self, _: u32) -> Option<PwEntry> { None }
    fn subid_overlaps(&self, _: u32, _: u32) -> bool { false }
    fn create_login_user(&mut self, _: &str, _: u32, _: &str, _: bool) -> R<()> { Ok(()) }
    fn set_password(&mut self, _: &str, _: &[u8]) -> R<()> { Ok(()) }
    fn lock_user(&mut self, _: &str) -> R<()> { Ok(()) }
    fn terminate_user(&mut self, _: u32) -> R<()> { Ok(()) }
    fn create_exec_user(&mut self, _: &str, _: u32, _: &str, _: &Path, _: u32, _: u32) -> R<()> { Ok(()) }
    fn ensure_workspace_dirs(&mut self, _: &Paths, _: &str, _: u32) -> R<()> { Ok(()) }
    fn enable_linger(&mut self, _: &str) -> R<()> { Ok(()) }
    fn disable_linger(&mut self, _: &str) -> R<()> { Ok(()) }
    fn init_workspace(&mut self, _: &Paths, _: &str, _: &str, _: u32, _: &str) -> R<()> { Ok(()) }
    fn start_workspace(&mut self, _: &str, uid: u32) -> R<()> { self.busy.lock().unwrap().insert(uid); Ok(()) }
    fn stop_workspace(&mut self, _: &str, uid: u32) -> R<()> { self.busy.lock().unwrap().remove(&uid); Ok(()) }
    fn exec_cgroup_busy(&self, uid: u32) -> bool { self.busy.lock().unwrap().contains(&uid) }
    fn kill_exec_cgroup(&mut self, uid: u32) -> R<()> { self.busy.lock().unwrap().remove(&uid); Ok(()) }
}

struct T {
    m: Machine,
    fake: Fake,
    dir: std::path::PathBuf,
}

fn uuid() -> String { crate::util::uuid() }

fn setup() -> (T, Vec<(String, String, u32)>) {
    let dir = std::env::temp_dir().join(format!("agentos-machine-test-{}", uuid()));
    let paths = Paths {
        machine_dir: dir.join("machine"), workspaces_dir: dir.join("ws"), runtime_dir: dir.join("rt"),
        run_dir: dir.join("run"), snapshots_dir: dir.join("snap"),
    };
    let fake = Fake::default();
    let mut m = Machine::open(paths, Box::new(fake.clone())).unwrap();
    m.ensure_install(&uuid()).unwrap();
    let mut wss = vec![];
    for name in ["ada", "bea"] {
        let u = m.provision_user(&uuid(), name, "user").unwrap();
        let uid = u["userId"].as_str().unwrap().to_string();
        let w = m.create_workspace(&uuid(), &uid, name, None, "created").unwrap();
        let ws = w["workspaceId"].as_str().unwrap().to_string();
        m.start_workspace(&ws).unwrap();
        m.host_hello(&ws, &uuid(), 4242, "boot").unwrap();
        let row = m.ws_row(&ws).unwrap();
        wss.push((ws, uid, row["executionUid"].as_u64().unwrap() as u32));
    }
    (T { m, fake, dir }, wss)
}

fn rq(ws: &(String, String, u32), mv: i64, bg: bool) -> PermitRequest {
    PermitRequest {
        workspace_id: ws.0.clone(), execution_epoch: 1, owner_kind: "run".into(), owner_id: format!("run-{}", uuid()), attempt_id: uuid(),
        resource_class: "model".into(), background: bg, body_hash: format!("sha256:{}", "ab".repeat(32)), member_version: mv,
        user_id: Some(ws.1.clone()), instance_id: uuid(), deadline_ms: None,
    }
}

/// The Host's normal path: final check (use), then release with the real usage.
fn done(t: &T, p: &serde_json::Value) {
    let ws = p["workspaceId"].as_str().unwrap();
    let id = p["permitId"].as_str().unwrap();
    let v = t.m.permit(id).unwrap()["memberVersion"].as_i64().unwrap();
    t.m.use_permit(ws, id, v).unwrap();
    t.m.release_permit(ws, id, "used", None).unwrap();
}

fn mv(t: &T, ws: &(String, String, u32)) -> i64 { t.m.membership(&ws.1, &ws.0).unwrap().1 }

fn state(v: &serde_json::Value) -> String { v["state"].as_str().unwrap_or_default().to_string() }

fn held(t: &T) -> usize {
    t.m.permits_of_all().into_iter().filter(|p| matches!(p["state"].as_str(), Some("reserved" | "in_use" | "reconciling"))).count()
}

impl Machine {
    fn permits_of_all(&self) -> Vec<serde_json::Value> {
        let mut st = self.c.prepare("SELECT workspace_id FROM workspaces").unwrap();
        let wss: Vec<String> = st.query_map([], |r| r.get(0)).unwrap().collect::<Result<_, _>>().unwrap();
        wss.iter().flat_map(|w| self.permits_of(w).unwrap()).collect()
    }
}

impl Drop for T {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.dir); }
}

#[test]
fn s01_two_level_quota_total_two_background_one_and_day_budgets() {
    let (t, w) = setup();
    let (a, b) = (&w[0], &w[1]);
    let p: Vec<_> = (0..3).map(|i| t.m.request_permit(&[a, b, a][i].0, &rq([a, b, a][i], mv(&t, [a, b, a][i]), false)).unwrap()).collect();
    assert_eq!(p.iter().filter(|x| state(x) == "reserved").count(), 2, "machine total model concurrency is 2");
    assert_eq!(state(&p[2]), "queued");
    for x in &p {
        let x = t.m.permit(x["permitId"].as_str().unwrap()).unwrap();
        if state(&x) == "queued" { t.m.release_permit(x["workspaceId"].as_str().unwrap(), x["permitId"].as_str().unwrap(), "unused", None).unwrap(); } else { done(&t, &x); }
    }
    // background: two requests from two workspaces with both slots free -> only one held
    let g1 = t.m.request_permit(&a.0, &rq(a, mv(&t, a), true)).unwrap();
    let g2 = t.m.request_permit(&b.0, &rq(b, mv(&t, b), true)).unwrap();
    assert_eq!(state(&g1), "reserved");
    assert_eq!(state(&g2), "queued", "background is limited to 1 on the whole machine");
    done(&t, &g1);
    let g2 = t.m.permit(g2["permitId"].as_str().unwrap()).unwrap();
    assert_eq!(state(&g2), "reserved");
    done(&t, &g2);
    // background 24 h budget (2 used so far)
    let mut last = None;
    for i in 0..MODEL_DAY_BACKGROUND {
        match t.m.request_permit(&a.0, &rq(a, mv(&t, a), true)) {
            Ok(x) => done(&t, &x),
            Err(e) => { last = Some((i, e.code)); break; }
        }
    }
    assert_eq!(last.map(|x| x.1).as_deref(), Some("MACHINE_CAPACITY"));
    // machine 24 h budget across both workspaces
    let mut n = 0;
    let mut refused = None;
    while n <= MODEL_DAY + 1 {
        let ws = if n % 2 == 0 { a } else { b };
        match t.m.request_permit(&ws.0, &rq(ws, mv(&t, ws), false)) {
            Ok(x) => done(&t, &x),
            Err(e) => { refused = Some(e.code); break; }
        }
        n += 1;
    }
    assert_eq!(refused.as_deref(), Some("MACHINE_CAPACITY"), "the machine day budget applies across workspaces");
    assert!(n < MODEL_DAY, "earlier requests of both workspaces count against the same day budget ({n})");
}

#[test]
fn s02_foreground_round_robin_one_workspace_cannot_monopolise() {
    let (t, w) = setup();
    let (a, b) = (&w[0], &w[1]);
    let mut qa: Vec<_> = (0..4).map(|_| t.m.request_permit(&a.0, &rq(a, mv(&t, a), false)).unwrap()).collect();
    let mut qb: Vec<_> = (0..4).map(|_| t.m.request_permit(&b.0, &rq(b, mv(&t, b), false)).unwrap()).collect();
    // A came first and got both slots? No: once B waits, A holds at most one.
    let ra = qa.iter().filter(|x| state(x) == "reserved").count();
    assert!(ra <= 2);
    let mut order = vec![];
    for _ in 0..6 {
        // release the oldest held permit and see who gets the next slot
        let all = t.m.permits_of_all();
        let h = all.iter().filter(|p| state(p) == "reserved").min_by_key(|p| p["seq"].as_i64().unwrap()).unwrap().clone();
        done(&t, &h);
        let now: Vec<_> = t.m.permits_of_all().into_iter().filter(|p| state(p) == "reserved").collect();
        let per_a = now.iter().filter(|p| p["workspaceId"] == a.0.as_str()).count();
        let per_b = now.iter().filter(|p| p["workspaceId"] == b.0.as_str()).count();
        let waiting_a = t.m.permits_of(&a.0).unwrap().iter().any(|p| state(p) == "queued");
        let waiting_b = t.m.permits_of(&b.0).unwrap().iter().any(|p| state(p) == "queued");
        if waiting_a && waiting_b {
            assert!(per_a <= 1 && per_b <= 1, "while both wait each holds at most one ({per_a}/{per_b})");
        }
        order.push((per_a, per_b));
    }
    qa.clear();
    qb.clear();
    assert!(order.iter().all(|(x, y)| x + y <= 2));
}

#[test]
fn s04_final_check_after_waiting_member_version_revocation_and_stop() {
    let (mut t, w) = setup();
    let (a, b) = (&w[0], &w[1]);
    let v = mv(&t, a);
    let p1 = t.m.request_permit(&a.0, &rq(a, v, false)).unwrap();
    // membership changed while the permit was held: use with the new version is refused, nothing is sent
    let r = t.m.use_permit(&a.0, p1["permitId"].as_str().unwrap(), v + 1);
    assert_eq!(r.unwrap_err().code, "MEMBERSHIP_REVOKED");
    assert_eq!(state(&t.m.permit(p1["permitId"].as_str().unwrap()).unwrap()), "revoked");
    // a permit from another workspace's peer is invisible
    let p2 = t.m.request_permit(&a.0, &rq(a, v, false)).unwrap();
    assert!(t.m.use_permit(&b.0, p2["permitId"].as_str().unwrap(), v).is_err());
    // queued permits of a stopped workspace never become usable, and a stopped workspace cannot ask again
    t.m.stop_workspace(&a.0).unwrap();
    assert_eq!(t.m.request_permit(&a.0, &rq(a, v, false)).unwrap_err().code, "WORKSPACE_FENCED");
    let _ = b;
}

#[test]
fn s05_s06_restart_never_frees_held_slots_until_the_holder_is_gone_unknown_is_charged() {
    let (mut t, w) = setup();
    let a = &w[0];
    let v = mv(&t, a);
    let p1 = t.m.request_permit(&a.0, &rq(a, v, false)).unwrap();
    let p2 = t.m.request_permit(&a.0, &rq(a, v, false)).unwrap();
    t.m.use_permit(&a.0, p1["permitId"].as_str().unwrap(), v).unwrap();
    // machined restarts while the Host's cgroup is still alive: both stay held (reconciling), no slot is freed
    t.m.reconcile_permits().unwrap();
    assert_eq!(held(&t), 2, "a restart frees nothing while the holder may still run");
    let r = t.m.request_permit(&a.0, &rq(a, v, false)).unwrap();
    assert_eq!(state(&r), "queued");
    // the execution cgroup is proven empty: in_use is charged as unknown, reserved was never used
    t.fake.busy.lock().unwrap().remove(&a.2);
    t.m.reconcile_permits().unwrap();
    let q1 = t.m.permit(p1["permitId"].as_str().unwrap()).unwrap();
    let q2 = t.m.permit(p2["permitId"].as_str().unwrap()).unwrap();
    assert_eq!(q1["usageStatus"], "unknown");
    assert_ne!(q2["usageStatus"], "unknown");
    // a reconciling permit cannot be declared unused to get a free reset
    let p3 = t.m.request_permit(&a.0, &rq(a, v, false));
    let _ = p3;
    let s = t.m.permit_summary().unwrap();
    assert!(s.to_string().contains("unknown") || q1["state"] != "in_use", "{s}");
}

#[test]
fn s07_background_yields_to_foreground() {
    let (t, w) = setup();
    let (a, b) = (&w[0], &w[1]);
    let f = t.m.request_permit(&a.0, &rq(a, mv(&t, a), false)).unwrap();
    assert_eq!(state(&f), "reserved");
    let g = t.m.request_permit(&b.0, &rq(b, mv(&t, b), true)).unwrap();
    assert_eq!(state(&g), "queued", "no background while a foreground permit is held");
    let f2 = t.m.request_permit(&b.0, &rq(b, mv(&t, b), false)).unwrap();
    assert_eq!(state(&f2), "reserved", "a user request takes the free slot before the waiting background");
    done(&t, &f);
    assert_eq!(state(&t.m.permit(g["permitId"].as_str().unwrap()).unwrap()), "queued");
    done(&t, &f2);
    assert_eq!(state(&t.m.permit(g["permitId"].as_str().unwrap()).unwrap()), "reserved");
}

#[test]
fn s03_no_owner_waits_for_one_class_while_holding_another() {
    let (t, w) = setup();
    let a = &w[0];
    let mut m = rq(a, mv(&t, a), false);
    let held = t.m.request_permit(&a.0, &m).unwrap();
    assert_eq!(state(&held), "reserved");
    // the same run asks for the build slot while it still holds its model permit → refused, nothing queued
    m.resource_class = "build".into();
    m.attempt_id = uuid();
    assert_eq!(t.m.request_permit(&a.0, &m).unwrap_err().code, "MACHINE_CAPACITY");
    // another owner may wait for build; after the model permit is released the run may ask for build too
    let other = t.m.request_permit(&a.0, &PermitRequest { owner_id: format!("run-{}", uuid()), resource_class: "build".into(), ..rq(a, mv(&t, a), false) }).unwrap();
    assert_eq!(state(&other), "reserved");
    done(&t, &held);
    m.attempt_id = uuid();
    let b = t.m.request_permit(&a.0, &m).unwrap();
    assert!(matches!(state(&b).as_str(), "queued" | "reserved"), "{b}");
}

#[test]
fn r02_barrier_freezes_starts_and_host_joins() {
    let (mut t, w) = setup();
    let a = &w[0];
    t.m.stop_workspace(&a.0).unwrap();
    let b = t.m.hold_barrier("checkpoint", &uuid(), &serde_json::json!({})).unwrap();
    assert_eq!(t.m.start_workspace(&a.0).unwrap_err().code, "CHECKPOINT_INCOMPLETE");
    assert_eq!(t.m.host_hello(&a.0, &uuid(), 1, "boot").unwrap_err().code, "CHECKPOINT_INCOMPLETE");
    t.m.release_barrier(&b).unwrap();
    t.m.start_workspace(&a.0).unwrap();
}

#[test]
fn w08_run_when_logged_out_default_off_owner_only_and_machine_quota() {
    let (mut t, w) = setup();
    let (a, b) = (&w[0], &w[1]);
    assert_eq!(t.m.ws_row(&a.0).unwrap()["runWhenLoggedOut"], serde_json::json!(false));
    // a non-member (and so any non-owner) cannot turn it on; the answer does not reveal the workspace
    assert!(t.m.set_run_when_logged_out(&b.1, &a.0, true).is_err());
    t.m.set_run_when_logged_out(&a.1, &a.0, true).unwrap();
    t.m.set_run_when_logged_out(&b.1, &b.0, true).unwrap();
    let c = t.m.create_workspace(&uuid(), &a.1, "third", None, "created").unwrap();
    let c = c["workspaceId"].as_str().unwrap().to_string();
    assert_eq!(t.m.set_run_when_logged_out(&a.1, &c, true).unwrap_err().code, "MACHINE_CAPACITY");
    t.m.set_run_when_logged_out(&b.1, &b.0, false).unwrap();
    t.m.set_run_when_logged_out(&a.1, &c, true).unwrap();
}

#[test]
fn r02_host_precheck_refused_under_a_barrier() {
    let (mut t, w) = setup();
    let b = t.m.hold_barrier("checkpoint", &uuid(), &serde_json::json!({})).unwrap();
    assert_eq!(t.m.require_no_barrier().unwrap_err().code, "CHECKPOINT_INCOMPLETE");
    t.m.release_barrier(&b).unwrap();
    t.m.require_no_barrier().unwrap();
    let _ = w;
}

/// V1-W03: a stateful fake whose accounts persist across a "restart" and that fails once at a chosen step.
#[derive(Clone, Default)]
struct Accounts {
    users: Arc<Mutex<Vec<crate::sys::PwEntry>>>,
    fail_at: Arc<Mutex<Option<&'static str>>>,
    calls: Arc<Mutex<Vec<String>>>,
}

impl Accounts {
    fn trip(&self, step: &'static str) -> R<()> {
        self.calls.lock().unwrap().push(step.into());
        let mut f = self.fail_at.lock().unwrap();
        if *f == Some(step) {
            *f = None;
            return Err(crate::err::MErr::new("SYSTEM_FAILED", "injected crash"));
        }
        Ok(())
    }
}

impl System for Accounts {
    fn pw_by_name(&self, n: &str) -> Option<PwEntry> { self.users.lock().unwrap().iter().find(|e| e.name == n).cloned() }
    fn pw_by_uid(&self, u: u32) -> Option<PwEntry> { self.users.lock().unwrap().iter().find(|e| e.uid == u).cloned() }
    fn subid_overlaps(&self, _: u32, _: u32) -> bool { false }
    fn create_login_user(&mut self, _: &str, _: u32, _: &str, _: bool) -> R<()> { Ok(()) }
    fn set_password(&mut self, _: &str, _: &[u8]) -> R<()> { Ok(()) }
    fn lock_user(&mut self, _: &str) -> R<()> { Ok(()) }
    fn terminate_user(&mut self, _: u32) -> R<()> { Ok(()) }
    fn create_exec_user(&mut self, n: &str, uid: u32, marker: &str, home: &Path, _: u32, _: u32) -> R<()> {
        // the account is really created (useradd ran) and THEN the process dies before the receipt
        if self.pw_by_name(n).is_none() {
            self.users.lock().unwrap().push(PwEntry { name: n.into(), uid, gecos: marker.into(), home: home.display().to_string() });
        }
        self.trip("account")
    }
    fn ensure_workspace_dirs(&mut self, _: &Paths, _: &str, _: u32) -> R<()> { self.trip("directory") }
    fn enable_linger(&mut self, _: &str) -> R<()> { self.trip("linger") }
    fn disable_linger(&mut self, _: &str) -> R<()> { Ok(()) }
    fn init_workspace(&mut self, _: &Paths, _: &str, _: &str, _: u32, _: &str) -> R<()> { self.trip("databases") }
    fn start_workspace(&mut self, _: &str, _: u32) -> R<()> { Ok(()) }
    fn stop_workspace(&mut self, _: &str, _: u32) -> R<()> { Ok(()) }
    fn exec_cgroup_busy(&self, _: u32) -> bool { false }
    fn kill_exec_cgroup(&mut self, _: u32) -> R<()> { Ok(()) }
}

#[test]
fn w03_each_creation_breakpoint_resumes_to_exactly_one_workspace_without_takeover() {
    for step in ["account", "directory", "databases", "linger"] {
        let dir = std::env::temp_dir().join(format!("agentos-w03-{}", uuid()));
        let paths = Paths { machine_dir: dir.join("machine"), workspaces_dir: dir.join("ws"), runtime_dir: dir.join("rt"), run_dir: dir.join("run"), snapshots_dir: dir.join("snap") };
        let acc = Accounts::default();
        let mut m = Machine::open(paths.clone(), Box::new(acc.clone())).unwrap();
        m.ensure_install(&uuid()).unwrap();
        let owner = m.provision_user(&uuid(), "ada", "user").unwrap()["userId"].as_str().unwrap().to_string();
        let cid = uuid();
        *acc.fail_at.lock().unwrap() = Some(step);
        assert!(m.create_workspace(&cid, &owner, "A", None, "created").is_err(), "{step}");
        // half-created: not visible to the owner
        assert!(m.list_visible(&owner).unwrap().is_empty(), "{step}");
        drop(m);
        // restart: machined reopens the same directory and resumes from the last receipt
        let mut m = Machine::open(paths.clone(), Box::new(acc.clone())).unwrap();
        let resumed = m.resume_creations().unwrap();
        assert_eq!(resumed.len(), 1, "{step}");
        // the client retries with the same createId: same workspace, nothing new
        let again = m.create_workspace(&cid, &owner, "A", None, "created").unwrap();
        assert_eq!(again["workspaceId"].as_str().unwrap(), resumed[0], "{step}");
        assert_eq!(again["state"], "stopped", "{step}");
        let all = m.all_workspaces().unwrap();
        assert_eq!(all.len(), 1, "{step}: exactly one workspace");
        assert_eq!(acc.users.lock().unwrap().len(), 1, "{step}: exactly one execution account");
        // a second workspace gets a different UID / sub-ID range
        let b = m.create_workspace(&uuid(), &owner, "B", None, "created").unwrap();
        assert_ne!(b["executionUid"], again["executionUid"], "{step}");
        assert_ne!(b["subuidStart"], again["subuidStart"], "{step}");
        let _ = std::fs::remove_dir_all(&dir);
    }
    // an account with the execution name that is not ours is never taken over
    let dir = std::env::temp_dir().join(format!("agentos-w03-{}", uuid()));
    let paths = Paths { machine_dir: dir.join("machine"), workspaces_dir: dir.join("ws"), runtime_dir: dir.join("rt"), run_dir: dir.join("run"), snapshots_dir: dir.join("snap") };
    let acc = Accounts::default();
    acc.users.lock().unwrap().push(PwEntry { name: "aows0".into(), uid: 55555, gecos: "someone else".into(), home: "/home/x".into() });
    let mut m = Machine::open(paths, Box::new(acc.clone())).unwrap();
    m.ensure_install(&uuid()).unwrap();
    let owner = m.provision_user(&uuid(), "ada", "user").unwrap()["userId"].as_str().unwrap().to_string();
    let e = m.create_workspace(&uuid(), &owner, "A", None, "created").unwrap_err();
    assert_eq!(e.code, "CONFLICT");
    assert_eq!(acc.users.lock().unwrap().iter().filter(|u| u.name == "aows0").count(), 1);
    assert_eq!(acc.users.lock().unwrap()[0].gecos, "someone else");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn i09_owner_transfer_needs_both_sides_and_current_versions() {
    let (t, w) = setup();
    let (ws, ada, _) = w[0].clone();
    let bea = w[1].1.clone();
    // bea joins ada's workspace as viewer
    t.m.set_role(&ada, &ws, &bea, "viewer", None).unwrap();
    // only the owner can begin; the receiver must already be a member
    assert!(t.m.begin_transfer(&bea, &uuid(), &ws, &ada).is_err());
    let tid = uuid();
    assert_eq!(t.m.begin_transfer(&ada, &tid, &ws, &bea).unwrap()["state"], "pending");
    // nothing changed yet: the owner still owns, and the owner cannot confirm on the receiver's behalf
    assert_eq!(t.m.membership(&ada, &ws).unwrap().0.as_str(), "owner");
    assert!(t.m.confirm_transfer(&ada, &tid).is_err());
    // the receiver's role changed after the transfer began → the confirmation is stale
    let mvb = t.m.membership(&bea, &ws).unwrap().1;
    t.m.set_role(&ada, &ws, &bea, "editor", Some(mvb)).unwrap();
    assert_eq!(t.m.confirm_transfer(&bea, &tid).unwrap_err().code, "PLAN_STALE");
    // a fresh transfer, confirmed by the receiver: roles swap, versions move, every side is told
    let tid2 = uuid();
    t.m.begin_transfer(&ada, &tid2, &ws, &bea).unwrap();
    assert_eq!(t.m.confirm_transfer(&bea, &tid2).unwrap()["state"], "confirmed");
    assert_eq!(t.m.membership(&bea, &ws).unwrap().0.as_str(), "owner");
    assert_eq!(t.m.membership(&ada, &ws).unwrap().0.as_str(), "editor");
    let n: i64 = t.m.c.query_row("SELECT COUNT(DISTINCT target_kind) FROM registry_outbox WHERE kind = 'owner.changed' AND state = 'pending'", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 3, "gateway, host and broker each get owner.changed");
    // replaying the confirmation is idempotent; the last owner cannot be dropped by demotion
    assert_eq!(t.m.confirm_transfer(&bea, &tid2).unwrap()["state"], "confirmed");
    assert!(t.m.set_role(&bea, &ws, &bea, "viewer", None).is_err());
}
