use agentos_protocol::canonical::domain_hash;
use agentos_protocol::v1_json::parse_strict_json;
use serde_json::Value;

fn vectors() -> Value {
    let p = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../fixtures/v1.0/protocol/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(p).expect("v1 vectors")).unwrap()
}

#[test]
fn hashes_match_typescript() {
    let v = vectors();
    for c in v["hashes"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let hash = domain_hash(c["domain"].as_str().unwrap(), &c["value"]).unwrap();
        assert_eq!(hash, c["hash"].as_str().unwrap(), "{name}");
    }
}

#[test]
fn strict_json_matches_typescript() {
    let v = vectors();
    for c in v["strict"].as_array().unwrap() {
        let name = c["name"].as_str().unwrap();
        let ok = parse_strict_json(c["text"].as_str().unwrap()).is_ok();
        assert_eq!(ok, c["ok"].as_bool().unwrap(), "{name}");
    }
}
