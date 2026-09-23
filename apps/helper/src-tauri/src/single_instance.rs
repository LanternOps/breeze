//! One Breeze Helper per login session (#6251).
//!
//! The agent checks for a running helper before it launches one, but a helper
//! started any other way (a spawn racing a slow start, an MSI Restart Manager
//! relaunch, a manual double-click) used to run alongside the first one for the
//! rest of the session. Fifteen accumulated on one laptop overnight.
//!
//! On Windows the guard is a named mutex in the `Local\` namespace, which is
//! private to the login session: two sessions (fast user switching, RDS) each
//! get their own helper, while a second instance inside the same session sees
//! the name already taken and exits before building any UI. The kernel drops
//! the mutex when the owning process exits for any reason, so a crashed or
//! terminated helper never blocks its replacement.

/// Name of the per-session mutex. `Local\` scopes it to the login session.
#[cfg(windows)]
const MUTEX_NAME: &str = "Local\\com.breezermm.helper.single-instance";

/// Holds the guard for the life of the process.
pub struct InstanceGuard {
    #[cfg(windows)]
    _handle: windows::Win32::Foundation::HANDLE,
}

// SAFETY: the handle is only ever held (never used) after creation, and a
// Win32 mutex handle is valid from any thread.
unsafe impl Send for InstanceGuard {}
unsafe impl Sync for InstanceGuard {}

/// Outcome of trying to become the session's only helper.
pub enum Acquire {
    /// This process is the helper for the session; keep the guard alive.
    Acquired(InstanceGuard),
    /// Another helper already runs in this session; this process should exit.
    #[cfg_attr(not(windows), allow(dead_code))]
    AlreadyRunning,
}

/// Try to become the only helper in this login session.
///
/// Fails open: if the mutex cannot be created at all, the helper keeps
/// running (returning `Acquired`) rather than leaving the session with no
/// helper. The agent-side duplicate sweep is the backstop for that case.
#[cfg(windows)]
pub fn acquire() -> Acquire {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
    use windows::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = MUTEX_NAME
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    // SAFETY: `name` is a NUL-terminated UTF-16 buffer that outlives the call;
    // no security attributes are passed (default DACL for this session).
    let created = unsafe { CreateMutexW(None, false, PCWSTR(name.as_ptr())) };
    match created {
        Ok(handle) => {
            // CreateMutexW returns a handle to the EXISTING mutex and sets
            // ERROR_ALREADY_EXISTS when another process created it first.
            // SAFETY: GetLastError has no preconditions.
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                // SAFETY: closing the handle we were just given.
                let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
                Acquire::AlreadyRunning
            } else {
                Acquire::Acquired(InstanceGuard { _handle: handle })
            }
        }
        Err(e) => {
            eprintln!("[helper] single-instance mutex unavailable, continuing: {e}");
            Acquire::Acquired(InstanceGuard {
                _handle: windows::Win32::Foundation::HANDLE::default(),
            })
        }
    }
}

/// The accumulation in #6251 is Windows-specific; no guard is taken elsewhere.
#[cfg(not(windows))]
pub fn acquire() -> Acquire {
    Acquire::Acquired(InstanceGuard {})
}
