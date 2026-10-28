//! Length-prefixed JSON frames (spec §12.2): 4-byte big-endian length, at most 512 KiB, nesting depth at most 8.
//! The length is checked before the body is read, and the depth before serde builds a value, so a huge or deeply
//! nested frame cannot occupy the broker.
use std::io::{self, Read, Write};

pub const MAX_CONTROL_FRAME: usize = 512 * 1024;
pub const MAX_DEPTH: usize = 8;

#[derive(Debug)]
pub enum FrameError {
    Io(io::Error),
    Eof,
    TooLarge(usize),
    TooDeep,
    NotJson(String),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Io(e) => write!(f, "io: {e}"),
            FrameError::Eof => write!(f, "connection closed"),
            FrameError::TooLarge(n) => write!(f, "frame of {n} bytes exceeds the limit"),
            FrameError::TooDeep => write!(f, "JSON nesting exceeds depth {MAX_DEPTH}"),
            FrameError::NotJson(m) => write!(f, "invalid JSON: {m}"),
        }
    }
}

pub fn read_frame<R: Read>(r: &mut R, max: usize) -> Result<Vec<u8>, FrameError> {
    let mut head = [0u8; 4];
    match r.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Err(FrameError::Eof),
        Err(e) => return Err(FrameError::Io(e)),
    }
    let len = u32::from_be_bytes(head) as usize;
    if len > max {
        return Err(FrameError::TooLarge(len));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).map_err(|e| if e.kind() == io::ErrorKind::UnexpectedEof { FrameError::Eof } else { FrameError::Io(e) })?;
    Ok(body)
}

pub fn write_frame<W: Write>(w: &mut W, body: &[u8]) -> io::Result<()> {
    if body.len() > MAX_CONTROL_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "frame too large"));
    }
    let mut buf = Vec::with_capacity(body.len() + 4);
    buf.extend_from_slice(&(body.len() as u32).to_be_bytes());
    buf.extend_from_slice(body);
    w.write_all(&buf)?;
    w.flush()
}

/// Maximum nesting depth of a JSON text, ignoring brackets inside strings.
pub fn json_depth(bytes: &[u8]) -> usize {
    let (mut depth, mut max, mut in_str, mut esc) = (0usize, 0usize, false, false);
    for &b in bytes {
        if in_str {
            if esc {
                esc = false;
            } else if b == b'\\' {
                esc = true;
            } else if b == b'"' {
                in_str = false;
            }
            continue;
        }
        match b {
            b'"' => in_str = true,
            b'{' | b'[' => {
                depth += 1;
                if depth > max {
                    max = depth;
                }
            }
            b'}' | b']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    max
}

pub fn parse_strict(bytes: &[u8]) -> Result<serde_json::Value, FrameError> {
    if json_depth(bytes) > MAX_DEPTH {
        return Err(FrameError::TooDeep);
    }
    serde_json::from_slice(bytes).map_err(|e| FrameError::NotJson(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn depth_and_size() {
        assert_eq!(json_depth(br#"{"a":[{"b":"[[[["}]}"#), 3);
        let deep = "[".repeat(9) + &"]".repeat(9);
        assert!(matches!(parse_strict(deep.as_bytes()), Err(FrameError::TooDeep)));
        let mut big = Vec::new();
        big.extend_from_slice(&((MAX_CONTROL_FRAME as u32) + 1).to_be_bytes());
        assert!(matches!(read_frame(&mut big.as_slice(), MAX_CONTROL_FRAME), Err(FrameError::TooLarge(_))));
    }
}
