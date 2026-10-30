use serde_json::Value;

#[derive(Debug)]
pub struct StrictJsonError(pub String);

pub fn parse_strict_json(text: &str) -> Result<Value, StrictJsonError> {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let value = parse_value(bytes, &mut i, 0)?;
    skip(bytes, &mut i);
    if i != bytes.len() {
        return Err(StrictJsonError("trailing data".into()));
    }
    Ok(value)
}

fn parse_value(bytes: &[u8], i: &mut usize, depth: usize) -> Result<Value, StrictJsonError> {
    if depth > 32 {
        return Err(StrictJsonError("nesting too deep".into()));
    }
    skip(bytes, i);
    if *i >= bytes.len() {
        return Err(StrictJsonError("unexpected end".into()));
    }
    match bytes[*i] {
        b'{' => parse_object(bytes, i, depth),
        b'[' => parse_array(bytes, i, depth),
        b'"' => Ok(Value::String(parse_string(bytes, i)?)),
        b't' => literal(bytes, i, b"true", Value::Bool(true)),
        b'f' => literal(bytes, i, b"false", Value::Bool(false)),
        b'n' => literal(bytes, i, b"null", Value::Null),
        b'-' | b'0'..=b'9' => parse_number(bytes, i),
        _ => Err(StrictJsonError("invalid JSON".into())),
    }
}

fn literal(bytes: &[u8], i: &mut usize, word: &[u8], value: Value) -> Result<Value, StrictJsonError> {
    if bytes.get(*i..*i + word.len()) != Some(word) {
        return Err(StrictJsonError("invalid JSON".into()));
    }
    *i += word.len();
    Ok(value)
}

fn parse_object(bytes: &[u8], i: &mut usize, depth: usize) -> Result<Value, StrictJsonError> {
    *i += 1;
    let mut map = serde_json::Map::new();
    skip(bytes, i);
    if bytes.get(*i) == Some(&b'}') {
        *i += 1;
        return Ok(Value::Object(map));
    }
    loop {
        skip(bytes, i);
        if bytes.get(*i) != Some(&b'"') {
            return Err(StrictJsonError("object key must be a string".into()));
        }
        let key = parse_string(bytes, i)?;
        if map.contains_key(&key) {
            return Err(StrictJsonError("duplicate key".into()));
        }
        skip(bytes, i);
        if bytes.get(*i) != Some(&b':') {
            return Err(StrictJsonError("expected colon".into()));
        }
        *i += 1;
        map.insert(key, parse_value(bytes, i, depth + 1)?);
        skip(bytes, i);
        match bytes.get(*i) {
            Some(&b',') => *i += 1,
            Some(&b'}') => {
                *i += 1;
                return Ok(Value::Object(map));
            }
            _ => return Err(StrictJsonError("expected comma or end of object".into())),
        }
    }
}

fn parse_array(bytes: &[u8], i: &mut usize, depth: usize) -> Result<Value, StrictJsonError> {
    *i += 1;
    let mut out = Vec::new();
    skip(bytes, i);
    if bytes.get(*i) == Some(&b']') {
        *i += 1;
        return Ok(Value::Array(out));
    }
    loop {
        out.push(parse_value(bytes, i, depth + 1)?);
        skip(bytes, i);
        match bytes.get(*i) {
            Some(&b',') => *i += 1,
            Some(&b']') => {
                *i += 1;
                return Ok(Value::Array(out));
            }
            _ => return Err(StrictJsonError("expected comma or end of array".into())),
        }
    }
}

fn parse_string(bytes: &[u8], i: &mut usize) -> Result<String, StrictJsonError> {
    *i += 1;
    let mut out = String::new();
    while *i < bytes.len() {
        let c = bytes[*i];
        *i += 1;
        if c == b'"' {
            return Ok(out);
        }
        if c == b'\\' {
            let e = *bytes.get(*i).ok_or_else(|| StrictJsonError("bad escape".into()))?;
            *i += 1;
            match e {
                b'"' | b'\\' | b'/' => out.push(e as char),
                b'b' => out.push('\u{0008}'),
                b'f' => out.push('\u{000c}'),
                b'n' => out.push('\n'),
                b'r' => out.push('\r'),
                b't' => out.push('\t'),
                b'u' => {
                    let hex = std::str::from_utf8(bytes.get(*i..*i + 4).ok_or_else(|| StrictJsonError("bad unicode escape".into()))?)
                        .map_err(|_| StrictJsonError("bad unicode escape".into()))?;
                    let n = u32::from_str_radix(hex, 16).map_err(|_| StrictJsonError("bad unicode escape".into()))?;
                    out.push(char::from_u32(n).ok_or_else(|| StrictJsonError("bad unicode escape".into()))?);
                    *i += 4;
                }
                _ => return Err(StrictJsonError("bad escape".into())),
            }
            continue;
        }
        if c < 0x20 {
            return Err(StrictJsonError("raw control character".into()));
        }
        let width = if c < 0x80 { 1 } else if c & 0xe0 == 0xc0 { 2 } else if c & 0xf0 == 0xe0 { 3 } else if c & 0xf8 == 0xf0 { 4 } else { return Err(StrictJsonError("bad utf-8".into())) };
        let start = *i - 1;
        let chunk = bytes.get(start..start + width).ok_or_else(|| StrictJsonError("bad utf-8".into()))?;
        let s = std::str::from_utf8(chunk).map_err(|_| StrictJsonError("bad utf-8".into()))?;
        out.push_str(s);
        *i = start + width;
    }
    Err(StrictJsonError("unterminated string".into()))
}

fn parse_number(bytes: &[u8], i: &mut usize) -> Result<Value, StrictJsonError> {
    let start = *i;
    if bytes.get(*i) == Some(&b'-') {
        *i += 1;
    }
    if bytes.get(*i) == Some(&b'0') {
        *i += 1;
    } else if bytes.get(*i).is_some_and(|c| (b'1'..=b'9').contains(c)) {
        while bytes.get(*i).is_some_and(|c| c.is_ascii_digit()) {
            *i += 1;
        }
    } else {
        return Err(StrictJsonError("invalid number".into()));
    }
    let mut float = false;
    if bytes.get(*i) == Some(&b'.') {
        float = true;
        *i += 1;
        if !bytes.get(*i).is_some_and(|c| c.is_ascii_digit()) {
            return Err(StrictJsonError("invalid number".into()));
        }
        while bytes.get(*i).is_some_and(|c| c.is_ascii_digit()) {
            *i += 1;
        }
    }
    if bytes.get(*i) == Some(&b'e') || bytes.get(*i) == Some(&b'E') {
        float = true;
        *i += 1;
        if bytes.get(*i) == Some(&b'+') || bytes.get(*i) == Some(&b'-') {
            *i += 1;
        }
        if !bytes.get(*i).is_some_and(|c| c.is_ascii_digit()) {
            return Err(StrictJsonError("invalid number".into()));
        }
        while bytes.get(*i).is_some_and(|c| c.is_ascii_digit()) {
            *i += 1;
        }
    }
    let text = std::str::from_utf8(&bytes[start..*i]).map_err(|_| StrictJsonError("invalid number".into()))?;
    if !float {
        let n: i64 = text.parse().map_err(|_| StrictJsonError("invalid number".into()))?;
        if n.unsigned_abs() > 9_007_199_254_740_991 {
            return Err(StrictJsonError("integer outside the safe range".into()));
        }
        return Ok(Value::Number(n.into()));
    }
    let n: f64 = text.parse().map_err(|_| StrictJsonError("invalid number".into()))?;
    if !n.is_finite() {
        return Err(StrictJsonError("non-finite number".into()));
    }
    serde_json::Number::from_f64(n).map(Value::Number).ok_or_else(|| StrictJsonError("non-finite number".into()))
}

fn skip(bytes: &[u8], i: &mut usize) {
    while bytes.get(*i).is_some_and(|c| c.is_ascii_whitespace()) {
        *i += 1;
    }
}
