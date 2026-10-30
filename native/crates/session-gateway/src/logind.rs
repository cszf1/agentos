//! logind is the only authority for "which local session is this process in, is it on seat0, active, locked,
//! remote" (spec §9.1). Client-supplied names, session ids or environment never count.
use zbus::blocking::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionFacts {
    pub id: String,
    pub uid: u32,
    pub seat: String,
    pub active: bool,
    pub locked: bool,
    pub remote: bool,
    pub state: String,
    pub class: String,
    pub kind: String,
}

impl SessionFacts {
    /// Eligible for interactive machine rights: local, on seat0, active, a user-class session that is not closing.
    pub fn eligible(&self, peer_uid: u32) -> Result<(), &'static str> {
        if self.uid != peer_uid {
            return Err("session belongs to another user");
        }
        if self.remote {
            return Err("remote sessions have no machine rights");
        }
        if self.seat != "seat0" {
            return Err("process is not in a seat session");
        }
        if self.class != "user" {
            return Err("not a user-class session");
        }
        if self.state == "closing" {
            return Err("session is closing");
        }
        if !self.active {
            return Err("session is not the active one on the seat");
        }
        Ok(())
    }
}

fn prop(c: &Connection, path: &str, name: &str) -> Result<OwnedValue, String> {
    let p = zbus::blocking::fdo::PropertiesProxy::builder(c)
        .destination("org.freedesktop.login1")
        .and_then(|b| b.path(path.to_string()))
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())?;
    p.get("org.freedesktop.login1.Session".try_into().unwrap(), name).map_err(|e| e.to_string())
}

pub fn session_path_of_pid(c: &Connection, pid: u32) -> Result<OwnedObjectPath, String> {
    let r = c
        .call_method(Some("org.freedesktop.login1"), "/org/freedesktop/login1", Some("org.freedesktop.login1.Manager"), "GetSessionByPID", &(pid,))
        .map_err(|e| format!("no logind session for this process: {e}"))?;
    r.body().deserialize::<OwnedObjectPath>().map_err(|e| e.to_string())
}

pub fn facts(c: &Connection, path: &str) -> Result<SessionFacts, String> {
    let id: String = prop(c, path, "Id")?.try_into().map_err(|_| "Id")?;
    let user: (u32, OwnedObjectPath) = prop(c, path, "User")?.try_into().map_err(|_| "User")?;
    let seat: (String, OwnedObjectPath) = prop(c, path, "Seat")?.try_into().map_err(|_| "Seat")?;
    Ok(SessionFacts {
        id,
        uid: user.0,
        seat: seat.0,
        active: prop(c, path, "Active")?.try_into().map_err(|_| "Active")?,
        locked: prop(c, path, "LockedHint")?.try_into().map_err(|_| "LockedHint")?,
        remote: prop(c, path, "Remote")?.try_into().map_err(|_| "Remote")?,
        state: prop(c, path, "State")?.try_into().map_err(|_| "State")?,
        class: prop(c, path, "Class")?.try_into().map_err(|_| "Class")?,
        kind: prop(c, path, "Type")?.try_into().map_err(|_| "Type")?,
    })
}
