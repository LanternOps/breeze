# PAM Path B (token_launch) — Hardware Validation Findings

**Date:** 2026-07-16
**Branch:** `ToddHebebrand/PAM-Testing` (top commit `35e0d22f9 feat(pam): Path B token-launch elevation actuator (#1157)`, rebased on current main)
**Binary under test:** dev-pushed `dev-1784179480`, agent strategy `pam_actuator_strategy: token_launch`
**Host:** Windows Server 2022 Standard (21H2), VM `100.101.150.55`, device `WIN-DHQNR1F8LO2`
**Stack:** wt-stack `breeze-wt-toddhebebrand-pam-testing`, web `localhost:32783`

> Note on worktrees: the validated actuator code (`internal/pamactuator/tokenlaunch_windows.go`, `session_resolve.go`, `strategy_windows.go`) exists **only** in this `PAM-Testing` worktree, not in the sibling `PAM-Testing-2` branch. Cite/patch here.

---

## Result: Path B validated end-to-end ✅

The full pipeline was exercised against a real interactive UAC prompt and completed:

**ETW-15028 detect → server `auto_approved` → Breeze approval dialog → user Approve → `pam_dialog_result` correlates → `token_launch` resolves session → `LogonUser(~breeze_elev)` + `CreateProcessAsUser` → elevated process launched.**

Evidence (request `44c0b2fc-e9c2-418e-bc28-52ded3aa030d`, target `C:\Windows\System32\mmc.exe`, subject `WIN-DHQNR1F8LO2\pamtest`):

- Agent log:
  ```
  pamactuator: resolved target session   session=3  source=username_lookup  subjectUsername=pamtest
  pamactuator: token_launch complete      pid=2916
  pam: local actuation complete           success=true  reason=ok
  ```
- Windows Security log (authoritative): `4624 TargetUserName=~breeze_elev LogonType=2 (interactive) ProcessName=…\breeze-agent.exe` at 08:51:18.
- Server DB `elevation_requests`: `flow_type=uac_intercept`, `status=auto_approved`, correct subject/hash/path.
- `~breeze_elev` is `Account active: No` at rest (used just-in-time, re-disabled).

So the previously fail-closed `winTokenLauncher.Launch` stub is now real Win32, and session resolution (`username_lookup`: subject username → live session via WTS enumeration) works.

---

## Test environment prerequisites (how this was made to work)

Two host conditions had to be forced; **both are the subject of findings below**, not permanent config:

1. A split-token admin (`pamtest`) was made the **console** session via `tscon <sid> /dest:console` (run as SYSTEM). Detection reads the console user (Finding 1).
2. `PromptOnSecureDesktop=0` was set so the Breeze approval dialog was visible/clickable (Finding 3).

Also disabled Server Manager auto-launch (`HKLM\SOFTWARE\Microsoft\ServerManager\DoNotOpenServerManagerAtLogon=1`) to cut UAC noise.

---

## Finding 1 — Detection requires a resolvable *console* user; RDP sessions are dropped silently

**Symptom:** With the tester connected only via RDP / Breeze-Remote (an `rdp-tcp` session), every UAC 15028 was intercepted by ETW but produced **no log, no queue entry, no server row** — a completely silent drop.

**Root cause:** `decodeConsentRequest` (`internal/etwlua/etwlua_windows.go:162`) resolves the subject via `resolveConsentUser` → `lookupConsoleUser` (`:223`), which calls `WTSGetActiveConsoleSessionId()` (`:224`). If the physical console (session 1) has no logged-in user, `WTSQueryUserToken` fails → user `""` → the function returns `ok=false` and the event is dropped with no logging.

**Evidence:** Independent ETW capture (`logman` on `{93c05d69-…}`) confirmed the LUA provider *does* emit 15028 on Server 2022; the agent's `Breeze-LUA-Discovery` session was Running with permissive enable (level `0xff`, keyword match-all) — reception was fine. Only after `tscon`-ing `pamtest` onto the console did detection fire and post.

**Impact:** On any RDP-only host (the common server case), UAC prompts raised in an rdp-tcp session are never attributed → Path B never engages. This is the unwired **SubjectSessionID seam**.

**Proposed fix:** Parse the requester's session from the 15028 payload header (SubjectSessionID) and resolve *that* session's user, instead of always using the active console session. Falls back to console only when the payload lacks it. Until then, at minimum emit a debug log on the empty-user drop so it isn't silent.

---

## Finding 2 — Consent suppression / deny-dismiss fails cross-session (`OpenInputDesktop` "Incorrect function")

**Symptom:** `token_launch` logged `best-effort consent suppression did not succeed … launching anyway` and elevated correctly, but the **original `consent.exe` was never dismissed** — a stale UAC prompt lingers beside the newly-elevated app. The deny path fails identically (`pam: deny enforcement FAILED — consent.exe may still be live`).

**Root cause:** The dismiss/suppress runs in the **session-0 agent process** and calls `OpenInputDesktop` (`internal/pamactuator/actuator_windows.go:165`, `Dismiss` at `:159`; suppression branch `internal/pamactuator/tokenlaunch_windows.go:96`). A session-0 process cannot open another session's input desktop, so the call returns `ERROR_INVALID_FUNCTION` → `desktop_open_failed`. This is desktop-independent — it failed even with `PromptOnSecureDesktop=0`.

**Impact:** Cosmetic-but-real: the OS UAC prompt remains on screen after Breeze has already elevated the target; and hard denies can't actually cancel the prompt.

**Proposed fix:** Run the consent dismiss inside the target session (via the session helper / `spawnSessionHelper`) so `OpenInputDesktop`/`SetThreadDesktop` execute in the right window station, rather than from the session-0 agent.

---

## Finding 3 — Secure desktop hides the approval dialog → 90s timeout; auto_approve is not silent

**Symptom:** With `PromptOnSecureDesktop=1`, the Breeze approval dialog (rendered by the user-helper on the default desktop) is hidden behind Winlogon's secure desktop. The user never sees it; the broker round-trip times out at 90s and fail-closes to deny. A late click on a stale dialog logs `unknown message type from helper, ignoring … pam_dialog_result`.

**Root cause / mechanism:**
- `RunPamFlow` (`internal/heartbeat/pam_flow.go:31`) issues the dialog round-trip for **both** `AutoApproved` and `Pending`, bounded by `pamDialogTimeout = 90s` (`:19`).
- `ComposePamDecision` (`internal/sessionbroker/pam_decision.go:18`) checks the dialog **first**: `if !dialog.Approved || dialog.DismissedByUser { return PamActionDeny }` (`:19`). So **auto_approve still requires the end user's Approve click** — "auto" means "no technician needed," not "silent."
- A reply only correlates if its waiter is still alive: `RecvLoop` → `HandleResponse` (`internal/sessionbroker/session.go:162`), keyed via `expectedResponseType(TypePamRequestDialog)=TypePamDialogResult` (`:372`). After the 90s timeout the waiter is gone, so a late `pam_dialog_result` falls through to the dispatch `default` (`internal/sessionbroker/broker.go:2571`) and is dropped. This is **not** a hard plumbing bug — a prompt click within 90s correlates (proven by the successful run).

**Impact:** On any default-UAC host, Path B always times out to deny unless the operator disables the secure desktop. Not viable as shipped.

**Proposed fix:** Render the Breeze approval dialog on the **secure desktop** (the helper must `OpenInputDesktop`/`SetThreadDesktop` onto Winlogon while consent is up), or explicitly document/require `PromptOnSecureDesktop=0`. Consider also surfacing the orphaned-reply case as a metric rather than a bare warning.

---

## Recommended follow-ups (priority order)

1. **Finding 3** (secure-desktop dialog) — blocks default-config hosts; highest UX impact.
2. **Finding 2** (in-session consent dismiss) — removes the lingering prompt and fixes deny enforcement.
3. **Finding 1** (SubjectSessionID seam) — required for RDP-session targeting; needed for real server fleets.
4. **Pre-PR cleanup:** strip diag scaffolding — `internal/pamactuator/diag_windows.go`, `cmd/pamlaunchtest`, `DiagResolveSession`, and the `-subject` flag.

Related: `2026-07-03-pam-path-b-token-launch-actuator.md` (design), `2026-07-03-pam-path-b-vm-validation.md` (matrix).
