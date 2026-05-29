//! IPC envelope framing and Go-compatible HMAC.
//!
//! This module mirrors the Go agent's IPC wire format byte-for-byte. The two
//! sides MUST agree exactly or the HMAC handshake silently fails.
//!
//! Ground truth: `agent/internal/ipc/protocol.go` + `message.go`.
//!
//! Frame layout: `[4-byte big-endian length][JSON bytes of Envelope]`.
//!
//! HMAC = `hex(HMAC-SHA256(key, ID || decimal(Seq) || Type || Payload))`.
//!   - `key` is 32 zero bytes pre-auth, the 32-byte session key post-auth.
//!   - A nil/absent payload is HMAC'd as the literal bytes `null` (matching
//!     Go's `jsonNull` normalisation in `computeHMAC`).
//!
//! The Go `Envelope` JSON keys are: `id`, `seq`, `type`, `payload`, `error`
//! (omitempty), `hmac`.

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

type HmacSha256 = Hmac<Sha256>;

/// Maximum size of a JSON IPC message (16 MiB). Mirrors Go `MaxMessageSize`.
pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;

/// Current IPC protocol version. Mirrors Go `ProtocolVersion`.
pub const PROTOCOL_VERSION: i32 = 1;

/// The literal JSON bytes used to HMAC a nil/absent payload. Matches Go's
/// `jsonNull = json.RawMessage("null")`.
const JSON_NULL: &[u8] = b"null";

/// Wire-format wrapper for all IPC messages. Field names / serde renames MUST
/// produce JSON keys identical to the Go `Envelope` struct.
///
/// `payload` is modeled as `Option<Box<RawValue>>` so the exact payload bytes
/// are preserved on both parse (inbound) and serialize (outbound) — the HMAC is
/// computed over those exact bytes.
#[derive(Debug, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "id")]
    pub id: String,
    #[serde(rename = "seq")]
    pub seq: u64,
    #[serde(rename = "type")]
    pub typ: String,
    /// Exact payload bytes. Serialized as JSON `null` when `None` (matching Go,
    /// which marshals a nil `json.RawMessage` as `null`).
    #[serde(rename = "payload")]
    pub payload: Option<Box<RawValue>>,
    #[serde(rename = "error", default, skip_serializing_if = "String::is_empty")]
    pub error: String,
    #[serde(rename = "hmac")]
    pub hmac: String,
}

/// Errors produced while reading/decoding an IPC frame.
#[derive(Debug)]
pub enum IpcError {
    Io(std::io::Error),
    Protocol(String),
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IpcError::Io(e) => write!(f, "ipc io error: {}", e),
            IpcError::Protocol(m) => write!(f, "ipc protocol error: {}", m),
        }
    }
}

impl std::error::Error for IpcError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            IpcError::Io(e) => Some(e),
            IpcError::Protocol(_) => None,
        }
    }
}

impl From<std::io::Error> for IpcError {
    fn from(e: std::io::Error) -> Self {
        IpcError::Io(e)
    }
}

/// Builds the seeded HMAC-SHA256 `Mac` over `id || decimal(seq) || typ ||
/// payload`. This is the single source of truth for the HMAC canonicalization;
/// both [`compute_hmac`] (outbound, finalizes to hex) and [`parse_and_verify`]
/// (inbound, constant-time `verify_slice`) build the message through here so the
/// formula can never drift between the two paths.
///
/// NOTE: the fields are concatenated with NO separators. This is intentional and
/// inherited verbatim from Go's `computeHMAC` (`agent/internal/ipc/protocol.go`).
/// The two sides MUST agree byte-for-byte, so do not "fix" this by adding
/// delimiters — doing so silently breaks the cross-language handshake.
fn hmac_mac(key: &[u8], id: &str, seq: u64, typ: &str, payload: &[u8]) -> HmacSha256 {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(id.as_bytes());
    mac.update(seq.to_string().as_bytes());
    mac.update(typ.as_bytes());
    mac.update(payload);
    mac
}

/// Computes `hex(HMAC-SHA256(key, id || decimal(seq) || typ || payload))`.
///
/// The update order and the decimal-string seq encoding match Go's
/// `computeHMAC` exactly. See [`hmac_mac`] for the shared canonicalization.
pub fn compute_hmac(key: &[u8], id: &str, seq: u64, typ: &str, payload: &[u8]) -> String {
    hex::encode(hmac_mac(key, id, seq, typ, payload).finalize().into_bytes())
}

/// Like [`compute_hmac`] but treats an absent payload as the literal bytes
/// `null`, matching Go's nil-payload normalisation.
// Used only by the cross-language HMAC parity tests below; kept here next to
// `compute_hmac` so the two stay in sync.
#[allow(dead_code)]
pub fn compute_hmac_opt(
    key: &[u8],
    id: &str,
    seq: u64,
    typ: &str,
    payload: Option<&[u8]>,
) -> String {
    compute_hmac(key, id, seq, typ, payload.unwrap_or(JSON_NULL))
}

/// Returns the payload bytes used for HMAC: the exact RawValue bytes, or the
/// literal `null` when there is no payload.
fn payload_hmac_bytes(payload: &Option<Box<RawValue>>) -> &[u8] {
    payload
        .as_ref()
        .map(|r| r.get().as_bytes())
        .unwrap_or(JSON_NULL)
}

/// Encodes a framed envelope without performing any I/O.
///
/// Increments `send_seq` first (so the first frame written has `seq == 1`),
/// computes the HMAC over the payload bytes (or `null`), builds the Envelope,
/// serializes it, and length-prefixes with a 4-byte big-endian header.
///
/// Returns `None` if the encoded message exceeds [`MAX_MESSAGE_SIZE`].
pub fn encode_frame(
    key: &[u8],
    send_seq: &mut u64,
    id: &str,
    typ: &str,
    payload: Option<Box<RawValue>>,
) -> Option<Vec<u8>> {
    // Monotonic send sequence. Wrap at u64::MAX is not a practical concern: at
    // even a million frames/sec it would take ~580k years to overflow.
    *send_seq += 1;
    let seq = *send_seq;

    let hmac = compute_hmac(key, id, seq, typ, payload_hmac_bytes(&payload));

    let env = Envelope {
        id: id.to_string(),
        seq,
        typ: typ.to_string(),
        payload,
        error: String::new(),
        hmac,
    };

    let body = serde_json::to_vec(&env).ok()?;
    // Only the oversize case is reachable: serde_json::to_vec on a struct always
    // yields a non-empty object, so there is no empty-body guard here.
    if body.len() > MAX_MESSAGE_SIZE {
        return None;
    }

    let mut frame = Vec::with_capacity(4 + body.len());
    frame.extend_from_slice(&(body.len() as u32).to_be_bytes());
    frame.extend_from_slice(&body);
    Some(frame)
}

/// Writes a framed envelope to `w`. See [`encode_frame`] for framing details.
pub async fn write_frame<W: AsyncWriteExt + Unpin>(
    w: &mut W,
    key: &[u8],
    send_seq: &mut u64,
    id: &str,
    typ: &str,
    payload: Option<Box<RawValue>>,
) -> Result<(), IpcError> {
    let frame = encode_frame(key, send_seq, id, typ, payload).ok_or_else(|| {
        IpcError::Protocol("ipc: message too large or failed to encode".to_string())
    })?;
    // IO errors convert via `From<io::Error>`, so the transport `?` chains stay
    // uniform on `IpcError`.
    w.write_all(&frame).await?;
    w.flush().await?;
    Ok(())
}

/// Reads, validates, and parses one framed envelope from `r`.
///
/// Enforces: length in `(0, MAX_MESSAGE_SIZE]`, HMAC match (constant-time),
/// `seq > 0`, and `seq` strictly greater than the previous `recv_seq` (replay
/// protection). On success updates `*recv_seq` and returns the envelope.
pub async fn read_frame<R: AsyncReadExt + Unpin>(
    r: &mut R,
    key: &[u8],
    recv_seq: &mut u64,
) -> Result<Envelope, IpcError> {
    let mut header = [0u8; 4];
    r.read_exact(&mut header).await?;
    let length = u32::from_be_bytes(header) as usize;

    if length == 0 {
        return Err(IpcError::Protocol("zero-length message".to_string()));
    }
    if length > MAX_MESSAGE_SIZE {
        return Err(IpcError::Protocol(format!(
            "message too large: {} > {}",
            length, MAX_MESSAGE_SIZE
        )));
    }

    let mut body = vec![0u8; length];
    r.read_exact(&mut body).await?;

    let env = parse_and_verify(&body, key, recv_seq)?;
    Ok(env)
}

/// Parses an envelope from `body`, verifies the HMAC, and enforces sequence
/// rules. Factored out so the round-trip unit test can exercise it without a
/// socket.
pub fn parse_and_verify(
    body: &[u8],
    key: &[u8],
    recv_seq: &mut u64,
) -> Result<Envelope, IpcError> {
    let env: Envelope = serde_json::from_slice(body)
        .map_err(|e| IpcError::Protocol(format!("unmarshal envelope: {}", e)))?;

    // Rebuild the HMAC over the exact payload bytes via the shared canonicalization
    // and constant-time compare. Non-hex hmac strings are a protocol error, not a
    // panic.
    let mac = hmac_mac(
        key,
        &env.id,
        env.seq,
        &env.typ,
        payload_hmac_bytes(&env.payload),
    );
    let received = match hex::decode(&env.hmac) {
        Ok(b) => b,
        Err(_) => return Err(IpcError::Protocol("HMAC mismatch".to_string())),
    };
    if mac.verify_slice(&received).is_err() {
        return Err(IpcError::Protocol("HMAC mismatch".to_string()));
    }

    if env.seq == 0 {
        return Err(IpcError::Protocol("invalid sequence number 0".to_string()));
    }
    if env.seq <= *recv_seq {
        return Err(IpcError::Protocol(format!(
            "sequence number {} <= last {} (replay/duplicate)",
            env.seq, *recv_seq
        )));
    }
    *recv_seq = env.seq;

    Ok(env)
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures generated from Go (agent/internal/ipc HMAC formula):
    //   mac(zeroKey, "auth", 1, "auth_request", `{"a":1}`)
    const AUTH_ZERO: &str = "ebf42fe8f25b2043ef5d97ed2c83cc4474b8b7ae3597ee937d41fcbc05adc301";
    //   mac(zeroKey, "x", 2, "ping", "null")
    const NULL_PAYLOAD: &str = "db78743491edd182de5fa88fdc5278b5722f28d2bf03db73d44c0bb61a47ee06";

    fn raw(s: &str) -> Box<RawValue> {
        RawValue::from_string(s.to_string()).expect("valid json")
    }

    #[test]
    fn hmac_matches_go_formula_zero_key() {
        let got = compute_hmac(&[0u8; 32], "auth", 1, "auth_request", br#"{"a":1}"#);
        assert_eq!(got, AUTH_ZERO);
    }

    #[test]
    fn nil_payload_hmacs_as_literal_null() {
        let opt = compute_hmac_opt(&[0u8; 32], "x", 2, "ping", None);
        assert_eq!(opt, NULL_PAYLOAD);
        // Explicit "null" bytes must produce the identical digest.
        let explicit = compute_hmac(&[0u8; 32], "x", 2, "ping", b"null");
        assert_eq!(opt, explicit);
    }

    #[test]
    fn frame_round_trip() {
        let key = [7u8; 32];
        let mut send_seq = 0u64;
        let frame = encode_frame(
            &key,
            &mut send_seq,
            "msg-1",
            "auth_request",
            Some(raw(r#"{"a":1,"b":"hello"}"#)),
        )
        .expect("encode");

        // First 4 bytes are BE length == remainder length.
        assert!(frame.len() > 4);
        let declared = u32::from_be_bytes([frame[0], frame[1], frame[2], frame[3]]) as usize;
        assert_eq!(declared, frame.len() - 4);

        // First sent frame must have seq == 1.
        assert_eq!(send_seq, 1);

        // Decode the body back and verify HMAC + fields survive.
        let body = &frame[4..];
        let mut recv_seq = 0u64;
        let env = parse_and_verify(body, &key, &mut recv_seq).expect("verify");
        assert_eq!(env.id, "msg-1");
        assert_eq!(env.seq, 1);
        assert_eq!(env.typ, "auth_request");
        assert_eq!(recv_seq, 1);
        assert_eq!(
            env.payload.as_ref().map(|r| r.get()),
            Some(r#"{"a":1,"b":"hello"}"#)
        );
    }

    #[test]
    fn frame_round_trip_nil_payload() {
        let key = [3u8; 32];
        let mut send_seq = 0u64;
        let frame = encode_frame(&key, &mut send_seq, "p", "ping", None).expect("encode");
        let body = &frame[4..];
        // Payload must serialize as JSON null.
        let s = std::str::from_utf8(body).unwrap();
        assert!(s.contains("\"payload\":null"), "body: {}", s);

        let mut recv_seq = 0u64;
        let env = parse_and_verify(body, &key, &mut recv_seq).expect("verify");
        assert!(env.payload.is_none());
    }

    #[test]
    fn parse_rejects_replayed_or_nonincreasing_seq() {
        let key = [1u8; 32];
        let mut send_seq = 0u64;
        let frame = encode_frame(&key, &mut send_seq, "a", "ping", None).expect("encode");
        let body = &frame[4..];

        let mut recv_seq = 5u64; // pretend we already saw seq 5
        let err = parse_and_verify(body, &key, &mut recv_seq).unwrap_err();
        match err {
            IpcError::Protocol(m) => assert!(m.contains("replay/duplicate"), "{}", m),
            _ => panic!("expected protocol error"),
        }
    }

    #[test]
    fn parse_rejects_bad_hmac() {
        let key = [1u8; 32];
        let mut send_seq = 0u64;
        let frame = encode_frame(&key, &mut send_seq, "a", "ping", None).expect("encode");
        let body = &frame[4..];

        let wrong_key = [2u8; 32];
        let mut recv_seq = 0u64;
        let err = parse_and_verify(body, &wrong_key, &mut recv_seq).unwrap_err();
        match err {
            IpcError::Protocol(m) => assert!(m.contains("HMAC mismatch"), "{}", m),
            _ => panic!("expected protocol error"),
        }
    }

    #[test]
    fn envelope_json_keys_match_go() {
        // Go Envelope tags: id, seq, type, payload, error (omitempty), hmac.
        let env = Envelope {
            id: "x".to_string(),
            seq: 9,
            typ: "ping".to_string(),
            payload: Some(raw(r#"{"k":1}"#)),
            error: String::new(),
            hmac: "deadbeef".to_string(),
        };
        let s = serde_json::to_string(&env).expect("serialize");
        assert!(s.contains("\"id\":"), "{}", s);
        assert!(s.contains("\"seq\":"), "{}", s);
        assert!(s.contains("\"type\":"), "{}", s);
        assert!(s.contains("\"payload\":"), "{}", s);
        assert!(s.contains("\"hmac\":"), "{}", s);
        // error is omitempty in Go and skipped when empty here.
        assert!(!s.contains("\"error\":"), "{}", s);
    }

    #[test]
    fn parse_rejects_malformed_json() {
        let key = [1u8; 32];
        let mut recv_seq = 0u64;
        let err = parse_and_verify(b"{not valid json", &key, &mut recv_seq).unwrap_err();
        match err {
            IpcError::Protocol(m) => assert!(m.contains("unmarshal envelope"), "{}", m),
            _ => panic!("expected protocol error"),
        }
        // recv_seq must be untouched on a parse failure.
        assert_eq!(recv_seq, 0);
    }

    #[test]
    fn parse_rejects_seq_zero() {
        // Hand-build an envelope with seq == 0 and a VALID hmac for seq 0 so we
        // exercise the seq==0 branch specifically (not an HMAC failure).
        let key = [4u8; 32];
        let payload = raw(r#"{"a":1}"#);
        let hmac = compute_hmac(&key, "z", 0, "ping", payload.get().as_bytes());
        let env = Envelope {
            id: "z".to_string(),
            seq: 0,
            typ: "ping".to_string(),
            payload: Some(payload),
            error: String::new(),
            hmac,
        };
        let body = serde_json::to_vec(&env).expect("serialize");

        let mut recv_seq = 0u64;
        let err = parse_and_verify(&body, &key, &mut recv_seq).unwrap_err();
        match err {
            IpcError::Protocol(m) => assert!(m.contains("invalid sequence number 0"), "{}", m),
            _ => panic!("expected protocol error"),
        }
    }

    #[test]
    fn parse_rejects_non_hex_hmac() {
        // A non-hex hmac string must surface as a Protocol error, never a panic.
        let env = Envelope {
            id: "x".to_string(),
            seq: 1,
            typ: "ping".to_string(),
            payload: None,
            error: String::new(),
            hmac: "zzzz-not-hex".to_string(),
        };
        let body = serde_json::to_vec(&env).expect("serialize");

        let key = [1u8; 32];
        let mut recv_seq = 0u64;
        let err = parse_and_verify(&body, &key, &mut recv_seq).unwrap_err();
        match err {
            IpcError::Protocol(m) => assert!(m.contains("HMAC mismatch"), "{}", m),
            _ => panic!("expected protocol error"),
        }
    }

    #[tokio::test]
    async fn async_write_read_round_trip() {
        // Exercise the real async length-header path over a bidirectional pipe.
        let (mut a, mut b) = tokio::io::duplex(4096);
        let key = [0u8; 32]; // pre-auth zero key
        let mut send_seq = 0u64;
        let mut recv_seq = 0u64;

        write_frame(
            &mut a,
            &key,
            &mut send_seq,
            "auth",
            "auth_request",
            Some(raw(r#"{"token":"abc","v":1}"#)),
        )
        .await
        .expect("write_frame");
        assert_eq!(send_seq, 1);

        let env = read_frame(&mut b, &key, &mut recv_seq)
            .await
            .expect("read_frame");
        assert_eq!(env.id, "auth");
        assert_eq!(env.seq, 1);
        assert_eq!(env.typ, "auth_request");
        assert_eq!(recv_seq, 1);
        assert_eq!(
            env.payload.as_ref().map(|r| r.get()),
            Some(r#"{"token":"abc","v":1}"#)
        );
    }
}
