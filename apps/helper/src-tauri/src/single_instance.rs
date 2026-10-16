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

/// Name of the per-session "show your window" event (#8138). Same `Local\`
/// scoping as the mutex: a launch only ever reaches its own session's helper.
#[cfg(windows)]
const SHOW_EVENT_NAME: &str = "Local\\com.breezermm.helper.show-window";

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Ask the session's running helper to show its main window. Called by a
/// manual launch that lost the single-instance race, which then exits.
/// Best effort: if no helper is listening there is nothing to show.
#[cfg(windows)]
pub fn signal_show() {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenEventW, SetEvent, EVENT_MODIFY_STATE};

    let name = wide(SHOW_EVENT_NAME);
    // SAFETY: `name` is a NUL-terminated UTF-16 buffer that outlives the call.
    match unsafe { OpenEventW(EVENT_MODIFY_STATE, false, PCWSTR(name.as_ptr())) } {
        Ok(handle) => {
            // SAFETY: `handle` is a valid event handle we own until CloseHandle.
            unsafe {
                if let Err(e) = SetEvent(handle) {
                    eprintln!("[helper] failed to signal running helper to show: {e}");
                }
                let _ = CloseHandle(handle);
            }
        }
        Err(e) => eprintln!("[helper] running helper is not listening for show requests: {e}"),
    }
}

/// Run `on_show` each time another launch in this session calls
/// [`signal_show`]. The event is auto-reset, so each signal fires once; the
/// listener thread lives for the life of the process.
#[cfg(windows)]
pub fn listen_for_show<F>(on_show: F)
where
    F: Fn() + Send + 'static,
{
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{HANDLE, WAIT_OBJECT_0};
    use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject, INFINITE};

    let name = wide(SHOW_EVENT_NAME);
    // SAFETY: `name` is a NUL-terminated UTF-16 buffer that outlives the call;
    // auto-reset (manual_reset = false), initially non-signalled.
    let handle = match unsafe { CreateEventW(None, false, false, PCWSTR(name.as_ptr())) } {
        Ok(h) => h,
        Err(e) => {
            eprintln!("[helper] show-request event unavailable, manual relaunch will not show the window: {e}");
            return;
        }
    };
    // HANDLE is a raw pointer; carry it across the thread boundary as an integer.
    let raw = handle.0 as isize;
    std::thread::spawn(move || loop {
        let handle = HANDLE(raw as *mut core::ffi::c_void);
        // SAFETY: the handle is never closed, so it stays valid for the process.
        if unsafe { WaitForSingleObject(handle, INFINITE) } != WAIT_OBJECT_0 {
            eprintln!("[helper] show-request wait failed; manual relaunch will not show the window");
            return;
        }
        on_show();
    });
}

/// The single-instance guard is Windows-only, so a second launch never gets
/// as far as signalling elsewhere. macOS uses `RunEvent::Reopen` instead.
#[cfg(not(windows))]
pub fn signal_show() {}

#[cfg(not(windows))]
pub fn listen_for_show<F>(_on_show: F)
where
    F: Fn() + Send + 'static,
{
}
