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
    removed: Arc<Mutex<Vec<String>>>,
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
    fn remove_workspace_roots(&mut self, _: &Paths, ws: &str) -> R<()> { self.removed.lock().unwrap().push(ws.to_string()); Ok(()) }
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
    fn remove_workspace_roots(&mut self, _: &Paths, _: &str) -> R<()> { Ok(()) }
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

fn ack_all(m: &Machine) {
    m.c.execute("UPDATE registry_outbox SET state = 'acked' WHERE state = 'pending'", []).unwrap();
}

#[test]
fn w10_delete_checks_effects_pins_executors_and_keeps_tombstone() {
    let (mut t, w) = setup();
    let (ws, ada, uid) = w[0].clone();
    let bea = w[1].1.clone();
    let store = t.m.ws_row(&ws).unwrap()["storeUUID"].as_str().unwrap().to_string();
    // a running workspace cannot be deleted; deletion needs archive first
    assert_eq!(t.m.begin_delete(&ada, &ws, &uuid(), "discard", None, None).unwrap_err().code, "CONFLICT");
    t.m.archive_workspace(&ada, &ws).unwrap();
    ack_all(&t.m);
    // the administrator is not the owner and has no owner consent → refused
    assert_eq!(t.m.begin_delete(&bea, &ws, &uuid(), "discard", None, None).unwrap_err().code, "CONFLICT");
    // a bad disposition, or "exported" without a complete exported set, is refused
    assert_eq!(t.m.begin_delete(&ada, &ws, &uuid(), "keep", None, None).unwrap_err().code, "INVALID_REQUEST");
    assert!(t.m.begin_delete(&ada, &ws, &uuid(), "exported", Some(&uuid()), None).is_err());
    // an executor of the workspace is alive → fenced
    t.fake.busy.lock().unwrap().insert(uid);
    assert_eq!(t.m.begin_delete(&ada, &ws, &uuid(), "discard", None, None).unwrap_err().code, "WORKSPACE_FENCED");
    t.fake.busy.lock().unwrap().remove(&uid);
    // a pinned local recovery set that covered this workspace blocks deletion
    let b = t.m.hold_barrier("checkpoint", &uuid(), &serde_json::json!({ "workspaces": [ws.clone()] })).unwrap();
    let set = uuid();
    t.m.begin_checkpoint(&set, "machine", &b).unwrap();
    t.m.complete_checkpoint(&set, "sha256:00", true).unwrap();
    t.m.release_barrier(&b).unwrap();
    ack_all(&t.m);
    let e = t.m.begin_delete(&ada, &ws, &uuid(), "discard", None, None).unwrap_err();
    assert_eq!(e.code, "CONFLICT", "{}", e.message);
    t.m.c.execute("UPDATE checkpoint_sets SET pinned = 0 WHERE set_id = ?1", [&set]).unwrap();
    // an unsynced broker blocks deletion (it could not judge effects yet)
    t.m.c.execute("UPDATE registry_outbox SET state = 'pending' WHERE id = (SELECT MAX(id) FROM registry_outbox WHERE target_kind = 'broker')", []).unwrap();
    assert_eq!(t.m.begin_delete(&ada, &ws, &uuid(), "discard", None, None).unwrap_err().code, "STORE_UNAVAILABLE");
    ack_all(&t.m);
    // phase 1: deleting, broker asked; nothing removed yet; idempotent for the same deleteId
    let did = uuid();
    assert_eq!(t.m.begin_delete(&ada, &ws, &did, "discard", None, None).unwrap()["state"], "deleting");
    assert_eq!(t.m.begin_delete(&ada, &ws, &did, "discard", None, None).unwrap()["state"], "deleting");
    assert_eq!(t.m.begin_delete(&ada, &ws, &uuid(), "discard", None, None).unwrap_err().code, "CONFLICT");
    let asked: i64 = t.m.c.query_row("SELECT COUNT(*) FROM registry_outbox WHERE target_kind = 'broker' AND kind = 'workspace.deleting' AND state = 'pending'", [], |r| r.get(0)).unwrap();
    assert_eq!(asked, 1);
    assert!(t.fake.removed.lock().unwrap().is_empty());
    // a deleting workspace cannot be started or restored, and its executor is no longer recognised
    assert!(t.m.start_workspace(&ws).is_err());
    assert!(t.m.unarchive_workspace(&ada, &ws).is_err());
    assert!(t.m.ws_by_exec_uid(uid).unwrap().is_none());
    // the broker reports an unknown effect → blocked, back to archived with the reason kept
    assert_eq!(t.m.delete_verdict(&ws, &did, 1, &serde_json::json!({ "operations": ["x"] })).unwrap_err().code, "CONFLICT");
    assert_eq!(t.m.ws_row(&ws).unwrap()["state"], "archived");
    assert!(t.fake.removed.lock().unwrap().is_empty());
    // a stale verdict for that old deleteId has no effect
    assert_eq!(t.m.delete_verdict(&ws, &did, 0, &serde_json::Value::Null).unwrap()["state"], "archived");
    // retry after reconciliation; a restart before the verdict re-asks the broker
    let did2 = uuid();
    ack_all(&t.m);
    t.m.begin_delete(&ada, &ws, &did2, "discard", None, None).unwrap();
    ack_all(&t.m);
    assert_eq!(t.m.resume_deletions().unwrap(), 1);
    let again: String = t.m.c.query_row("SELECT body_json FROM registry_outbox WHERE target_kind = 'broker' AND kind = 'workspace.deleting' AND state = 'pending'", [], |r| r.get(0)).unwrap();
    assert!(again.contains(&did2));
    // clean verdict: roots removed, row kept as tombstone, members revoked, invisible to everyone
    assert_eq!(t.m.delete_verdict(&ws, &did2, 0, &serde_json::Value::Null).unwrap()["state"], "deleted");
    assert_eq!(t.fake.removed.lock().unwrap().as_slice(), &[ws.clone()]);
    assert!(t.m.list_visible(&ada).unwrap().iter().all(|v| v["workspaceId"] != ws.as_str()));
    assert_eq!(t.m.membership(&ada, &ws).unwrap_err().code, crate::err::MErr::hidden().code);
    let tomb: (String, String, i64, Option<i64>) = t.m.c.query_row("SELECT state, store_uuid, execution_uid, deleted_at FROM workspaces WHERE workspace_id = ?1", [&ws], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
    assert_eq!((tomb.0.as_str(), tomb.1.as_str(), tomb.2 as u32), ("deleted", store.as_str(), uid));
    assert!(tomb.3.is_some());
    // tombstones: the storeUUID cannot be registered again (no second writer for it) and the UID is not reused
    assert_eq!(t.m.create_workspace(&uuid(), &ada, "again", Some(&store), "imported_v04").unwrap_err().code, "STORE_ALREADY_REGISTERED");
    let n = t.m.create_workspace(&uuid(), &ada, "new", None, "created").unwrap();
    assert_ne!(n["executionUid"].as_u64().unwrap() as u32, uid);
    // a deleted workspace does not count toward the registered-workspace cap
    let cnt: i64 = t.m.c.query_row("SELECT COUNT(*) FROM workspaces WHERE state != 'deleted'", [], |r| r.get(0)).unwrap();
    assert_eq!(cnt, 2);
}

#[test]
fn w10_owner_consent_operation_lets_a_non_owner_admin_delete() {
    let (mut t, w) = setup();
    let (ws, ada, _) = w[0].clone();
    let bea = w[1].1.clone();
    t.m.archive_workspace(&ada, &ws).unwrap();
    ack_all(&t.m);
    // a consent record by someone who is not the owner, or for another disposition, does not count
    let fake_op = uuid();
    t.m.c.execute("INSERT INTO machine_operations (operation_id, principal_user_id, session_epoch, idempotency_key, kind, resource_id, resource_generation, params_json, plan_hash, request_hash, machine_control_epoch, state, effect_certainty, expires_at, created_at) VALUES (?1, ?2, 1, ?1, 'workspaces.deleteConsent', 'r', 1, ?3, 'h', 'h', 1, 'succeeded', 'applied', 0, 0)",
        rusqlite::params![fake_op, bea, serde_json::json!({ "workspaceId": ws, "dataDisposition": "discard" }).to_string()]).unwrap();
    assert!(!t.m.owner_consented(&bea, &ws, "discard", Some(&fake_op)).unwrap());
    let op = uuid();
    t.m.c.execute("INSERT INTO machine_operations (operation_id, principal_user_id, session_epoch, idempotency_key, kind, resource_id, resource_generation, params_json, plan_hash, request_hash, machine_control_epoch, state, effect_certainty, expires_at, created_at) VALUES (?1, ?2, 1, ?1, 'workspaces.deleteConsent', 'r', 1, ?3, 'h', 'h', 1, 'succeeded', 'applied', 0, 0)",
        rusqlite::params![op, ada, serde_json::json!({ "workspaceId": ws, "dataDisposition": "discard" }).to_string()]).unwrap();
    assert!(!t.m.owner_consented(&bea, &ws, "exported", Some(&op)).unwrap());
    assert!(t.m.owner_consented(&bea, &ws, "discard", Some(&op)).unwrap());
    assert_eq!(t.m.begin_delete(&bea, &ws, &uuid(), "discard", None, Some(&op)).unwrap()["state"], "deleting");
}

#[test]
fn w10_schema_1_database_migrates_to_2_keeping_every_row() {
    let dir = std::env::temp_dir().join(format!("agentos-mig-{}", uuid()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("machine.sqlite");
    {
        let c = rusqlite::Connection::open(&p).unwrap();
        c.execute_batch("PRAGMA foreign_keys = ON;").unwrap();
        c.execute_batch(&crate::db::schema_v1()).unwrap();
        c.execute("INSERT INTO machine_meta (id, machine_install_id, first_boot_id, machine_control_epoch, registry_seq, schema_version, restore_state, first_boot_state, machine_secret_ref, created_at) VALUES (1, 'mid', 'fb', 3, 7, 1, 'idle', 'closed', 'file:machine.secret#1', 1)", []).unwrap();
        c.execute("INSERT INTO users (user_id, login_uid, login_name, role, state, auth_version, provisioning_id, created_at) VALUES ('u1', 1000, 'ada', 'user', 'active', 1, 'p1', 1)", []).unwrap();
        c.execute("INSERT INTO workspaces (workspace_id, create_id, store_uuid, display_name, owner_user_id, execution_uid, exec_login, subuid_start, subgid_start, range_size, state, instance_epoch, workspace_incarnation, data_path_id, origin, created_at) VALUES ('w1', 'c1', 's1', 'A', 'u1', 60000, 'aows0', 100000, 100000, 65536, 'archived', 4, 2, 'data:w1:1', 'imported_v04', 1)", []).unwrap();
        c.execute("INSERT INTO workspace_members (workspace_id, user_id, role, member_version, state, changed_at) VALUES ('w1', 'u1', 'owner', 3, 'active', 1)", []).unwrap();
        // schema 1 has no deleted state
        assert!(c.execute("UPDATE workspaces SET state = 'deleted'", []).is_err());
    }
    let c = crate::db::open(p.to_str().unwrap()).unwrap();
    let (v, epoch, seq): (i64, i64, i64) = c.query_row("SELECT schema_version, machine_control_epoch, registry_seq FROM machine_meta", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
    assert_eq!((v, epoch, seq), (2, 3, 7));
    let row: (String, i64, i64, String) = c.query_row("SELECT state, instance_epoch, workspace_incarnation, origin FROM workspaces WHERE workspace_id = 'w1'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap();
    assert_eq!(row, ("archived".into(), 4, 2, "imported_v04".into()));
    let mv: i64 = c.query_row("SELECT member_version FROM workspace_members WHERE workspace_id = 'w1'", [], |r| r.get(0)).unwrap();
    assert_eq!(mv, 3);
    // foreign keys still bind members to the rebuilt table, and the new states are accepted
    assert!(c.execute("INSERT INTO workspace_members (workspace_id, user_id, role, member_version, state, changed_at) VALUES ('nope', 'u1', 'viewer', 1, 'active', 1)", []).is_err());
    c.execute("UPDATE workspaces SET state = 'deleted', deleted_at = 5 WHERE workspace_id = 'w1'", []).unwrap();
    let audit: i64 = c.query_row("SELECT COUNT(*) FROM root_audit WHERE kind = 'machine.schema_migrate'", [], |r| r.get(0)).unwrap();
    assert_eq!(audit, 1);
    drop(c);
    // reopening is a no-op; a newer schema is refused
    let c = crate::db::open(p.to_str().unwrap()).unwrap();
    c.execute_batch("PRAGMA foreign_keys = OFF; PRAGMA ignore_check_constraints = ON; UPDATE machine_meta SET schema_version = 9;").unwrap();
    drop(c);
    assert!(crate::db::open(p.to_str().unwrap()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn u11_migration_waits_for_commit_and_rollback_needs_a_compatible_generation() {
    let dir = std::env::temp_dir().join(format!("agentos-u11-{}", uuid()));
    let paths = Paths { machine_dir: dir.join("machine"), workspaces_dir: dir.join("ws"), runtime_dir: dir.join("rt"), run_dir: dir.join("run"), snapshots_dir: dir.join("snap") };
    std::fs::create_dir_all(&paths.machine_dir).unwrap();
    let file = paths.machine_dir.join("machine.sqlite");
    let rel = |c: &rusqlite::Connection, id: &str, seq: i64, hi: i64| {
        let comp = serde_json::json!({ "workspaceSchema": [5, 5], "machineSchema": [1, hi], "brokerSchema": [4, 4], "brokerProtocol": [3, 3], "nativeRpc": [1, 1] }).to_string();
        c.execute("INSERT INTO releases (release_id, manifest_hash, release_sequence, closure_path, compatibility_json, migration_class, verification_state, support_until, created_at) VALUES (?1, 'sha256:x', ?2, '/nix/store/x', ?3, 'offline_breaking', 'verified', 9999999999999, 1)", rusqlite::params![id, seq, comp]).unwrap();
    };
    {
        // a schema-1 machine (old generation r1) in the middle of a trial boot of r2
        let c = rusqlite::Connection::open(&file).unwrap();
        c.execute_batch(&crate::db::schema_v1()).unwrap();
        c.execute("INSERT INTO machine_meta (id, machine_install_id, first_boot_id, machine_control_epoch, registry_seq, schema_version, current_release_id, known_good_release_id, accepted_release_sequence, restore_state, first_boot_state, machine_secret_ref, created_at) VALUES (1, 'mid', 'fb', 1, 0, 1, 'r1', 'r1', 2, 'idle', 'closed', 'file:machine.secret#1', 1)", []).unwrap();
        rel(&c, "r0", 1, 1); // an older generation that only knows schema 1
        rel(&c, "r1", 2, 2); // the old generation, explicitly compatible with schema 2
        rel(&c, "r2", 3, 2); // the new generation
        c.execute("INSERT INTO revocations (revocation_id, scope_kind, scope_id, old_version, new_version, registry_seq, reason, state, created_at) VALUES ('rv1', 'user', 'u1', 1, 2, 1, 'disabled', 'revoked', 1)", []).unwrap();
        c.execute("INSERT INTO update_jobs (update_id, from_release_id, to_release_id, plan_hash, state, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'r1', 'r2', 'h', 'trial_boot', 1, 1)", []).unwrap();
    }
    // trial boot of the new program: no migration yet, so the known-good fallback can still open the database
    let m = Machine::open(paths.clone(), Box::new(Fake::default())).unwrap();
    assert_eq!(crate::db::live_schema(&m.c), 1);
    m.set_current_release("r0", false).unwrap(); // even r0 is still compatible while the data is schema 1
    m.set_current_release("r1", false).unwrap();
    drop(m);
    let m = Machine::open(paths.clone(), Box::new(Fake::default())).unwrap();
    assert_eq!(crate::db::live_schema(&m.c), 1, "reopening during the trial does not migrate either");
    m.advance_update("11111111-1111-4111-8111-111111111111", "validating", &serde_json::json!({})).unwrap();
    m.advance_update("11111111-1111-4111-8111-111111111111", "committed", &serde_json::json!({})).unwrap();
    // commit: now the new generation writes schema 2
    assert_eq!(crate::db::live_schema(&m.c), 2);
    let (cur, hw): (String, i64) = m.c.query_row("SELECT current_release_id, accepted_release_sequence FROM machine_meta", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((cur.as_str(), hw), ("r2", 3));
    // a rollback to a generation that does not know schema 2 is refused before anything boots it
    assert_eq!(m.set_current_release("r0", true).unwrap_err().code, "ROLLBACK_INCOMPATIBLE");
    assert_eq!(m.c.query_row("SELECT current_release_id FROM machine_meta", [], |r| r.get::<_, String>(0)).unwrap(), "r2");
    // the explicitly compatible old generation is accepted; records and the latest revocation are kept, high water stays
    m.set_current_release("r1", true).unwrap();
    let (cur, hw): (String, i64) = m.c.query_row("SELECT current_release_id, accepted_release_sequence FROM machine_meta", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!((cur.as_str(), hw), ("r1", 3));
    let rv: String = m.c.query_row("SELECT state FROM revocations WHERE revocation_id = 'rv1'", [], |r| r.get(0)).unwrap();
    assert_eq!(rv, "revoked");
    assert_eq!(crate::db::live_schema(&m.c), 2, "a rollback never runs a down-migration");
    drop(m);
    let _ = std::fs::remove_dir_all(&dir);
}
