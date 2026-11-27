//! Why Assist's IPC connection to the agent ended, told to the agent on the
//! next connection that authenticates (#12808). The oldest unreported loss is
//! kept until one does.
//!
//! On Windows Assist is a GUI-subsystem process: its stderr goes nowhere, so
//! a connection that kept dropping left no trace on the Assist side. After a
//! reconnect the session sends one `helper_log` record (the relay every
//! authenticated helper may use, #9266) naming the loss, so it reaches Agent
//! Logs next to the agent's own "session recv loop ended" line.
//!
//! The relayed reason is a fixed code, never an error's text: a payload parse
//! error from serde can quote the value it choked on (a token, prompt copy).
//! (The local stderr line keeps the full error, as it always has.)

use std::collections::BTreeMap;
use std::time::Duration;

use serde::Serialize;
use tokio::time::Instant;

use super::client::SessionError;
use super::envelope::IpcError;

/// The agent's `ipc.TypeHelperLog`.
pub(crate) const HELPER_LOG_TYPE: &str = "helper_log";

/// One lost connection, waiting to be reported on the next one.
#[derive(Debug, Clone)]
pub(crate) struct ConnectionLoss {
    reason: String,
    session: Duration,
    lost_at: Instant,
}

/// The agent's `ipc.HelperLogRecord` (JSON keys match). `time` is left out:
/// the agent stamps the line itself.
#[derive(Debug, Serialize)]
pub(crate) struct HelperLogRecord {
    level: &'static str,
    component: &'static str,
    message: &'static str,
    fields: BTreeMap<&'static str, String>,
}

impl ConnectionLoss {
    /// A session that ran for `session` ended at `lost_at` with `outcome`
    /// (`Ok` = the agent sent `disconnect`). `None` for an outcome that does
    /// not reconnect (a permanent reject).
    pub(crate) fn from_outcome(
        outcome: &Result<(), SessionError>,
        session: Duration,
        lost_at: Instant,
    ) -> Option<Self> {
        let reason = match outcome {
            Ok(()) => "agent_disconnect".to_string(),
            Err(SessionError::Transient(e)) => reason_code(e),
            Err(SessionError::PermanentReject(_)) => return None,
        };
        Some(Self { reason, session, lost_at })
    }

    /// A session that panicked (caught by the reconnect driver).
    pub(crate) fn panicked(session: Duration, lost_at: Instant) -> Self {
        Self { reason: "panic".to_string(), session, lost_at }
    }

    pub(crate) fn reason(&self) -> &str {
        &self.reason
    }

    /// The record sent once the new session is authenticated at `now`.
    pub(crate) fn helper_log_record(&self, now: Instant) -> HelperLogRecord {
        let mut fields = BTreeMap::new();
        fields.insert("reason", self.reason.clone());
        fields.insert("lostSessionMs", self.session.as_millis().to_string());
        fields.insert(
            "reconnectMs",
            now.saturating_duration_since(self.lost_at).as_millis().to_string(),
        );
        HelperLogRecord {
            level: "warn",
            component: "ipc",
            message: "Assist lost its connection to the agent and reconnected",
            fields,
        }
    }
}

/// A fixed code for why a session failed. Matches the messages built in
/// `envelope.rs` and `client.rs`; anything unrecognised is `protocol` or
/// `io_<kind>`, never the message itself.
pub(crate) fn reason_code(e: &IpcError) -> String {
    match e {
        IpcError::Io(io) if io.kind() == std::io::ErrorKind::UnexpectedEof => {
            if io.to_string().contains("mid-frame") {
                "closed_mid_frame".to_string()
            } else {
                "closed_by_agent".to_string()
            }
        }
        IpcError::Io(io) => format!("io_{:?}", io.kind()),
        IpcError::Protocol(m) => {
            // Prefixes only: a reject reason is the agent's text and may say
            // anything after its prefix.
            let code = if m.starts_with("pre_auth_reject") || m.starts_with("auth rejected") {
                "auth_rejected"
            } else if m.starts_with("unexpected handshake") || m.starts_with("auth_response") {
                "bad_handshake"
            } else if m.starts_with("message too large") {
                "frame_too_large"
            } else if m.starts_with("zero-length") {
                "frame_zero_length"
            } else if m.starts_with("HMAC mismatch") {
                "hmac_mismatch"
            } else if m.starts_with("sequence number") || m.starts_with("invalid sequence number") {
                "sequence"
            } else if m.starts_with("unmarshal envelope") {
                "bad_envelope"
            } else if m.starts_with("parse payload") || m.starts_with("missing payload") {
                "bad_payload"
            } else {
                "protocol"
            };
            code.to_string()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eof(msg: &str) -> IpcError {
        IpcError::Io(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, msg.to_string()))
    }

    #[test]
    fn reason_codes_are_fixed_and_never_carry_the_error_text() {
        let cases = [
            (eof("connection closed between frames"), "closed_by_agent"),
            (eof("connection closed mid-frame"), "closed_mid_frame"),
            (IpcError::Io(std::io::Error::from(std::io::ErrorKind::BrokenPipe)), "io_BrokenPipe"),
            (IpcError::Protocol("message too large: 2065852772 > 16777216".into()), "frame_too_large"),
            (IpcError::Protocol("zero-length message".into()), "frame_zero_length"),
            (IpcError::Protocol("HMAC mismatch".into()), "hmac_mismatch"),
            (IpcError::Protocol("sequence number 3 <= last 4 (replay/duplicate)".into()), "sequence"),
            (IpcError::Protocol("invalid sequence number 0".into()), "sequence"),
            (IpcError::Protocol("unmarshal envelope: expected value at line 1 column 1".into()), "bad_envelope"),
            // serde quotes the bad value: the code must not.
            (IpcError::Protocol("parse payload: invalid type: string \"secret-token\", expected u32".into()), "bad_payload"),
            (IpcError::Protocol("auth rejected: busy".into()), "auth_rejected"),
            // The agent's reason text never steers the code.
            (IpcError::Protocol("auth rejected: sequence number reset".into()), "auth_rejected"),
            (IpcError::Protocol("pre_auth_reject code=x reason=message too large".into()), "auth_rejected"),
            (IpcError::Protocol("unexpected handshake frame type: ping".into()), "bad_handshake"),
            (IpcError::Protocol("something new".into()), "protocol"),
        ];
        for (e, want) in cases {
            assert_eq!(reason_code(&e), want, "{e}");
        }
    }

    #[tokio::test(start_paused = true)]
    async fn the_record_matches_the_agent_helper_log_shape() {
        let lost_at = Instant::now();
        let err: Result<(), SessionError> = Err(SessionError::Transient(IpcError::Protocol(
            "parse payload: invalid type: string \"secret-token\"".into(),
        )));
        let loss = ConnectionLoss::from_outcome(&err, Duration::from_millis(30_004), lost_at).expect("reconnects");
        tokio::time::advance(Duration::from_millis(1_050)).await;
        let json = serde_json::to_value(loss.helper_log_record(Instant::now())).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "level": "warn",
                "component": "ipc",
                "message": "Assist lost its connection to the agent and reconnected",
                "fields": {"reason": "bad_payload", "lostSessionMs": "30004", "reconnectMs": "1050"},
            })
        );
        assert!(!json.to_string().contains("secret-token"));
    }

    #[test]
    fn a_clean_disconnect_is_reported_and_a_permanent_reject_is_not() {
        let now = Instant::now();
        let clean = ConnectionLoss::from_outcome(&Ok(()), Duration::ZERO, now).expect("reconnects");
        assert_eq!(clean.reason(), "agent_disconnect");
        let reject: Result<(), SessionError> = Err(SessionError::PermanentReject("x".into()));
        assert!(ConnectionLoss::from_outcome(&reject, Duration::ZERO, now).is_none());
        assert_eq!(ConnectionLoss::panicked(Duration::ZERO, now).reason(), "panic");
    }
}
