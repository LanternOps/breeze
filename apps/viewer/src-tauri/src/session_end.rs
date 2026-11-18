//! #12129: closing a session window ends its desktop session natively.
//!
//! The close (title-bar button, Cmd+W / Close Window, and the close the
//! viewer's own Disconnect ends with) used to send End from a JS
//! `onCloseRequested` handler. With a JS close listener registered Tauri
//! prevents the close and waits for the page to destroy the window, so a hung
//! or crashed page could neither send End nor close the window.
//!
//! Rust now owns the close. The page arms this module with the session it is
//! showing (`arm_session_end`) and disarms it once it has sent End itself
//! (`disarm_session_end`). On `CloseRequested` for an armed window, the close
//! is held, End is sent from here with a bounded timeout, and the window is
//! destroyed whatever the outcome. End goes out BEFORE the webview (and with it
//! the peer connection) is torn down, so the agent cannot report the peer drop
//! first and the row records `operator_ended`, not `peer_disconnected`.
//!
//! Quitting the app does not come through `CloseRequested` and still ends as
//! `peer_disconnected`; changing that is a separate product decision.
//!
//! The access token is held in memory only, keyed by window, and is never
//! logged.

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;
use url::Url;

/// Matches `END_DESKTOP_SESSION_TIMEOUT_MS` in `src/lib/api.ts`: a close never
/// waits longer than this for the API.
pub const END_TIMEOUT: Duration = Duration::from_millis(2000);

/// The session a window is showing, and what is needed to end it.
#[derive(Clone, PartialEq, Eq)]
pub struct EndTarget {
    pub api_url: String,
    pub access_token: String,
    pub session_id: String,
}

// Hand-written so the access token can never reach a log through `{:?}`.
impl std::fmt::Debug for EndTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EndTarget")
            .field("api_url", &self.api_url)
            .field("session_id", &self.session_id)
            .finish_non_exhaustive()
    }
}

/// What to do with a window's close request.
#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// Nothing to end: let the close go ahead.
    Proceed,
    /// Hold the close, send End for this session, then destroy the window.
    EndFirst(EndTarget),
    /// End is already in flight for this window; keep holding the close.
    AlreadyClosing,
}

#[derive(Default)]
struct Inner {
    armed: HashMap<String, EndTarget>,
    closing: HashSet<String>,
}

#[derive(Default)]
pub struct SessionEndState(Mutex<Inner>);

impl SessionEndState {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding this lock cannot leave it inconsistent (each
        // method is a couple of map operations), so recover rather than lose
        // the close handling for every window.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The page is now showing `target` in `label`. Replaces any earlier arm.
    pub fn arm(&self, label: &str, target: EndTarget) {
        self.lock().armed.insert(label.to_string(), target);
    }

    /// The page has ended (or no longer shows) `session_id`. A disarm for an
    /// older session leaves a newer one armed, so a late call cannot cancel
    /// the End of a session that replaced it.
    pub fn disarm(&self, label: &str, session_id: &str) -> bool {
        let mut inner = self.lock();
        if inner
            .armed
            .get(label)
            .is_some_and(|t| t.session_id == session_id)
        {
            inner.armed.remove(label);
            return true;
        }
        false
    }

    pub fn on_close_requested(&self, label: &str) -> CloseDecision {
        let mut inner = self.lock();
        if inner.closing.contains(label) {
            return CloseDecision::AlreadyClosing;
        }
        match inner.armed.remove(label) {
            Some(target) => {
                inner.closing.insert(label.to_string());
                CloseDecision::EndFirst(target)
            }
            None => CloseDecision::Proceed,
        }
    }

    /// The held close could not destroy the window: let the next close
    /// request go ahead instead of holding it forever.
    pub fn close_failed(&self, label: &str) {
        self.lock().closing.remove(label);
    }

    /// The window is gone; drop everything held for it, including the token.
    pub fn forget(&self, label: &str) {
        let mut inner = self.lock();
        inner.armed.remove(label);
        inner.closing.remove(label);
    }
}

/// `POST {api_url}/api/v1/desktop-ws/{session_id}/viewer/end`, built the way
/// `buildApiUrl` in `src/lib/api.ts` builds it: any base path is kept, the
/// query and fragment are dropped, and the session id is one encoded segment.
pub fn end_url(api_url: &str, session_id: &str) -> Result<Url, String> {
    let mut url = Url::parse(api_url).map_err(|e| format!("invalid API URL: {e}"))?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err(format!("unsupported API URL scheme: {}", url.scheme()));
    }
    if session_id.is_empty() {
        return Err("empty session id".to_string());
    }
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "API URL cannot have a path".to_string())?;
        segments.pop_if_empty();
        segments.extend(["api", "v1", "desktop-ws", session_id, "viewer", "end"]);
    }
    Ok(url)
}

/// How the native End went, for the log line.
#[derive(Debug, PartialEq, Eq)]
pub enum EndOutcome {
    Ended,
    AlreadyEnded,
    Refused(u16),
    Failed,
}

pub fn classify_status(status: u16) -> EndOutcome {
    match status {
        200..=299 => EndOutcome::Ended,
        400 => EndOutcome::AlreadyEnded,
        other => EndOutcome::Refused(other),
    }
}

/// Sends End. Bounded by `END_TIMEOUT` and never fails: the caller destroys
/// the window whatever this returns.
pub async fn send_end(target: &EndTarget) -> EndOutcome {
    let url = match end_url(&target.api_url, &target.session_id) {
        Ok(url) => url,
        Err(err) => {
            eprintln!("Not ending the session on close: {err}");
            return EndOutcome::Failed;
        }
    };
    // Same TLS stack as the updater (rustls + ring); install the provider if
    // nothing has yet.
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
    let client = match reqwest::Client::builder().timeout(END_TIMEOUT).build() {
        Ok(client) => client,
        Err(err) => {
            eprintln!("Not ending the session on close: could not build an HTTP client: {err}");
            return EndOutcome::Failed;
        }
    };
    let request = client
        .post(url)
        .bearer_auth(&target.access_token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .send();
    let outcome = match tokio::time::timeout(END_TIMEOUT, request).await {
        Ok(Ok(resp)) => classify_status(resp.status().as_u16()),
        Ok(Err(err)) => {
            eprintln!("End session request failed on close; the session will end when the connection closes: {err}");
            EndOutcome::Failed
        }
        Err(_) => {
            eprintln!("End session request timed out on close; the session will end when the connection closes");
            EndOutcome::Failed
        }
    };
    if let EndOutcome::Refused(status) = outcome {
        eprintln!("End session request was refused on close (HTTP {status}); the session will end when the connection closes");
    }
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(session_id: &str) -> EndTarget {
        EndTarget {
            api_url: "https://api.example.com".to_string(),
            access_token: "viewer-tok".to_string(),
            session_id: session_id.to_string(),
        }
    }

    #[test]
    fn an_unarmed_window_closes_straight_away() {
        let state = SessionEndState::default();
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::Proceed
        );
    }

    #[test]
    fn an_armed_window_ends_its_session_before_closing() {
        let state = SessionEndState::default();
        state.arm("session-1", target("s1"));
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::EndFirst(target("s1"))
        );
        // Other windows are not affected.
        assert_eq!(
            state.on_close_requested("session-2"),
            CloseDecision::Proceed
        );
    }

    #[test]
    fn a_second_close_while_end_is_in_flight_keeps_holding() {
        let state = SessionEndState::default();
        state.arm("session-1", target("s1"));
        let _ = state.on_close_requested("session-1");
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::AlreadyClosing
        );
    }

    #[test]
    fn a_failed_destroy_lets_the_next_close_through() {
        let state = SessionEndState::default();
        state.arm("session-1", target("s1"));
        let _ = state.on_close_requested("session-1");
        state.close_failed("session-1");
        // End was already sent once; the next close does not send it again.
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::Proceed
        );
    }

    #[test]
    fn rearming_replaces_the_session_after_a_transport_switch() {
        let state = SessionEndState::default();
        state.arm("session-1", target("s1"));
        state.arm("session-1", target("s2"));
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::EndFirst(target("s2"))
        );
    }

    #[test]
    fn the_page_ending_the_session_itself_disarms_the_native_end() {
        let state = SessionEndState::default();
        state.arm("session-1", target("s1"));
        assert!(state.disarm("session-1", "s1"));
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::Proceed
        );
    }

    #[test]
    fn a_late_disarm_for_an_older_session_leaves_the_newer_one_armed() {
        let state = SessionEndState::default();
        state.arm("session-1", target("s2"));
        assert!(!state.disarm("session-1", "s1"));
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::EndFirst(target("s2"))
        );
    }

    #[test]
    fn a_destroyed_window_forgets_its_session_and_close_state() {
        let state = SessionEndState::default();
        state.arm("session-1", target("s1"));
        state.forget("session-1");
        assert_eq!(
            state.on_close_requested("session-1"),
            CloseDecision::Proceed
        );

        state.arm("session-2", target("s2"));
        let _ = state.on_close_requested("session-2");
        state.forget("session-2");
        assert_eq!(
            state.on_close_requested("session-2"),
            CloseDecision::Proceed
        );
    }

    #[test]
    fn debug_output_never_contains_the_token() {
        let shown = format!("{:?}", CloseDecision::EndFirst(target("s1")));
        assert!(shown.contains("s1"));
        assert!(!shown.contains("viewer-tok"));
    }

    #[test]
    fn end_url_matches_the_viewer_route() {
        assert_eq!(
            end_url("https://api.example.com", "11111111-1111-4111-8111-111111111111").unwrap().as_str(),
            "https://api.example.com/api/v1/desktop-ws/11111111-1111-4111-8111-111111111111/viewer/end"
        );
    }

    #[test]
    fn end_url_keeps_a_base_path_and_drops_query_and_fragment() {
        assert_eq!(
            end_url("https://example.com/breeze/?x=1#y", "s1")
                .unwrap()
                .as_str(),
            "https://example.com/breeze/api/v1/desktop-ws/s1/viewer/end"
        );
        assert_eq!(
            end_url("https://example.com/breeze", "s1")
                .unwrap()
                .as_str(),
            "https://example.com/breeze/api/v1/desktop-ws/s1/viewer/end"
        );
    }

    #[test]
    fn end_url_encodes_the_session_id_as_one_segment() {
        assert_eq!(
            end_url("https://example.com", "a/../b?c").unwrap().as_str(),
            "https://example.com/api/v1/desktop-ws/a%2F..%2Fb%3Fc/viewer/end"
        );
    }

    #[test]
    fn end_url_rejects_bad_input() {
        assert!(end_url("not a url", "s1").is_err());
        assert!(end_url("file:///etc/passwd", "s1").is_err());
        assert!(end_url("https://example.com", "").is_err());
    }

    /// A one-request HTTP server on localhost. `reply` None = never answer.
    fn serve_once(reply: Option<&'static str>) -> (String, std::sync::mpsc::Receiver<String>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut buf = vec![0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let _ = tx.send(String::from_utf8_lossy(&buf[..n]).to_string());
            match reply {
                Some(reply) => {
                    let _ = stream.write_all(reply.as_bytes());
                }
                None => std::thread::sleep(Duration::from_secs(10)),
            }
        });
        (format!("http://{addr}"), rx)
    }

    #[test]
    fn send_end_posts_to_the_end_route_with_the_viewer_token() {
        let (api_url, request) = serve_once(Some(
            "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        ));
        let target = EndTarget {
            api_url,
            access_token: "viewer-tok".to_string(),
            session_id: "s1".to_string(),
        };
        let outcome = tauri::async_runtime::block_on(send_end(&target));
        assert_eq!(outcome, EndOutcome::Ended);
        let request = request.recv().unwrap();
        assert!(
            request.starts_with("POST /api/v1/desktop-ws/s1/viewer/end HTTP/1.1\r\n"),
            "{request}"
        );
        assert!(
            request
                .to_ascii_lowercase()
                .contains("authorization: bearer viewer-tok\r\n"),
            "{request}"
        );
    }

    #[test]
    fn send_end_gives_up_after_the_timeout_so_the_close_is_never_stuck() {
        let (api_url, _request) = serve_once(None);
        let target = EndTarget {
            api_url,
            access_token: "viewer-tok".to_string(),
            session_id: "s1".to_string(),
        };
        let started = std::time::Instant::now();
        let outcome = tauri::async_runtime::block_on(send_end(&target));
        assert_eq!(outcome, EndOutcome::Failed);
        assert!(
            started.elapsed() < END_TIMEOUT + Duration::from_millis(1000),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn send_end_reports_an_unreachable_api_as_failed() {
        // Bind then drop, so the port is (almost certainly) closed.
        let port = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port();
        let target = EndTarget {
            api_url: format!("http://127.0.0.1:{port}"),
            access_token: "viewer-tok".to_string(),
            session_id: "s1".to_string(),
        };
        assert_eq!(
            tauri::async_runtime::block_on(send_end(&target)),
            EndOutcome::Failed
        );
    }

    #[test]
    fn status_classification_matches_the_page() {
        assert_eq!(classify_status(204), EndOutcome::Ended);
        assert_eq!(classify_status(400), EndOutcome::AlreadyEnded);
        assert_eq!(classify_status(401), EndOutcome::Refused(401));
        assert_eq!(classify_status(503), EndOutcome::Refused(503));
    }
}
