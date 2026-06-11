//! Platform transport + peer identity for the IPC client.
//!
//! The broker (Go `agent/internal/ipc` + `sessionbroker`) validates the
//! `auth_request` we send against KERNEL-verified peer credentials:
//!   - unix (macOS/Linux): `auth_request.UID` MUST equal the kernel-resolved
//!     uid of this process, so [`current_identity`] returns `getuid()`.
//!   - windows: `auth_request.SID` MUST equal the kernel-resolved token-user
//!     SID of this process, so [`current_identity`] returns the real SID
//!     string from the process token.
//! Username is informational. The assist role runs as the logged-in user.

/// Default broker socket / named-pipe path for the current platform.
///
/// Mirrors the defaults baked into `agent/internal/ipc/auth_*.go`.
pub fn default_socket_path() -> String {
    #[cfg(windows)]
    {
        r"\\.\pipe\breeze-agent-ipc".to_string()
    }
    #[cfg(target_os = "macos")]
    {
        "/Library/Application Support/Breeze/agent.sock".to_string()
    }
    // Linux and other unix
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        "/var/run/breeze/agent.sock".to_string()
    }
}

/// Identity of this process as seen by the broker.
///
/// `sid` is empty on unix; `uid` is unused (0) on windows.
#[derive(Debug, Clone)]
pub struct PeerIdentity {
    /// Unix uid of this process; 0/unused on Windows.
    pub uid: u32,
    /// Windows token-user SID string (e.g. "S-1-5-21-…"); empty on unix.
    pub sid: String,
    /// Human-readable username — informational only, not verified by the broker.
    pub username: String,
    /// Current process id.
    pub pid: u32,
}

/// Resolve the current process identity.
#[cfg(unix)]
pub fn current_identity() -> Result<PeerIdentity, String> {
    // SAFETY: getuid() is always-succeeds, takes no args, has no side effects.
    let uid = unsafe { libc::getuid() };
    Ok(PeerIdentity {
        uid,
        sid: String::new(),
        // Username is informational; default to empty on error.
        username: whoami::username().unwrap_or_default(),
        pid: std::process::id(),
    })
}

/// Resolve the current process identity (windows).
///
/// Returns the real token-user SID string, which the broker compares against
/// the kernel-resolved SID of the connecting process.
#[cfg(windows)]
pub fn current_identity() -> Result<PeerIdentity, String> {
    let sid = current_sid_string()?;
    Ok(PeerIdentity {
        uid: 0, // unused on windows
        sid,
        // Username is informational; default to empty on error.
        username: whoami::username().unwrap_or_default(),
        pid: std::process::id(),
    })
}

/// Obtain this process's token-user SID as an "S-1-5-21-..." string.
#[cfg(windows)]
fn current_sid_string() -> Result<String, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{
        GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    // SAFETY: All WinAPI calls below operate on a token handle we open and
    // close ourselves; buffers are sized via the first GetTokenInformation
    // call and the resulting SID string is freed with LocalFree.
    unsafe {
        let mut token = HANDLE::default();
        // Open the current process token for query.
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token)
            .map_err(|e| format!("OpenProcessToken failed: {e}"))?;

        // First call: ask for the required buffer size (expected to fail with
        // ERROR_INSUFFICIENT_BUFFER, which we ignore in favor of `needed`).
        let mut needed: u32 = 0;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut needed);
        if needed == 0 {
            let _ = CloseHandle(token);
            return Err("GetTokenInformation returned zero size".to_string());
        }

        // Allocate and fetch the TOKEN_USER structure.
        let mut buf: Vec<u8> = vec![0u8; needed as usize];
        let info_ptr = buf.as_mut_ptr() as *mut core::ffi::c_void;
        let res = GetTokenInformation(token, TokenUser, Some(info_ptr), needed, &mut needed);
        // Token handle no longer needed once the info is copied into `buf`.
        let _ = CloseHandle(token);
        res.map_err(|e| format!("GetTokenInformation failed: {e}"))?;

        // The SID pointer lives inside the TOKEN_USER we just read.
        let token_user = &*(buf.as_ptr() as *const TOKEN_USER);
        let psid = token_user.User.Sid;

        // Convert the binary SID into its canonical string form.
        let mut pwstr = PWSTR::null();
        ConvertSidToStringSidW(psid, &mut pwstr)
            .map_err(|e| format!("ConvertSidToStringSidW failed: {e}"))?;
        if pwstr.is_null() {
            return Err("ConvertSidToStringSidW returned null".to_string());
        }

        // Copy the wide string into an owned Rust String, then free it.
        let sid = pwstr.to_string().map_err(|e| format!("SID utf16 decode failed: {e}"))?;
        // LocalFree expects an HLOCAL; the SID-string buffer is LocalAlloc'd.
        // windows 0.62: LocalFree takes Option<HLOCAL>.
        let _ = LocalFree(Some(HLOCAL(pwstr.0 as *mut core::ffi::c_void)));
        Ok(sid)
    }
}

/// Best-effort sha256 hex of the current executable.
///
/// NOT security-load-bearing: the broker recomputes the hash from the
/// kernel-resolved peer path. This field is informational only, so any error
/// yields an empty string rather than failing identity resolution.
pub fn self_binary_hash() -> String {
    use sha2::{Digest, Sha256};
    let path = match std::env::current_exe() {
        Ok(p) => p,
        Err(_) => return String::new(),
    };
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(_) => return String::new(),
    };
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    hex::encode(hasher.finalize())
}

/// Connect to the broker over a unix domain socket.
#[cfg(unix)]
pub async fn connect(path: &str) -> std::io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(path).await
}

/// Connect to the broker over a Windows named pipe.
///
/// `async` is kept for API symmetry with the unix variant even though
/// `ClientOptions::open` is synchronous — T10's generic client calls
/// `connect(...).await` on both platforms without needing a cfg guard.
#[cfg(windows)]
pub async fn connect(
    path: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use tokio::net::windows::named_pipe::ClientOptions;
    // TODO(T13 Windows VM verify): retry on ERROR_PIPE_BUSY may be needed in T10.
    ClientOptions::new().open(path)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn identity_has_uid_and_pid() {
        let id = current_identity().expect("identity");
        assert_eq!(id.uid, unsafe { libc::getuid() });
        assert!(id.pid > 0);
        assert!(id.sid.is_empty(), "sid empty on unix");
    }

    #[test]
    fn default_path_is_unix_socket() {
        let p = default_socket_path();
        assert!(p.ends_with("agent.sock"));
    }

    #[test]
    fn self_hash_is_hex_or_empty() {
        let h = self_binary_hash();
        assert!(h.is_empty() || (h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit())));
    }
}
