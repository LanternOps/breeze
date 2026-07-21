# PAM Path B — On-VM Validation Matrix

**Companion to:** `2026-07-03-pam-path-b-token-launch-actuator.md` (Task 7)
**Design:** `docs/superpowers/specs/pam/2026-07-03-pam-path-b-token-launch-actuator-design.md`
**Target VM:** Windows test VM `100.101.150.55`

This is where the raw `winTokenLauncher.Launch` Win32 layer (the intentional stub from Task 3, `agent/internal/pamactuator/tokenlaunch_windows.go`) is implemented for real and iterated against hardware. Everything above it (config selection, strategy dispatch, orchestration, target plumbing, guaranteed-demote) is already merged and CI-green; this file covers only what cannot be proven off-hardware.

## Prerequisites

- [ ] Agent built from branch `ToddHebebrand/PAM-Testing` deployed to the VM (kill the watchdog first per the dev-push runbook so it doesn't revert the binary).
- [ ] `agent.yaml` on the VM: `pam_enabled: true` and `pam_actuator_strategy: token_launch`.
- [ ] A PAM rule that **auto-approves** the test target (e.g. `mmc.exe`) for a standard-user account, OR a technician ready to approve via the console/mobile.
- [ ] A **standard (non-admin)** user session on the VM to trigger elevations from.
- [ ] Agent restarted; confirm logs show the token_launch strategy is active.

## Raw-layer implementation notes (fill the Task-3 stub)

Implement `winTokenLauncher.Launch` with `golang.org/x/sys/windows`, in this order, each mapping to its Result reason on failure:

1. `LogonUser(username, ".", password, LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT)` → `logon_failed`
2. `SetTokenInformation(hToken, TokenSessionId, &sessionID, 4)` → `set_session_failed`
3. Grant the account's logon SID access to the window station + desktop DACL → `desktop_grant_failed` (revoke in a defer)
4. `CreateProcessAsUser(hToken, …, lpDesktop="winsta0\\default")` → `create_process_failed`
5. Close process/thread handles; return `{PID}`.

### ⚠️ Session resolution — DECISION REQUIRED (from Task 3 review)

The merged stub uses `WTSGetActiveConsoleSessionId()` (physical console). On an **RDP / multi-session** host this is the wrong session — the elevated process would land on the console, not in front of the requesting user. Before wiring step 2, decide:

- **Preferred:** resolve the **requesting user's** session (the session that raised the UAC event / owns the elevation request), not the console. The ETW discovery already knows the subject user; carry the session id (or resolve it from the user via `WTSEnumerateSessions`/`WTSQuerySessionInformation`) into the launch.
- If keeping console-only for the first pass, log it loudly and add an explicit "single-session only" caveat — do not ship multi-session silently broken.

Validate both a console-login case and an RDP-login case below.

**Seam status (post final-review Fix 2):** `tokenLaunchActuator.sessionResolver` is now shaped as
`func(Request) (uint32, error)` (was `func() (uint32, error)`) specifically so this fix has
somewhere to plug in — the default (`activeConsoleSessionID`) currently still ignores the `Request`
and returns the console session, unchanged in behavior. Implementing the **preferred** fix from
this seam additionally requires, none of which exist yet:

1. A subject-user/session field on `pamactuator.Request` and on `pamTarget` (the local-path struct
   that carries `{targetPath, cmdline}` today) so the resolver has something to resolve *from*.
2. Plumbing `ev`'s subject user (the ETW 15028 event already carries it) through the local
   `RunPamFlow` actuation path into that new `Request`/`pamTarget` field.
3. A new field on the remote `actuate_elevation` server command payload — **the remote path
   currently cannot resolve the requesting user at all**, since the server-echoed payload only
   carries `{targetPath, commandLine}` (see the design doc's "actuate payload carries the target"
   section). Server-side plumbing of the requesting user/session must land before the resolver can
   do anything useful on that path.

Only once all three exist can `sessionResolver`'s default be swapped from `activeConsoleSessionID`
to a real per-user resolver (e.g. via `WTSEnumerateSessions`/`WTSQuerySessionInformation`).

**RESOLVED (2026-07-15, #8 implemented — username→session resolve).** All three plumbing pieces now
exist and the default resolver is swapped:

1. `pamactuator.Request` gained `SubjectUsername` (the requesting account) and a reserved
   `SubjectSessionID` seam; `pamTarget` gained `SubjectUsername`.
2. Local path: `RunPamFlow` passes `ev.SubjectUsername` into `pamTarget` → `Request`.
3. Remote path: `apps/api/.../actuateElevation.ts` now selects and echoes the stored
   `elevation_requests.subject_username` into the `actuate_elevation` payload
   (`subjectUsername`); the agent's `actuatePayload`/`pamTarget`/`Request` carry it. **No DB
   migration** — `subject_username` was already a `NOT NULL` column.

New default resolver `resolveSubjectSession` (`tokenlaunch_windows.go`) applies the precedence in
the platform-neutral, CI-tested `resolveSubjectSessionWith`: explicit `SubjectSessionID` (reserved,
currently always 0) → **`SubjectUsername` → live session by name** (`sessionIDForUsername`, via
`WTSEnumerateSessions` + `WTSQuerySessionInformation(WTSUserName)`) → **`activeConsoleSessionID`
fallback**, logging which branch won. Server-supplied username selects only a *local* session; it
grants nothing (the `~breeze_elev` credential stays agent-minted).

**Residual (deliberately out of scope):** `SubjectSessionID` is left unwired because the ETW 15028
event's writing process is the session-0 AppInfo service, so its header session id is
non-interactive — using it would launch into session 0 (invisible). Consequently the **local ETW
path's session accuracy still depends on `ev.SubjectUsername`**, which today is resolved from the
*console* user (`etwlua.lookupConsoleUser`); on a multi-session host where the requester is NOT the
console user, the local path resolves to the console (no regression vs. prior behavior, but not yet
the true requester). The **remote/technician-approve path is fully correct** — it uses the
per-request stored `subject_username`. Improving local ETW subject accuracy (decode the 15028
session token, or map the true requesting process) is future work, tracked separately from #8.
Runtime correctness of the WTS resolver is a hardware check → **Case E (RDP)** below.

**Step 0 — best-effort Dismiss consent.exe (raw-layer note):** orchestration
(`tokenLaunchActuator.Trigger`, via its `suppress` seam) already calls the embedded
`windowsActuator.Dismiss` best-effort before invoking `winTokenLauncher.Launch` — so by the time
`Launch` runs, native `consent.exe` suppression has already been attempted and its result logged
(never blocking). `winTokenLauncher.Launch` itself does not need to (and should not) repeat this
step; it starts directly at `LogonUser`. Called out here so the suppression ordering isn't lost
when implementing the raw layer on the VM — Steps 1-5 below are Step 0's *sequel*, not a
replacement for it.

## Validation cases

- [ ] **A — Approve / launch (console):** standard user triggers UAC on the target → auto-approve rule fires. Assert: native `consent.exe` does **not** survive; the target runs **elevated** (Task Manager → elevated = Yes) **as `~breeze_elev`**; the window is **visible on the user's desktop** (not session 0).
- [ ] **B — Deny / block:** rule set to auto-deny (or technician denies) → target does **not** launch; `consent.exe` is dismissed. Nothing elevates.
- [ ] **C — `~breeze_elev` lifecycle:** after A and after B, run `net localgroup administrators` → `~breeze_elev` is **not** a member; confirm the account is disabled and its password was re-randomized (demote ran).
- [ ] **D — Failure demotes:** force a launch failure (e.g. bogus target path) → agent logs a failure reason; `~breeze_elev` is still demoted (mirrors the CI test `TestTokenLaunchFailureStillDemotes`).
- [ ] **E — RDP / multi-session:** repeat A from an **RDP** session → the elevated process appears in the **RDP user's** session, not the console. (This is the case the session-resolution decision above must satisfy.)
- [ ] **F — EDR / CVE-2026-20824:** run A with the customer EDR stack present → no `consent.exe` deadlock; the `CreateProcessAsUser` launch is not blocked. Cross-check the #1158 EDR-allowlist submissions cover the new launch pattern.

## Result reason codes to watch in agent logs

`ok`, `empty_target`, `session_lookup_failed`, `session_helper_failed`, `logon_failed`, `linked_token_failed`, `set_session_failed`, `desktop_grant_failed`, `create_process_failed`.

(`session_helper_failed` is the two-stage launcher's stage-0 reason: the SYSTEM
helper could not be spawned into the target session, or did not report a result
— see the #2(b) fix below.)

## VM finding (2026-07-03): UAC split-token → linked elevated token (FIXED)

Validated the raw layer on-VM via a SYSTEM harness (`agent/cmd/pamlaunchtest`, calling
`pamactuator.DiagLaunch` → the real `winTokenLauncher.Launch`), decoupled from ETW/helper/PAM-rule.

First on-hardware run surfaced a bug invisible off-hardware: `LogonUser` returns the **UAC-filtered
(limited) token** for a split-token admin, so `CreateProcessAsUser` failed
`create_process_failed: The requested operation requires elevation` (ERROR_ELEVATION_REQUIRED, 740)
when the target needs elevation. **Fix:** when `!tok.IsElevated()`, fetch `tok.GetLinkedToken()` and
`DuplicateTokenEx(→ TokenPrimary)`, launch with that (new reason `linked_token_failed`). After the
fix: launched `cmd.exe`/`mmc.exe` **as `pamtest` at High integrity in session 3** — verified
`whoami`=the account, `whoami /groups`=`High Mandatory Level`, CIM owner+sessionId. Launch layer for
cases A/E confirmed working; only the session **resolver** (console-only default) still needs wiring
to target the requesting user's session automatically — the primitive itself places into any session id.

## VM finding (2026-07-03) #2: CREATE_NEW_CONSOLE + black-window (desktop access)

Two further hardware-only defects surfaced when validating that the launched window is
actually *visible and usable* on the requesting user's desktop:

**(a) Missing `CREATE_NEW_CONSOLE` — headless console targets.** `CreateProcessAsUser` was
called with `dwCreationFlags=0`. A console target (cmd/powershell/CLI installers) then attaches
to the *parent's* console instead of allocating its own on the target session's desktop, so it
runs invisibly even though the token places it in the right session (the child's output even
leaked into the harness's redirected stdout file, and held that file handle open). **Fixed:**
pass `windows.CREATE_NEW_CONSOLE`. GUI targets ignore the flag.

**(b) Black, unpaintable window — launch-token logon SID lacks target-session desktop access.**
After (a), windows appeared on the user's session-3 RDP desktop but rendered **black with a
blank title bar** (frame + taskbar entry present, client area never paints) — identical for
console and GUI targets. Controlled experiment (all launched from a SYSTEM scheduled task into
session 3):

| Launch token | Result |
|---|---|
| `LogonUser(pamtest)` (foreign admin) | black |
| `LogonUser(user)` — fresh logon of the session-3 **owner** (profile already loaded) | black |
| `WTSQueryUserToken(3)` — session 3's **own interactive token** | **normal / white** |

The only variable that flips the outcome is the **logon SID**. Windows secures `WinSta0\Default`
on the *logon SID*, not the user SID. `WTSQueryUserToken` returns the token whose logon SID is
already in session 3's desktop DACL → paints. Every `LogonUser`-derived token — even for the same
user — gets a **new logon SID** absent from that DACL → frame only, no paint. Profile-loading is
ruled out (owner's fresh logon had the profile mounted and was still black).

The existing `grantSIDToInteractiveDesktop` intends to fix this but grants the **wrong session's**
window station: `openWindowStation("winsta0")`/`openDesktop("default")` resolve **relative to the
caller's session**, and the launcher is SYSTEM in **session 0** — so the ACE lands on session 0's
non-interactive `WinSta0`, a no-op for the session-3 render. A partial fix (hold the grant for the
process lifetime instead of a premature `defer revoke()` — which had been tearing the ACE out from
under conhost) is **already applied**, but the grant must additionally target the **correct
session's** window station/desktop.

**This affects production, not just the harness:** the real actuator runs `Launch` from SYSTEM
(needs `SE_TCB` for `LogonUser`/`SetTokenInformation`), so `~breeze_elev` hits the same wall.

**Fix direction (NOT yet implemented — architectural, deferred):** the winsta/desktop grant must
run in a context that can resolve the target session's window station. A session-0 process cannot
`OpenWindowStation` another session by plain name. Options: (1) perform the grant from a
SYSTEM-context helper spawned *into* the target session (its `winsta0`/`default` then resolve
correctly, and SYSTEM has `WRITE_DAC`); or (2) have the in-session user-helper (runs as the
session owner, who owns — and thus can re-DACL — their own `WinSta0\Default`) add `~breeze_elev`'s
logon SID, with the SYSTEM agent doing the `LogonUser`/`CreateProcessAsUser`. Either way the grant
must name the launch token's logon SID against the *live* interactive desktop. `LoadUserProfile`
for `~breeze_elev` is likely also wanted for a complete profile, but is not the cause of the black
window.

### #2(b) — FIXED (2026-07-04): two-stage SYSTEM-into-session helper (Option 1)

Implemented **Option 1** in `tokenlaunch_windows.go`. `winTokenLauncher.Launch` (SYSTEM,
session 0) no longer does the grant/launch itself; it now:

1. **Stage 0 (`spawnSessionHelper`, session 0):** duplicates *this process's own SYSTEM token*
   as a primary token, stamps it to the target session id (`SetTokenInformation(TokenSessionId)`,
   SYSTEM has `SE_TCB`), and re-execs the current binary (`os.Executable()`) as SYSTEM **into the
   target session** via `CreateProcessAsUser`, carrying a `--pam-session-launch-helper` sentinel.
   Launch params (incl. the credential) go over the child's **stdin pipe** (never argv/env); the
   result comes back over its **stdout pipe** (stderr → `NUL` so it can't corrupt the JSON). Stage 0
   detaches — the helper outlives it.
2. **Stage 1 (`MaybeRunSessionLaunchHelper` → `inSessionLaunch`, target session):** now that the
   helper is SYSTEM *inside* the target session, `OpenWindowStation("winsta0")`/`OpenDesktop("default")`
   resolve to the **session's live interactive desktop**, and SYSTEM holds `WRITE_DAC`. It runs the
   original sequence there: `LogonUser` → linked-token swap → `SetTokenInformation(session)` →
   `grantSIDToInteractiveDesktop(logon SID)` → `CreateProcessAsUser(target, lpDesktop=winsta0\default)`.
   The helper then holds the grant for the launched process's UI lifetime (blocks on the process,
   then revokes) — replacing the old in-process watcher goroutine.

`MaybeRunSessionLaunchHelper()` must be called at the top of `main()` (before flag parsing) in any
binary hosting `winTokenLauncher` — wired into `cmd/pamlaunchtest` today; the **agent main still
needs this call before Path B ships** (part of task #9's production wiring).

**Also added (best-effort, non-fatal):** `LoadUserProfile` + `CreateEnvironmentBlock` for the launch
account (via `userenv.dll`), so the elevated app gets `~breeze_elev`'s HKCU/`APPDATA`/`USERPROFILE`.
Verified on-VM: `Win32_UserProfile` shows `C:\Users\pamtest Loaded=True` during the launch. Any
failure falls back to the SYSTEM env — it is NOT the paint fix.

**On-VM validation (2026-07-04, VM `100.101.150.55`, SYSTEM scheduled task → session 3 RDP `user`):**
- `pamtest` launched **as `pamtest`, elevated (linked-token), in session 3** — Todd visually confirmed
  the window **paints fully** (Notepad: white client area, live caret, painted menu + status bar).
  Black-window bug is **gone**.
- Profile-loaded build re-verified: mmc.exe persists as `pamtest` in session 3, `pamtest` profile
  hive `Loaded=True`.
- **Cosmetic note (NOT the bug, out of scope):** the launched window renders with the Server's
  **classic/basic frame** (flat title bar), unchanged by loading the profile. This is a
  session/OS visual-style artifact of running *as a different account* than the desktop owner
  (Path B's runas model), not the black-window defect. Deferred as cosmetic.

## VM finding (2026-07-15): Case A re-validated on a real Windows 11 workstation

Re-ran the raw-layer harness on a **Windows 11 Pro physical machine** (`dell70601`,
Tailscale `100.71.124.112`) — a fresh environment that had never been exercised, closer to a
real customer endpoint than the Server 2022 VM (DWM, modern UAC). Rig: `pamtest` local-admin
account + a SYSTEM/Highest scheduled task (`PamLaunchTest`) running
`pamlaunchtest.exe -user pamtest -pass ... -session 1 -target mmc.exe` into the **physical
console session (id 1)**. Harness exe was a fresh cross-compile from the current
(uncommitted) worktree code — byte-identical size to the last VM build, i.e. no code drift.

**Results (all green):**
- `OK pid=… session=1`, `LastTaskResult=0`.
- Launched process owner = `dell70601\pamtest` (runs **as `~breeze_elev`**), `SessionId=1`
  (the requesting console session).
- Elevation proof via a `whoami /user /groups` dump from the launched process:
  `BUILTIN\Administrators` **Enabled + Group owner**, integrity =
  **`Mandatory Label\High Mandatory Level` (S-1-16-12288)** → the UAC linked-token swap works
  on Win11, not the filtered token.
- **Window paints / usable** (Todd visually confirmed on the physical screen): MMC renders
  fully — console tree, menus, panes drawn and interactive. Black-window bug does **not**
  reproduce on Win11 either.

**Cosmetic (unchanged from the Server-VM finding, still out of scope):** the elevated window
wears the **Windows Classic/basic frame** rather than the modern Win11 frame, because Path B
launches the target **as a different account** than the desktop owner, so the per-user
uxtheme/DWM visual style isn't applied. On Win11 this is *more visually jarring* than on
Server 2022 — a real end-user would see their elevated app pop up with an old-style frame.
**Product note (not a bug):** worth a later UX decision on whether Path B's runas model is
acceptable for workstations, or whether the elevated window should visually match the user's
theme. Does not affect correctness.

## Record outcomes

Fill in per case as you run them (pass/fail + notes), and iterate `winTokenLauncher.Launch` until A–D pass and E is either passing or explicitly deferred with a logged caveat:

| Case | Result | Notes |
|---|---|---|
| A — approve/launch (console) | Raw layer ✅ (Server VM + **Win11 physical `dell70601`, 2026-07-15**) | Launch primitive proven via harness (elevated/High integrity, as `pamtest`, correct console session, **paints** — usable MMC). Win11 shows the same classic-frame cosmetic. Full auto-flow pending session resolver (#8) + live ETW/user-helper (dev-stack helper broken). |
| B — deny/block | Deferred | Suppression/deny path unchanged from Path A; not re-exercised this cycle. |
| C — lifecycle demote | Deferred | Guaranteed-demote covered by CI (`TestTokenLaunchFailureStillDemotes`); on-VM lifecycle run pending full auto-flow. |
| D — failure demotes | Deferred | See C. |
| E — RDP/multi-session | ✅ **resolver validated 2026-07-15** | Now full: harness `-subject user` ran the production #8 resolver, which mapped `user`→**session 23** via `username_lookup` (WTSEnumerateSessions/WTSQuerySessionInformation), NOT the console; elevated MMC launched as `pamtest` into session 23 and painted in the RDP user's desktop (Todd confirmed). Auto-selection of the requesting user's session from the username now proven on hardware. |
| F — EDR / CVE | Deferred | No EDR stack on this VM. |

**Bug #4 (black/unpaintable window) is closed.** Remaining before a PR: **#8** wire the session
resolver to the requesting user's session (agent `Request`/`pamTarget` + `RunPamFlow` plumbing + a
new field on the remote `actuate_elevation` payload — see the "Session resolution" section), and
**#9** strip the diagnostic scaffolding (`DiagLaunch`/`DiagLaunchAsSessionUser`, `diag_windows.go`,
`cmd/pamlaunchtest`) while wiring the now-**production** `MaybeRunSessionLaunchHelper()` call into
the agent's `main()`. Held for VM per the hold-for-VM rule — no PR yet.
