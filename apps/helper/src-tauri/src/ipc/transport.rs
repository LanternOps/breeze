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

/// Well-known SID for the Windows Local System account. The agent's
/// privileged broker service only ever runs under this account, so an IPC
/// client can use it as the trust anchor when verifying the identity of the
/// process on the other end of a named pipe (see [`verify_server_identity`]).
#[cfg_attr(not(windows), allow(dead_code))]
pub const SYSTEM_SID: &str = "S-1-5-18";

/// Reports whether a named-pipe server's kernel-verified token SID
/// identifies it as the Local System account. Pure — no syscalls, no
/// filesystem access — so it is unit-testable on every platform this crate
/// builds for, not just Windows, where the actual SID is resolved via
/// `GetNamedPipeServerProcessId` + `OpenProcessToken`. Only called from
/// windows-only production code, hence the unix dead_code allowance — it is
/// still exercised directly by the cross-platform tests below.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn verify_server_sid(sid: &str) -> bool {
    sid == SYSTEM_SID
}

/// Reports whether a named-pipe server's kernel-resolved image path matches
/// the expected installed agent binary. Comparison is case-insensitive; an
/// empty actual or expected path never matches — fail closed rather than
/// treat "unknown" as trusted. Pure so it is unit-testable without touching
/// the filesystem or any Windows API. Only called from windows-only
/// production code, hence the unix dead_code allowance.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn verify_server_binary_path(actual: &str, expected: &str) -> bool {
    if actual.is_empty() || expected.is_empty() {
        return false;
    }
    actual.eq_ignore_ascii_case(expected)
}

/// `FILE_GENERIC_READ`: READ_CONTROL | FILE_READ_DATA | FILE_READ_ATTRIBUTES
/// | FILE_READ_EA | SYNCHRONIZE — exactly what the `GENERIC_READ` generic
/// right maps to on a file or pipe object.
#[cfg_attr(not(windows), allow(dead_code))]
pub const FILE_GENERIC_READ_MASK: u32 = 0x0012_0089;
/// `FILE_WRITE_DATA`: write message bytes to the pipe.
#[cfg_attr(not(windows), allow(dead_code))]
pub const FILE_WRITE_DATA_MASK: u32 = 0x0000_0002;
/// `FILE_APPEND_DATA`, which on a named pipe means
/// `FILE_CREATE_PIPE_INSTANCE`: the right to add another server instance to
/// an existing pipe name. Clients never need it.
#[cfg_attr(not(windows), allow(dead_code))]
pub const FILE_CREATE_PIPE_INSTANCE_MASK: u32 = 0x0000_0004;

/// Access mask granted to Interactive Users by the broker pipe's DACL
/// (`agent/internal/sessionbroker/broker_windows.go`, `pipeSecurity`:
/// `(A;;0x0012019b;;;IU)`). Kept here so the tests can prove the client never
/// asks for more than the broker grants.
#[cfg_attr(not(windows), allow(dead_code))]
pub const BROKER_PIPE_INTERACTIVE_USER_GRANT: u32 = 0x0012_019B;

/// Access mask this client requests when opening the broker's named pipe:
/// `FILE_GENERIC_READ | FILE_WRITE_DATA` (0x0012008B).
///
/// This is the same effective access the Go IPC clients request
/// (`ipc.PipeClientAccessMask` = `GENERIC_READ | FILE_WRITE_DATA`), spelled
/// with explicit rights only. The default `ClientOptions::open` asks for
/// `GENERIC_READ | GENERIC_WRITE`; `GENERIC_WRITE` expands to
/// `FILE_GENERIC_WRITE`, which includes `FILE_APPEND_DATA`
/// (= `FILE_CREATE_PIPE_INSTANCE` on a pipe), a right a client never needs
/// and that the broker's DACL does not grant to Interactive Users. Least
/// privilege, not a compatibility requirement: Windows only enforces that
/// right when a server instance is created, so a `GENERIC_WRITE` client open
/// still succeeds. Byte-mode reads and writes need nothing beyond this mask
/// (no `FILE_WRITE_ATTRIBUTES`: the client never switches the pipe to message
/// read mode).
#[cfg_attr(not(windows), allow(dead_code))]
pub const PIPE_CLIENT_ACCESS: u32 = FILE_GENERIC_READ_MASK | FILE_WRITE_DATA_MASK;

/// Name of the Windows service that hosts the agent broker.
#[cfg_attr(not(windows), allow(dead_code))]
pub const AGENT_SERVICE_NAME: &str = "BreezeAgent";

/// Extract the executable path from a service's configured command line
/// (`QUERY_SERVICE_CONFIGW::lpBinaryPathName`), e.g.
/// `"C:\Program Files\Breeze\breeze-agent.exe" run` →
/// `C:\Program Files\Breeze\breeze-agent.exe`.
///
/// A quoted path is taken up to its closing quote (an unterminated quote
/// yields `None`). An unquoted path is taken through the first `.exe`
/// (case-insensitive), or up to the first whitespace when there is none.
/// Pure so it is unit-tested on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn service_image_executable(command_line: &str) -> Option<String> {
    let s = command_line.trim();
    let path = if let Some(rest) = s.strip_prefix('"') {
        let end = rest.find('"')?;
        &rest[..end]
    } else if let Some(idx) = s.to_ascii_lowercase().find(".exe") {
        &s[..idx + ".exe".len()]
    } else {
        s.split_whitespace().next().unwrap_or("")
    };
    let path = path.trim();
    if path.is_empty() {
        None
    } else {
        Some(path.to_string())
    }
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
    use windows::Win32::System::Threading::GetCurrentProcess;
    // SAFETY: GetCurrentProcess is a pseudo-handle, always valid, no cleanup.
    let self_handle = unsafe { GetCurrentProcess() };
    sid_string_from_process(self_handle)
}

/// Obtain the given process handle's token-user SID as an "S-1-5-.." string.
/// Shared by [`current_sid_string`] (this process) and
/// [`verify_server_identity`] (the process on the other end of a named
/// pipe) — the only difference between the two callers is which process
/// handle they pass in.
#[cfg(windows)]
fn sid_string_from_process(process: windows::Win32::Foundation::HANDLE) -> Result<String, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
    use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
    use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows::Win32::System::Threading::OpenProcessToken;

    // SAFETY: All WinAPI calls below operate on a token handle we open and
    // close ourselves; buffers are sized via the first GetTokenInformation
    // call and the resulting SID string is freed with LocalFree.
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(process, TOKEN_QUERY, &mut token)
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
        let sid = pwstr
            .to_string()
            .map_err(|e| format!("SID utf16 decode failed: {e}"))?;
        // LocalFree expects an HLOCAL; the SID-string buffer is LocalAlloc'd.
        // windows 0.62: LocalFree takes Option<HLOCAL>.
        let _ = LocalFree(Some(HLOCAL(pwstr.0 as *mut core::ffi::c_void)));
        Ok(sid)
    }
}

/// Expected path of the agent broker binary.
///
/// Breeze Assist is NOT installed next to the agent (it lives under
/// `%ProgramFiles%\Breeze Helper\`, the agent under `%ProgramFiles%\Breeze\`),
/// so the sibling-of-self rule the Go clients use does not apply here. The
/// authoritative answer is the executable configured for the `BreezeAgent`
/// service, which is what the broker runs as. If the service configuration
/// cannot be read, fall back to the MSI's default install location
/// (`%ProgramFiles%\Breeze\breeze-agent.exe`, mirroring the Go helper
/// manager's `%ProgramFiles%` resolution) so the path comparison is still
/// enforced rather than skipped.
#[cfg(windows)]
fn expected_agent_binary_path() -> Option<String> {
    agent_service_binary_path().or_else(|| {
        let pf = std::env::var("ProgramFiles")
            .ok()
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| r"C:\Program Files".to_string());
        Some(
            std::path::Path::new(&pf)
                .join("Breeze")
                .join("breeze-agent.exe")
                .to_string_lossy()
                .into_owned(),
        )
    })
}

/// Executable path configured for the agent service, via the Service Control
/// Manager. Needs only `SC_MANAGER_CONNECT` + `SERVICE_QUERY_CONFIG`, which
/// the default service DACL grants to interactive users. `None` on any
/// failure.
#[cfg(windows)]
fn agent_service_binary_path() -> Option<String> {
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::System::Services::{
        CloseServiceHandle, OpenSCManagerW, OpenServiceW, QueryServiceConfigW,
        QUERY_SERVICE_CONFIGW, SC_MANAGER_CONNECT, SERVICE_QUERY_CONFIG,
    };

    // SAFETY: both service handles are opened and closed within this block;
    // the config buffer is sized by the first QueryServiceConfigW call, is
    // 8-byte aligned (Vec<u64>) as QUERY_SERVICE_CONFIGW requires, and the
    // string it points into is copied out before the buffer is dropped.
    unsafe {
        let scm = OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_CONNECT).ok()?;
        let service = match OpenServiceW(
            scm,
            &HSTRING::from(AGENT_SERVICE_NAME),
            SERVICE_QUERY_CONFIG,
        ) {
            Ok(s) => s,
            Err(_) => {
                let _ = CloseServiceHandle(scm);
                return None;
            }
        };

        let mut needed: u32 = 0;
        // First call sizes the buffer (expected to fail with
        // ERROR_INSUFFICIENT_BUFFER).
        let _ = QueryServiceConfigW(service, None, 0, &mut needed);
        let mut result = None;
        if needed > 0 {
            let words = (needed as usize).div_ceil(std::mem::size_of::<u64>());
            let mut buf: Vec<u64> = vec![0; words];
            let config = buf.as_mut_ptr() as *mut QUERY_SERVICE_CONFIGW;
            if QueryServiceConfigW(service, Some(config), needed, &mut needed).is_ok() {
                let raw = (*config).lpBinaryPathName;
                if !raw.is_null() {
                    if let Ok(cmd) = raw.to_string() {
                        result = service_image_executable(&cmd);
                    }
                }
            }
        }

        let _ = CloseServiceHandle(service);
        let _ = CloseServiceHandle(scm);
        result
    }
}

/// What the client could learn about the pipe server's process, when it was
/// allowed to open it for query.
#[cfg_attr(not(windows), allow(dead_code))]
#[derive(Debug, Clone)]
pub struct ServerProcess {
    /// Token-user SID of the server process.
    pub sid: String,
    /// Full image path, when it could be resolved.
    pub image_path: Option<String>,
}

/// Pure trust decision for a named-pipe server, mirroring the Go
/// `ipc.CheckServerIdentity`.
///
/// - `pipe_owner_sid`: owner of the pipe object, read through the client's
///   own handle. Must be Local System. Windows refuses to let a process
///   assign an owner SID it does not hold (`ERROR_INVALID_OWNER`) unless it
///   has `SeRestorePrivilege`, so an unprivileged process cannot create a pipe
///   owned by Local System; the broker's SDDL sets `O:SY` explicitly.
/// - `process`: `Some` when the server process could be queried. Its SID
///   must then be Local System and, when `expected_path` is known, its image
///   must match. `None` when the client was refused access to the process —
///   the normal case for Assist, which runs as the logged-in user and cannot
///   open a Local System service even for limited query.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn check_server_identity(
    pipe_owner_sid: &str,
    process: Option<ServerProcess>,
    expected_path: Option<&str>,
) -> Result<(), String> {
    if pipe_owner_sid != SYSTEM_SID {
        return Err(format!(
            "pipe owner SID {pipe_owner_sid:?} is not the Local System account"
        ));
    }
    let Some(process) = process else {
        return Ok(());
    };
    if !verify_server_sid(&process.sid) {
        return Err(format!(
            "pipe server SID {:?} is not the Local System account",
            process.sid
        ));
    }
    if let Some(expected) = expected_path {
        let actual = process.image_path.unwrap_or_default();
        if !verify_server_binary_path(&actual, expected) {
            return Err(format!(
                "pipe server binary {actual:?} does not match expected agent binary {expected:?}"
            ));
        }
    }
    Ok(())
}

/// Client-side named-pipe server-trust check. Gathers kernel-verified
/// evidence about whoever accepted `stream` — the pipe object's owner, and
/// the server process's SID and image path when this process may query it —
/// and applies [`check_server_identity`]. Being refused access to the server
/// process (`E_ACCESSDENIED`, expected for an unprivileged client) leaves the
/// pipe-owner check as the evidence; any other failure fails closed.
///
/// Callers MUST drop `stream` and abandon the session on a non-`Ok` return
/// — it means the pipe may not be talking to the real agent broker (a
/// restart-window race, or another process owning that pipe name), so
/// nothing should be sent to it, including the auth request that carries
/// this helper's identity.
#[cfg(windows)]
pub fn verify_server_identity(
    stream: &tokio::net::windows::named_pipe::NamedPipeClient,
) -> Result<(), String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{CloseHandle, E_ACCESSDENIED, HANDLE};
    use windows::Win32::System::Pipes::GetNamedPipeServerProcessId;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    let pipe_handle = HANDLE(stream.as_raw_handle());
    let owner = pipe_owner_sid(pipe_handle)?;

    // SAFETY: pipe_handle is a live handle owned by `stream` for the
    // duration of this call; server_process is opened and closed within
    // this block.
    let process = unsafe {
        let mut server_pid: u32 = 0;
        GetNamedPipeServerProcessId(pipe_handle, &mut server_pid)
            .map_err(|e| format!("GetNamedPipeServerProcessId failed: {e}"))?;

        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, server_pid) {
            Ok(server_process) => {
                let sid = sid_string_from_process(server_process);
                let image_path = query_full_process_image_name(server_process);
                let _ = CloseHandle(server_process);
                Some(ServerProcess {
                    sid: sid?,
                    image_path,
                })
            }
            Err(e) if e.code() == E_ACCESSDENIED => None,
            Err(e) => return Err(format!("OpenProcess({server_pid}) failed: {e}")),
        }
    };

    let expected = expected_agent_binary_path();
    check_server_identity(&owner, process, expected.as_deref())
}

/// Owner SID of the pipe object behind `handle`, via `GetSecurityInfo`.
/// Needs only `READ_CONTROL`, which [`PIPE_CLIENT_ACCESS`] includes.
#[cfg(windows)]
fn pipe_owner_sid(handle: windows::Win32::Foundation::HANDLE) -> Result<String, String> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HLOCAL};
    use windows::Win32::Security::Authorization::{
        ConvertSidToStringSidW, GetSecurityInfo, SE_KERNEL_OBJECT,
    };
    use windows::Win32::Security::{OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID};

    // SAFETY: `handle` is a live pipe handle for the duration of the call.
    // GetSecurityInfo allocates the security descriptor (freed with
    // LocalFree below); `owner` points into it and is only used before that.
    // The SID string is LocalAlloc'd by ConvertSidToStringSidW and freed too.
    unsafe {
        let mut owner = PSID::default();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        let rc = GetSecurityInfo(
            handle,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            Some(&mut sd),
        );
        if rc != ERROR_SUCCESS {
            return Err(format!("GetSecurityInfo failed: {}", rc.0));
        }
        let result = if owner.0.is_null() {
            Err("pipe has no owner".to_string())
        } else {
            let mut pwstr = PWSTR::null();
            match ConvertSidToStringSidW(owner, &mut pwstr) {
                Ok(()) if !pwstr.is_null() => {
                    let s = pwstr
                        .to_string()
                        .map_err(|e| format!("owner SID decode: {e}"));
                    let _ = LocalFree(Some(HLOCAL(pwstr.0 as *mut core::ffi::c_void)));
                    s
                }
                Ok(()) => Err("ConvertSidToStringSidW returned null".to_string()),
                Err(e) => Err(format!("ConvertSidToStringSidW failed: {e}")),
            }
        };
        let _ = LocalFree(Some(HLOCAL(sd.0)));
        result
    }
}

/// Resolve a process handle's full image path, best-effort. Returns `None`
/// on any failure; callers that require the path treat `None` as a
/// mismatch (fail closed), never as an implicit match.
#[cfg(windows)]
fn query_full_process_image_name(process: windows::Win32::Foundation::HANDLE) -> Option<String> {
    use windows::core::PWSTR;
    use windows::Win32::System::Threading::QueryFullProcessImageNameW;

    let mut buf: Vec<u16> = vec![0u16; 32 * 1024];
    let mut len = buf.len() as u32;
    // SAFETY: buf is sized above and len is updated in place by the call.
    unsafe {
        QueryFullProcessImageNameW(
            process,
            windows::Win32::System::Threading::PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut len,
        )
        .ok()?;
    }
    Some(String::from_utf16_lossy(&buf[..len as usize]))
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
/// Opens the pipe with [`PIPE_CLIENT_ACCESS`] instead of
/// `ClientOptions::open`'s `GENERIC_READ | GENERIC_WRITE` (see
/// [`PIPE_CLIENT_ACCESS`]). Everything else matches
/// `ClientOptions::open`: no sharing, `OPEN_EXISTING`, overlapped I/O,
/// identification-level impersonation only, byte read mode.
///
/// Any open error — including `ERROR_PIPE_BUSY` while the broker is between
/// accepts — is returned as-is; the reconnect loop in `client::run` backs off
/// and retries.
///
/// `async` is kept for API symmetry with the unix variant even though the
/// open is synchronous, so the generic client calls `connect(...).await` on
/// both platforms without a cfg guard.
#[cfg(windows)]
pub async fn connect(
    path: &str,
) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    use std::os::windows::io::RawHandle;
    use tokio::net::windows::named_pipe::NamedPipeClient;
    use windows::core::HSTRING;
    use windows::Win32::Storage::FileSystem::{
        CreateFileW, FILE_FLAG_OVERLAPPED, FILE_SHARE_NONE, OPEN_EXISTING, SECURITY_IDENTIFICATION,
        SECURITY_SQOS_PRESENT,
    };

    // SAFETY: CreateFileW receives a NUL-terminated wide string that outlives
    // the call and no security attributes / template handle.
    let handle = unsafe {
        CreateFileW(
            &HSTRING::from(path),
            PIPE_CLIENT_ACCESS,
            FILE_SHARE_NONE,
            None,
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
            None,
        )
    }
    .map_err(win32_io_error)?;

    // SAFETY: `handle` is a freshly opened, valid, overlapped pipe handle that
    // nothing else references. Ownership moves into the NamedPipeClient,
    // which closes it on drop — and also on the error path, because tokio
    // wraps the handle in mio's NamedPipe before registering it, so a failed
    // registration drops (and closes) it. It must not be closed here. Must be
    // called inside a tokio runtime with the I/O driver enabled, which
    // `client::run` always is.
    unsafe { NamedPipeClient::from_raw_handle(handle.0 as RawHandle) }
}

/// Convert a `windows` crate error into an `io::Error` carrying the plain
/// Win32 error code (so `raw_os_error()` is e.g. 5 for access denied or 231
/// for pipe busy, as `ClientOptions::open` would report), rather than the
/// HRESULT the crate's own `From` impl passes through.
#[cfg(windows)]
fn win32_io_error(e: windows::core::Error) -> std::io::Error {
    let hr = e.code().0 as u32;
    if hr & 0xFFFF_0000 == 0x8007_0000 {
        std::io::Error::from_raw_os_error((hr & 0xFFFF) as i32)
    } else {
        std::io::Error::other(e)
    }
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

/// Pure comparison logic — no OS calls — so these run on every platform this
/// crate builds and tests for, not just Windows, where the actual SID and
/// image path are resolved via `GetNamedPipeServerProcessId` and friends.
#[cfg(test)]
mod server_identity_tests {
    use super::*;

    #[test]
    fn verify_server_sid_accepts_only_local_system() {
        assert!(verify_server_sid("S-1-5-18"));
        assert!(!verify_server_sid(""));
        assert!(!verify_server_sid(
            "S-1-5-21-111111111-222222222-333333333-1001"
        ));
        assert!(!verify_server_sid("S-1-5-19")); // Local Service
        assert!(!verify_server_sid("S-1-5-20")); // Network Service
        assert!(!verify_server_sid("s-1-5-18")); // case-sensitive
    }

    #[test]
    fn verify_server_binary_path_matches_case_insensitively() {
        assert!(verify_server_binary_path(
            r"C:\Program Files\Breeze\breeze-agent.exe",
            r"C:\Program Files\Breeze\breeze-agent.exe",
        ));
        assert!(verify_server_binary_path(
            r"c:\program files\breeze\breeze-agent.exe",
            r"C:\Program Files\Breeze\breeze-agent.exe",
        ));
    }

    #[test]
    fn verify_server_binary_path_rejects_mismatch() {
        assert!(!verify_server_binary_path(
            r"C:\Users\eve\AppData\Local\Temp\breeze-agent.exe",
            r"C:\Program Files\Breeze\breeze-agent.exe",
        ));
        assert!(!verify_server_binary_path(
            r"C:\Program Files\Breeze\other.exe",
            r"C:\Program Files\Breeze\breeze-agent.exe",
        ));
    }

    #[test]
    fn verify_server_binary_path_fails_closed_on_empty() {
        assert!(!verify_server_binary_path(
            "",
            r"C:\Program Files\Breeze\breeze-agent.exe"
        ));
        assert!(!verify_server_binary_path(
            r"C:\Program Files\Breeze\breeze-agent.exe",
            ""
        ));
        assert!(!verify_server_binary_path("", ""));
    }
}

/// Pure access-mask arithmetic — runs on every platform. The Windows-only
/// module below additionally pins the numeric values to the `windows` crate's
/// definitions.
#[cfg(test)]
mod pipe_access_tests {
    use super::*;

    #[test]
    fn client_access_is_generic_read_plus_write_data() {
        assert_eq!(PIPE_CLIENT_ACCESS, 0x0012_008B);
        assert_eq!(
            PIPE_CLIENT_ACCESS,
            FILE_GENERIC_READ_MASK | FILE_WRITE_DATA_MASK
        );
    }

    #[test]
    fn client_access_never_asks_for_pipe_instance_creation() {
        // FILE_APPEND_DATA doubles as FILE_CREATE_PIPE_INSTANCE on a pipe.
        assert_eq!(PIPE_CLIENT_ACCESS & FILE_CREATE_PIPE_INSTANCE_MASK, 0);
    }

    #[test]
    fn client_access_uses_no_generic_rights() {
        // Generic bits are expanded by the kernel (GENERIC_WRITE would pull in
        // FILE_APPEND_DATA), so the request must be explicit rights only.
        const GENERIC_BITS: u32 = 0xF000_0000;
        assert_eq!(PIPE_CLIENT_ACCESS & GENERIC_BITS, 0);
    }

    #[test]
    fn client_access_is_within_the_broker_interactive_user_grant() {
        assert_eq!(
            PIPE_CLIENT_ACCESS & !BROKER_PIPE_INTERACTIVE_USER_GRANT,
            0,
            "every requested bit must be granted to Interactive Users by the broker pipe DACL"
        );
    }

    #[test]
    fn service_image_path_parses_quoted_path_with_arguments() {
        assert_eq!(
            service_image_executable(r#""C:\Program Files\Breeze\breeze-agent.exe" run"#)
                .as_deref(),
            Some(r"C:\Program Files\Breeze\breeze-agent.exe")
        );
    }

    #[test]
    fn service_image_path_parses_unquoted_path() {
        assert_eq!(
            service_image_executable(r"C:\Breeze\breeze-agent.exe run").as_deref(),
            Some(r"C:\Breeze\breeze-agent.exe")
        );
        assert_eq!(
            service_image_executable(r"C:\Program Files\Breeze\BREEZE-AGENT.EXE run").as_deref(),
            Some(r"C:\Program Files\Breeze\BREEZE-AGENT.EXE")
        );
        assert_eq!(
            service_image_executable(r"  C:\Breeze\breeze-agent.exe  ").as_deref(),
            Some(r"C:\Breeze\breeze-agent.exe")
        );
    }

    #[test]
    fn service_image_path_rejects_empty_or_unterminated() {
        assert_eq!(service_image_executable(""), None);
        assert_eq!(service_image_executable("   "), None);
        assert_eq!(service_image_executable(r#""""#), None);
        assert_eq!(
            service_image_executable(r#""C:\Program Files\Breeze\breeze-agent.exe"#),
            None
        );
    }
}

/// Pins the hand-written mask constants to the `windows` crate's own
/// definitions so a typo in either cannot go unnoticed on the platform that
/// actually uses them.
#[cfg(all(test, windows))]
mod pipe_access_windows_tests {
    use super::*;
    use windows::Win32::Storage::FileSystem::{
        FILE_APPEND_DATA, FILE_GENERIC_READ, FILE_WRITE_DATA,
    };

    #[test]
    fn masks_match_windows_crate_definitions() {
        assert_eq!(FILE_GENERIC_READ_MASK, FILE_GENERIC_READ.0);
        assert_eq!(FILE_WRITE_DATA_MASK, FILE_WRITE_DATA.0);
        assert_eq!(FILE_CREATE_PIPE_INSTANCE_MASK, FILE_APPEND_DATA.0);
        assert_eq!(PIPE_CLIENT_ACCESS, (FILE_GENERIC_READ | FILE_WRITE_DATA).0);
    }
}

#[cfg(test)]
mod server_trust_tests {
    use super::*;

    const AGENT: &str = r"C:\Program Files\Breeze\breeze-agent.exe";
    const USER: &str = "S-1-5-21-111111111-222222222-333333333-1001";

    fn process(sid: &str, path: &str) -> Option<ServerProcess> {
        Some(ServerProcess {
            sid: sid.to_string(),
            image_path: Some(path.to_string()),
        })
    }

    #[test]
    fn accepts_system_owned_pipe_when_process_not_queryable() {
        assert!(check_server_identity(SYSTEM_SID, None, Some(AGENT)).is_ok());
    }

    #[test]
    fn accepts_system_owned_pipe_served_by_agent_binary() {
        assert!(check_server_identity(SYSTEM_SID, process(SYSTEM_SID, AGENT), Some(AGENT)).is_ok());
        assert!(check_server_identity(SYSTEM_SID, process(SYSTEM_SID, AGENT), None).is_ok());
    }

    #[test]
    fn rejects_pipe_not_owned_by_system() {
        assert!(check_server_identity(USER, None, Some(AGENT)).is_err());
        assert!(check_server_identity("S-1-5-32-544", None, Some(AGENT)).is_err());
        assert!(check_server_identity("", None, Some(AGENT)).is_err());
        assert!(check_server_identity(USER, process(SYSTEM_SID, AGENT), Some(AGENT)).is_err());
    }

    #[test]
    fn rejects_queried_process_that_is_not_the_agent() {
        assert!(check_server_identity(SYSTEM_SID, process(USER, AGENT), Some(AGENT)).is_err());
        assert!(check_server_identity(
            SYSTEM_SID,
            process(SYSTEM_SID, r"C:\Windows\System32\svchost.exe"),
            Some(AGENT)
        )
        .is_err());
        let no_path = Some(ServerProcess {
            sid: SYSTEM_SID.to_string(),
            image_path: None,
        });
        assert!(check_server_identity(SYSTEM_SID, no_path, Some(AGENT)).is_err());
    }
}
