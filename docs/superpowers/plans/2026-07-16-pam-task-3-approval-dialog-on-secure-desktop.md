# PAM Task — Render the elevation-approval dialog on the active (secure) desktop

## Context & authorization

Breeze RMM includes a **Privileged Access Management (PAM)** feature. When an
authorized administrator triggers a Windows UAC elevation on a managed device,
Breeze intercepts the prompt, evaluates the organization's PAM policy, and — for
an approved request — presents the administrator with **Breeze's own confirmation
dialog** in place of the raw Windows UAC decision. Every request is logged as an
audited `elevation_requests` row. This is standard defensive enterprise IT
tooling: it lets an MSP centrally govern and audit privilege elevation on the
endpoints it manages, with the end user's explicit on-screen consent.

This task fixes a **display bug**: the confirmation dialog is currently drawn on a
desktop the user cannot see while the Windows prompt is up, so the user never gets
the chance to approve and the request silently times out.

## Problem

Windows renders the UAC prompt on the *secure desktop* (`winsta0\Winlogon`) when
`PromptOnSecureDesktop=1` (the OS default). Breeze's approval dialog is drawn by
the per-session **user-role** helper on the *default desktop* (`winsta0\Default`).
While the secure desktop is active, the default desktop is not visible or
interactive, so the administrator never sees the Breeze dialog. The broker's
approval round-trip (`pamDialogTimeout = 90s`, `internal/heartbeat/pam_flow.go:19`)
expires and `ComposePamDecision` fail-closes to deny
(`internal/sessionbroker/pam_decision.go:18`).

Hardware-validated 2026-07-16 (see
`2026-07-16-pam-path-b-hardware-validation-findings.md`, Finding 3): the flow only
completed after the operator set `PromptOnSecureDesktop=0`.

## Goal / acceptance criteria

- With `PromptOnSecureDesktop=1` (default), the administrator **sees** the Breeze
  approval dialog on top of / alongside the UAC prompt and can click **Approve**
  or **Deny**.
- Clicking Approve within the timeout completes the round-trip and the elevation
  actuates; Deny cancels it. No behavior change when the secure desktop is off.
- No regression to the existing dialog when no UAC prompt is active (normal
  default-desktop rendering still works).

## Files to touch

- `agent/internal/sessionbroker/` — the helper-side PAM dialog renderer (the code
  that today calls `MessageBox`/creates the dialog window in response to
  `ipc.TypePamRequestDialog`). Locate via `grep -rn 'TypePamRequestDialog\|MessageBox\|ShowPamDialog' agent/internal/`.
- `agent/internal/heartbeat/pam_flow.go` — where `RunPamFlow` selects the helper
  session (`FindCapableSession(ipc.ScopePam, …)`, line ~69) and calls
  `RequestPamApproval` (line ~80). May need to prefer the **system-role** helper
  for the dialog (see below).
- Possibly `agent/internal/userhelper/` — the helper process entrypoint that
  handles the dialog command.

## Implementation steps

1. **Determine the active input desktop at dialog time.** In the helper's PAM
   dialog handler, before creating the dialog window, query the current input
   desktop name:
   - `OpenInputDesktop(0, FALSE, GENERIC_ALL)` → handle to the desktop currently
     receiving input (this is `Winlogon` while a UAC prompt is up, `Default`
     otherwise).
   - `GetUserObjectInformationW(hDesk, UOI_NAME, …)` to read its name.
2. **Bind the dialog thread to that desktop.** `MessageBox` (and any window
   creation) renders on the *calling thread's* desktop. So:
   - `runtime.LockOSThread()` for the dialog thread.
   - `SetThreadDesktop(hDesk)` to the active input desktop.
   - Create/show the dialog. It now appears where the user is looking, including
     on the secure desktop.
   - Restore the original desktop and `UnlockOSThread` when done.
   (This mirrors the desktop-pinning already used elsewhere — see
   `pamactuator/actuator_windows.go:54-85` and `WindowsInputHandler.ensureInputDesktop`.)
3. **Run the dialog in the SYSTEM-role helper.** Only a SYSTEM/winlogon security
   context may open and draw on the secure desktop; the user-role helper cannot.
   The broker already spawns a **system-role** helper per session (observed:
   `role=system` connections in the session broker). Route the PAM dialog to that
   helper:
   - In `RunPamFlow`, change the session selection so the PAM dialog is requested
     from the session's system-role helper (scope/role filter), not the user-role
     helper.
   - Ensure the system helper's capability set advertises PAM-dialog capability.
4. **Fallback.** If `OpenInputDesktop` fails or the desktop name can't be read,
   fall back to the current default-desktop rendering (no worse than today).
5. **Config escape hatch (optional).** Keep honoring `PromptOnSecureDesktop=0` as
   a supported deployment where the secure-desktop path is unnecessary.

## APIs involved (and why)

- `OpenInputDesktop` — identify where the user's input is going (secure vs default
  desktop). Read-only discovery of the active desktop.
- `GetUserObjectInformationW(UOI_NAME)` — read the desktop's name to decide if it
  is the secure desktop.
- `SetThreadDesktop` — bind this thread's UI so the confirmation dialog is drawn
  where the administrator can see and click it. Standard Win32 for multi-desktop
  UI.

## Testing / verification

- On a Windows host with `PromptOnSecureDesktop=1`, a split-token admin triggers a
  UAC elevation for a policy-approved target. Assert the Breeze dialog is visible
  over the UAC prompt and Approve completes the round-trip (agent log
  `pam: local actuation complete success=true`).
- Regression: with `PromptOnSecureDesktop=0`, behavior unchanged.
- Regression: a non-UAC PAM dialog (if any) still renders on the default desktop.

## Out of scope

- The consent-prompt dismissal (that's Task 2).
- Session attribution (that's Task 1).

## Risks / notes

- Drawing on the secure desktop requires the SYSTEM context; verify the system
  helper has `SeTcbPrivilege`/appropriate window-station access.
- Keep the round-trip correlation intact — a reply that arrives after the 90s
  waiter expires is dropped as an unknown message
  (`internal/sessionbroker/broker.go:2571`; correlation via
  `session.go:162` `HandleResponse` / `expectedResponseType` `session.go:372`).
  If you raise the timeout, keep it under consent.exe's idle lifetime.
