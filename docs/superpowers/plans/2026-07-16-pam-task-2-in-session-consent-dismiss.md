# PAM Task — Dismiss the original UAC prompt from within the target session

## Context & authorization

Breeze RMM's **Privileged Access Management (PAM)** feature governs Windows UAC
elevations on managed endpoints under an audited organization policy. When a
request is approved, Breeze elevates the target application on the administrator's
behalf; when it is denied, Breeze must **cancel** the pending Windows prompt.
After Breeze has made its decision, the *original* Windows UAC prompt should be
cleared so the user isn't left with a stale, now-meaningless dialog. This is the
same "close the OS prompt once policy has decided" behavior every PAM product
performs; it is administrative/defensive and fully authorized by the managing MSP.

## Problem

The routine that closes the original `consent.exe` prompt runs in the **session-0
agent service** and calls `OpenInputDesktop` to reach the interactive desktop:

- `windowsActuator.Dismiss` — `agent/internal/pamactuator/actuator_windows.go:159`
  (`OpenInputDesktop` at `:165`).
- token_launch best-effort suppression —
  `agent/internal/pamactuator/tokenlaunch_windows.go:96`.

A session-0 process cannot open an interactive session's input desktop, so the
call returns `ERROR_INVALID_FUNCTION` ("Incorrect function") and the prompt is
never closed. Hardware-validated 2026-07-16 (Finding 2): the elevation succeeded
but the original UAC prompt lingered on screen, and the hard-deny path likewise
could not cancel the prompt (`pam: deny enforcement FAILED — consent.exe may still
be live`).

## Goal / acceptance criteria

- After an **approved** elevation actuates, the original `consent.exe` prompt is
  gone (no lingering OS dialog next to the newly-elevated app).
- After a **denied** request, the original `consent.exe` prompt is cancelled.
- `OpenInputDesktop`/desktop operations succeed because they now run inside the
  target session rather than session 0.
- No change when there is no live prompt (idempotent: "already closed" is success,
  as today at `pam_flow.go` `denyConsent`, `res.Reason == "no_consent_window"`).

## Root cause in one line

Desktop operations are session-relative; they must run **in the target session**,
not in the session-0 service.

## Files to touch

- `agent/internal/ipc/message.go` — add a new command + result message type
  (`TypePamDismissConsent` / `TypePamDismissResult`) and register the expected
  response mapping.
- `agent/internal/sessionbroker/session.go` — add the request→response mapping in
  `expectedResponseType` (`:372`) so the reply correlates through `HandleResponse`
  (`:162`).
- `agent/internal/sessionbroker/broker.go` — add a `DismissConsentInSession(session, id, timeout)`
  wrapper over `SendCommandAndWait`, and add the result type to the inbound
  dispatch (avoid the `default` "unknown message type" drop at `:2571`).
- `agent/internal/userhelper/` (or wherever the in-session helper handles commands)
  — implement the handler that performs the dismissal in-session.
- `agent/internal/heartbeat/pam_flow.go` — `denyConsent` and the token_launch
  suppression call site should invoke the in-session dismiss (via the resolved
  target session's **system-role** helper) instead of `newActuator().Dismiss`.
- `agent/internal/pamactuator/tokenlaunch_windows.go` — replace the session-0
  best-effort suppression (`:96`) with a call that delegates to the in-session
  helper.

## Implementation steps

1. **New IPC command.** Define `TypePamDismissConsent` (payload: elevation
   request id) and `TypePamDismissResult` (payload: success + reason). Wire
   `expectedResponseType(TypePamDismissConsent) = TypePamDismissResult`.
2. **In-session helper handler.** In the system-role helper, on
   `TypePamDismissConsent`:
   - `OpenInputDesktop(0, FALSE, GENERIC_ALL)` → succeeds here because the helper
     runs in the interactive session.
   - `SetThreadDesktop` to it (lock the OS thread first).
   - Locate the `consent.exe` prompt window on that desktop and close it — either
     post a cancel (`WM_CLOSE` / `VK_ESCAPE`) to the consent window, or, since the
     system-role helper has sufficient privilege, `TerminateProcess` the
     `consent.exe` instance. Terminating/cancelling `consent.exe` is how Windows
     records the elevation as declined; this is the intended "close the OS prompt"
     step.
   - Return `{success, reason}` (`reason="no_consent_window"` when already gone).
3. **Broker plumbing.** Add `DismissConsentInSession` using
   `SendCommandAndWait(systemHelperSession, id, TypePamDismissConsent, payload, timeout)`.
   Add `TypePamDismissResult` to the inbound dispatch switch so it is forwarded /
   correlated rather than dropped.
4. **Flow wiring.** `denyConsent` and the token_launch suppression path resolve
   the **target session** (reuse `pamactuator/session_resolve.go`) and send the
   dismiss to that session's system helper. Preserve the existing `pamActuateMu`
   serialization so dismiss and actuate never drive the same prompt concurrently.
5. **Fallback.** If no in-session helper is available, log clearly and leave the
   prompt (never worse than today); do not attempt the session-0 path.

## Testing / verification

- Approve path: after `token_launch complete`, assert no `consent.exe` remains in
  the target session (`Get-CimInstance Win32_Process -Filter "Name='consent.exe'"`).
- Deny path (policy hard-deny or dialog-declined): assert the prompt is cancelled
  and the request ends `denied`.
- Idempotency: dismiss when the prompt already closed returns success without
  error.

## Out of scope

- Rendering the approval dialog on the secure desktop (Task 3).
- Session attribution (Task 1).

## Risks / notes

- The system-role helper must have privilege to open the interactive/secure
  desktop and to terminate a SYSTEM-owned `consent.exe`. Verify on a hardened
  host.
- Keep the reply-correlation contract (Task 3 notes) — a late reply past the
  waiter timeout is dropped at `broker.go:2571`.
