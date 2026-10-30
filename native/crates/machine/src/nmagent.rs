//! NetworkManager secret agent of machined (spec §12.1: "Wi-Fi 密码等秘密单独通过受保护输入通道交给 NetworkManager
//! secret agent；操作日志只保存 secretRef"). machined creates Wi-Fi connections with `psk-flags = 1` (agent-owned),
//! so NetworkManager never writes the key to its keyfile, and answers NetworkManager's GetSecrets for exactly the
//! connection it created from the key it holds in memory. The key reaches machined only through the gateway's
//! one-time secret store (secretRef); it is never in argv, a log, machine.sqlite, a NetworkManager file or a backup.
//! Known limit: the key lives as long as machined; after a machined restart or a reboot the network asks again
//! (NetworkManager sees no secret and the connection fails visibly) and the user reconnects.
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value as ZValue};

type Settings = HashMap<String, HashMap<String, OwnedValue>>;

/// connection uuid → key bytes (zeroed when dropped from the map)
#[derive(Default)]
pub struct Keys {
    m: HashMap<String, Vec<u8>>,
}

impl Keys {
    pub fn put(&mut self, uuid: &str, key: Vec<u8>) {
        self.drop_key(uuid);
        self.m.insert(uuid.to_string(), key);
    }
    pub fn drop_key(&mut self, uuid: &str) {
        if let Some(mut k) = self.m.remove(uuid) {
            k.iter_mut().for_each(|b| *b = 0);
        }
    }
    pub fn get(&self, uuid: &str) -> Option<&Vec<u8>> {
        self.m.get(uuid)
    }
    pub fn len(&self) -> usize {
        self.m.len()
    }
    pub fn is_empty(&self) -> bool {
        self.m.is_empty()
    }
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.freedesktop.NetworkManager.SecretAgent")]
pub enum AgentError {
    #[zbus(error)]
    ZBus(zbus::Error),
    NoSecrets(String),
    UserCanceled(String),
}

pub struct Agent {
    keys: Arc<Mutex<Keys>>,
}

/// NM_SECRET_AGENT_GET_SECRETS_FLAG_REQUEST_NEW: the secret given before was wrong.
pub const REQUEST_NEW: u32 = 0x2;

fn conn_uuid(c: &Settings) -> Option<String> {
    c.get("connection").and_then(|s| s.get("uuid")).and_then(|v| v.try_clone().ok()).and_then(|v| String::try_from(v).ok())
}

/// The answer to one GetSecrets (pure; unit tested): the key for this connection's wireless security, or none.
/// A REQUEST_NEW means the key was rejected: it is dropped, never offered again.
pub fn answer(keys: &mut Keys, uuid: Option<&str>, setting: &str, flags: u32) -> Result<Option<String>, &'static str> {
    let uuid = match uuid {
        Some(u) => u,
        None => return Err("no connection uuid"),
    };
    if setting != "802-11-wireless-security" {
        return Err("only Wi-Fi keys are held");
    }
    if flags & REQUEST_NEW != 0 {
        keys.drop_key(uuid);
        return Err("the key was rejected; the user has to enter it again");
    }
    match keys.get(uuid) {
        Some(k) => Ok(Some(String::from_utf8_lossy(k).into_owned())),
        None => Err("no key for this connection"),
    }
}

#[zbus::interface(name = "org.freedesktop.NetworkManager.SecretAgent")]
impl Agent {
    fn get_secrets(&self, connection: Settings, _connection_path: OwnedObjectPath, setting_name: String, _hints: Vec<String>, flags: u32) -> Result<Settings, AgentError> {
        let uuid = conn_uuid(&connection);
        let mut keys = self.keys.lock().unwrap();
        match answer(&mut keys, uuid.as_deref(), &setting_name, flags) {
            Ok(Some(k)) => {
                let mut sec: HashMap<String, OwnedValue> = HashMap::new();
                let v = OwnedValue::try_from(ZValue::from(k)).map_err(|e| AgentError::ZBus(zbus::Error::Variant(e)))?;
                sec.insert("psk".into(), v);
                let mut out = Settings::new();
                out.insert(setting_name, sec);
                Ok(out)
            }
            Ok(None) | Err(_) => Err(AgentError::NoSecrets("machined holds no key for this connection".into())),
        }
    }
    fn cancel_get_secrets(&self, _connection_path: OwnedObjectPath, _setting_name: String) {}
    /// Agent-owned keys stay in machined's memory only.
    fn save_secrets(&self, _connection: Settings, _connection_path: OwnedObjectPath) {}
    fn delete_secrets(&self, connection: Settings, _connection_path: OwnedObjectPath) {
        if let Some(u) = conn_uuid(&connection) {
            self.keys.lock().unwrap().drop_key(&u);
        }
    }
}

struct Registered {
    conn: zbus::blocking::Connection,
    keys: Arc<Mutex<Keys>>,
}

static AGENT: OnceLock<Mutex<Option<Registered>>> = OnceLock::new();

/// Make sure machined's agent is on the system bus and registered with NetworkManager (again after an NM restart:
/// NM forgets agents when it restarts; registering twice from the same connection is answered with an error that is
/// ignored). Returns the shared key map.
pub fn ensure() -> Result<Arc<Mutex<Keys>>, String> {
    let cell = AGENT.get_or_init(|| Mutex::new(None));
    let mut g = cell.lock().unwrap();
    if g.is_none() {
        let keys = Arc::new(Mutex::new(Keys::default()));
        let conn = zbus::blocking::connection::Builder::system()
            .and_then(|b| b.serve_at("/org/freedesktop/NetworkManager/SecretAgent", Agent { keys: keys.clone() }))
            .and_then(|b| b.build())
            .map_err(|e| format!("secret agent: {e}"))?;
        *g = Some(Registered { conn, keys });
    }
    let r = g.as_ref().unwrap();
    let _ = r.conn.call_method(
        Some("org.freedesktop.NetworkManager"),
        "/org/freedesktop/NetworkManager/AgentManager",
        Some("org.freedesktop.NetworkManager.AgentManager"),
        "Register",
        &("org.agentos.machined",),
    );
    Ok(r.keys.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn i11_the_agent_answers_only_its_connection_and_forgets_a_rejected_key() {
        let mut k = Keys::default();
        k.put("u1", b"correct horse".to_vec());
        assert_eq!(answer(&mut k, Some("u1"), "802-11-wireless-security", 0x1).unwrap().as_deref(), Some("correct horse"));
        assert!(answer(&mut k, Some("u2"), "802-11-wireless-security", 0).is_err(), "another connection gets nothing");
        assert!(answer(&mut k, Some("u1"), "802-1x", 0).is_err(), "only the Wi-Fi security setting");
        assert!(answer(&mut k, None, "802-11-wireless-security", 0).is_err());
        // NetworkManager says the key was wrong: it is dropped and never offered again
        assert!(answer(&mut k, Some("u1"), "802-11-wireless-security", REQUEST_NEW).is_err());
        assert!(k.is_empty());
        assert!(answer(&mut k, Some("u1"), "802-11-wireless-security", 0).is_err());
    }
}
