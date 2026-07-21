# PAM Dormant `~breeze_elev` Admin Account Lifecycle — Implementation Plan

**Issue:** LanternOps/breeze#1150
**Pairs with:** #960 (UAC actuator — consumes the credentials this produces), #1152 (dialog), #1163 (approval source).
**Design sources:** issue #1150; [Discussion #858 §5](https://github.com/LanternOps/breeze/discussions/858) (credential-injection sequence, effort row "`~breeze_elev` dormant account"); [Q4 ruling](https://github.com/LanternOps/breeze/discussions/858#discussioncomment-17033668).
**Status:** Draft, ready for pickup. Author: triage pass 2026-06-09.

---

## Goal

Manage a dormant local Windows admin account (`~breeze_elev`) as the **just-in-time credential source** for approved UAC elevations: create it disabled/hidden on install, and on an approved elevation promote it to Administrators + rotate its password, hand the credential to the actuator (#960) **in-process**, then demote + re-randomize the moment consent.exe exits. Millisecond-window admin, fully audited.

## Design correction (load-bearing — read first)

The actuator (#960) today takes `Username`/`Password` off the **server** command payload (`actuateElevation.ts:198-209`, `handlers_actuate.go:39-44`), and its own header calls this "Track 6 — server-side credential generation." **That cannot be the real design:** a server cannot set a *local* Windows account's password — only the agent, via `NetUserSetInfo` on the box, can. So this work makes the **agent the credential authority**:

- The dormant-account manager generates + rotates the password **locally** and invokes the actuator **in-process** with the just-minted credential. The secret never crosses the wire.
- The server's `actuate_elevation` command degrades to a **"go" signal** — `{elevationRequestId, timeoutMs}` only; the `username`/`password` fields become deprecated/optional. Update `actuateElevation.ts` to stop requiring/sending them, and `handlers_actuate.go` to source creds from the account manager instead of the payload. (Coordinate this small server change in the same PR or a paired one.)

This is the central architectural decision of #1150; everything below follows from it.

## EXISTS vs GREENFIELD

- **GREENFIELD:** local-account management is entirely new — grep of `agent/internal` for `NetUserAdd`/`NetLocalGroupAddMembers`/`NetUserSetInfo`/`netapi32` returns zero. You add the first `netapi32` syscall wrappers. No password generation/storage for this exists.
- **REUSE:** config secret-at-rest (`config.go` `SetSecretAndPersist` → `secrets.yaml` `0600`, `atomicWriteFile:582`); handler registry (`handlers.go:11-17` + `init()`); build-tag split (`actuator_windows.go`/`_other.go`/shared); the agent already runs as SYSTEM so `netapi32` calls run **in-process** (no spawn needed — `sessionbroker` spawn helpers are not required here).

## Conventions to mirror

- **Package shape** = pamactuator's three-file split: `elevaccount.go` (shared interface + types, no build tag), `elevaccount_windows.go` (`//go:build windows`, netapi32), `elevaccount_other.go` (`//go:build !windows`, no-op returning a stable `unsupported_platform` reason).
- **Handler registration:** add `CmdManageElevationAccount = "manage_elevation_account"` in `agent/internal/remote/tools/types.go` (beside `CmdActuateElevation:222`); new `handlers_elevation_account.go` with `func init(){ handlerRegistry[tools.CmdManageElevationAccount] = handle... }` (mirror `handlers_actuate.go:33-35`).
- **Secret persistence:** rotated password (when it must survive a crash mid-window for cleanup) goes through `config.SetSecretAndPersist` → `secrets.yaml` only. **Never** `agent.yaml` (0644, Helper-readable).
- **Tests:** package-level test with no build tag; `runtime.GOOS != "windows"` → `t.Skip`; cross-platform table tests for the state machine + payload parse, Windows-gated tests for netapi32 (mirror `actuator_test.go`).

---

## Task 1 — `elevaccount` package: netapi32 wrappers + account lifecycle

New `agent/internal/elevaccount/`:

- `elevaccount.go` — interface `AccountManager` with: `EnsureProvisioned() error` (idempotent create-if-absent), `Promote(ctx) (Credential, error)` (add to Administrators + rotate password, return cleartext cred), `Demote(ctx) error` (remove from Administrators + re-randomize). `Credential{Username, Password}` — password zeroed by caller after use.
- `elevaccount_windows.go` (`//go:build windows`) — `syscall`/`golang.org/x/sys/windows` wrappers over `netapi32.dll`:
  - `NetUserAdd` (USER_INFO_1, `UF_ACCOUNTDISABLE | UF_DONT_EXPIRE_PASSWD | UF_PASSWD_CANT_CHANGE`, hidden from logon) on `EnsureProvisioned`.
  - `NetLocalGroupAddMembers` / `NetLocalGroupDelMembers` (Administrators by well-known SID `S-1-5-32-544`, resolve name via `LookupAccountSid` for locale-independence) on promote/demote.
  - `NetUserSetInfo` USER_INFO_1003 for password rotation; `NetUserSetInfo` USER_INFO_1008 to set `UF_ACCOUNTDISABLE` off during the window.
  - Password generator: 32+ char cryptographically-random (`crypto/rand`) meeting complexity policy.
- `elevaccount_other.go` (`//go:build !windows`) — no-op stub.

## Task 2 — Provision on install/startup

- Call `EnsureProvisioned()` once on agent startup (Windows only), behind the same feature flag gating the actuator (`PAM_ACTUATOR_ENABLED`-equivalent agent config) so it's dormant until PAM is enabled for the org. Idempotent: existing account → no-op; verify it's disabled + not in Administrators at rest.
- Account name `~breeze_elev` (leading `~` mirrors AutoElevate's `~0000AEAdmin`; keep it visually distinct + sortable-last). Hidden from the logon screen (registry `SpecialAccounts\UserList` = 0).

## Task 3 — Promote/actuate/demote orchestration in the command handler

`handlers_elevation_account.go` (or fold into the actuate handler):

1. Receive the approved `actuate_elevation` "go" signal (`{elevationRequestId, timeoutMs}`).
2. `Promote()` → cleartext cred in memory only.
3. Invoke the **in-process** actuator (`pamactuator.New().Trigger(ctx, Request{ElevationRequestID, Username, Password, TimeoutMs})`) — no wire transit.
4. On the consent.exe-exit ETW signal (event 4101/4102 from `etwlua`, or the actuator's `consent_did_not_close`/success result), `Demote()` + zero the password.
5. **Guaranteed demotion:** a local monotonic-timer `defer` + a watchdog so a crash between promote and demote still demotes on next startup (`EnsureProvisioned` should detect "in Administrators at rest" as an anomaly → force-demote + audit). This is the core safety invariant.
6. Audit every promote/demote with `elevationRequestId` correlation (ship via the agent's existing log/audit path → server `elevation_audit`).

## Task 4 — Crash-safety + cleanup-on-startup

- On startup, if `~breeze_elev` is found in Administrators (a leaked window from a crash), demote + re-randomize immediately and emit a `command_executed`/anomaly audit row. The rotated password persisted via `SetSecretAndPersist` is only needed if a future flow must re-authenticate during cleanup; prefer to **re-randomize blind** (we never need the old password to remove group membership) and avoid persisting the secret at all. Document the choice.

## Task 5 — Server-side "go" signal change

- `apps/api/src/routes/devices/actuateElevation.ts`: make `username`/`password` optional in `actuateElevationSchema` and stop populating them in the command payload (keep `elevationRequestId`, `timeoutMs`). Preserve the single-use CAS guard (`status approved → actuating`, the #960 review blocker). Update the route tests.
- `handlers_actuate.go`: source the credential from `elevaccount.Promote()` rather than `parseActuatePayload`'s `username`/`password`.

## Task 6 — Tests

- Cross-platform: password-generator complexity/length, state-machine transitions (provisioned→promoted→demoted), crash-recovery detection logic (pure), payload parsing of the slimmed "go" signal.
- Windows-gated (`runtime.GOOS=="windows"`, manual/VM): real `EnsureProvisioned`/`Promote`/`Demote` round-trip on a throwaway VM, verify group membership before/after via `net localgroup administrators`, verify account hidden from logon.
- Negative: promote when already promoted (idempotent), demote when not a member (no-op), startup-cleanup of a forced-leaked membership.

---

## Sequencing & estimate

Tasks 1→3 are the spine; 4 is the safety net; 5 is the paired server change; 6 throughout. Effort: **M** (~1 wk + VM verification). This is the piece that makes #960 actually usable in production (today the actuator has no real credential to type). Pairs with #1152 (dialog) for the full end-user flow but is independently testable.

## Security notes

- Account is disabled + non-member at rest; admin only during the millisecond actuation window.
- Password is `crypto/rand`, rotated on every promote AND demote, never logged, zeroed after use, never sent over the wire.
- Force-demote-on-startup closes the crash-leak window.
- Every promote/demote audited with request correlation.

## Self-review checklist

- [ ] `~breeze_elev` disabled + not in Administrators at rest; verified by an at-rest assertion on startup.
- [ ] Password never crosses the wire; actuator invoked in-process.
- [ ] Demotion guaranteed by timer + defer + startup-cleanup (crash-safe).
- [ ] Server payload no longer carries credentials; CAS single-use guard preserved.
- [ ] netapi32 calls are locale-independent (well-known SID, not "Administrators" string).
- [ ] Windows-only behind the PAM feature flag; clean no-op on other platforms.
