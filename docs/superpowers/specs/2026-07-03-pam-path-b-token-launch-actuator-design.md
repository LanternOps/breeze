# PAM Path B — Token-Launch Actuator (production integration)

**Date:** 2026-07-03
**Issue:** [#1157 — AP / Path B: prototype CreateProcessAsUser token-mixing successor](https://github.com/LanternOps/breeze/issues/1157)
**Design source:** [Discussion #858 §5 "Path B" + §5 "Windows 11 24H2 Administrator Protection compatibility"](https://github.com/LanternOps/breeze/discussions/858)
**Status:** Approved design — pending spec review, then implementation plan.

## Summary

Add a second PAM actuation strategy — **Path B** — to the Windows agent. Instead of injecting the
dormant-admin credential into a live `consent.exe` prompt on the secure desktop (Path A, the shipped
`pamactuator` SendInput strategy), Path B **suppresses `consent.exe` and launches the target
executable elevated directly** via `LogonUser(~breeze_elev)` → `CreateProcessAsUser`. The elevated
process runs under the `~breeze_elev` account (the `runas` model), on the requesting user's
interactive desktop.

Path B is the planned successor to Path A for the day Microsoft re-rolls Administrator Protection
(AP), which removes the injectable credential surface Path A depends on. This spec covers a
**production** integration (flag-gated, ships dark) — not a throwaway prototype — sequenced so the
load-bearing new primitive is runnable and observable first.

## Motivation

- **Path A is fragile and disabled by default.** The SendInput-into-`consent.exe` actuator is
  gated off in every environment; it depends on an injectable native credential field.
- **Administrator Protection breaks Path A.** Under AP, elevation routes through a system-managed
  `CredentialUIBroker.exe` with no third-party-replaceable credential surface — `SendInput` has
  nothing to target. AP shipped in KB5067036 (Oct 2025), was pulled Dec 1 2025 for compat
  regressions, and will re-roll on an unknown date. Per Discussion #858 §5 and issue #1157, Path B
  is "worth prototyping in parallel so we're not caught flat when Microsoft re-rolls AP."
- **The token-launch primitive is AP-forward for *launching*.** `CreateProcessAsUser` with a
  locally-minted admin token does not touch `consent.exe` / `CredentialUIBroker` and keeps working
  under AP. (The *suppression* half does not — see "AP boundary" below. We are explicit about that
  boundary rather than claiming full AP compatibility.)

## Reframe: what "blocking" means under Path B

Path A is **reactive** — it responds to a `consent.exe` prompt the user's process triggered, by
injecting credentials (approve) or pressing Escape (deny). Path B is **substitutive** — Breeze
intercepts the elevation intent, suppresses `consent.exe`, and mints the elevated process itself.

Consequently, **blocking is the default state, not an action.** A standard user has no admin
credential to satisfy native UAC, so if no approval arrives, nothing elevates — there is no leftover
prompt to dismiss beyond the initial suppression. The only *active* work is the approve path.

## Design decisions (resolved)

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Trigger / detection | **Reuse existing ETW 15028 discovery** | Already shipped and working; AP-forward (events 15031/15032). No new detection stack. |
| D2 | Suppression of native prompt | **Reuse Path A `Dismiss()` (Escape consent.exe), then launch** | Path B builds on Path A's deny primitive rather than replacing the whole stack — lowest-risk integration. |
| D3 | Token identity | **Run as `~breeze_elev`** (`runas` model) | Simplest, most auditable. `LogonUser(~breeze_elev)` → launch target with that admin token. Elevated app sees the admin's profile/HKCU, not the user's — acceptable for installers/system settings, matches how most vendors do end-user elevation. Rejected: user-identity + grafted admin rights ("token mixing" proper) — materially more complex/fragile Win32 token surgery and a larger security-review surface; deferred, not adopted. |
| D4 | Integration point | **New strategy behind existing `pamactuator.Actuator` interface**, selected by config | `pam_flow.go` and `handlers_actuate.go` callers stay largely intact; strategy chosen at construction. |
| D5 | Rollout | **Flag-gated, ships dark**; enable per-device on the test VM | Gate behind existing `PAMEnabled` + a new actuator-strategy config field. |

## Architecture & data flow

```
User launches target.exe → Windows raises UAC → consent.exe paints on secure desktop
   │
   ├─ ETW 15028 (existing discovery) fires → agent extracts {targetPath, cmdline, user}
   │      → POST elevation-request (existing) → PAM decision chain (existing)
   │
   ├─ DENY / no approval:  Dismiss() consent.exe (existing Path A primitive). Nothing launches.
   │
   └─ APPROVE (auto-rule or remote actuate_elevation):
         1. Dismiss() the pending consent.exe                         ← reuse Path A deny primitive
         2. elevaccount.Promote() → Credential{~breeze_elev, pwd}     ← existing
         3. LogonUser(~breeze_elev, pwd, LOGON32_LOGON_INTERACTIVE)   → hToken   ← NEW
         4. SetTokenInformation(hToken, TokenSessionId = user session) ← NEW; land on user desktop, not session 0
         5. grant ~breeze_elev logon SID access to winsta0 + default desktop DACL ← NEW
         6. CreateProcessAsUser(hToken, targetPath, cmdline,
                                lpDesktop="winsta0\\default")          ← NEW
         7. revoke the desktop/winsta DACL grant (defer)              ← NEW
         8. elevaccount.Demote() + re-randomize (defer)              ← existing
```

The genuinely new code is steps 3–7: a `pamactuator` strategy (working name `tokenLaunchActuator`)
implementing the existing `Actuator` interface. Everything else — discovery, decision chain,
`elevaccount` lifecycle, `Dismiss`, the remote `actuate_elevation` command, audit — is reused.

## Components

### New: `tokenLaunchActuator` (Windows) — `agent/internal/pamactuator/`
- Implements the existing `Actuator` interface (`Trigger`, `Dismiss`).
- `Dismiss` is unchanged from the shipped behavior (Escape consent.exe) — Path B reuses it verbatim
  as the suppression + deny primitive.
- `Trigger` performs steps 3–7 above instead of SendInput credential typing.
- `Trigger`'s `Request` must now carry **target executable path + command line** (Path A did not need
  these). Extend `pamactuator.Request` accordingly.
- Result reason codes (test observables), extending the existing set (`ok`, `no_consent_window`,
  `send_input_failed`, `consent_did_not_close`): `logon_failed`, `set_session_failed`,
  `desktop_grant_failed`, `create_process_failed`.
- Non-Windows: the existing `noopActuator` in `actuator_other.go` covers the new strategy with no
  change (returns not-implemented).

### Changed: actuator selection
- Add a config field selecting the actuator strategy (e.g. `pam_actuator_strategy: sendinput |
  token_launch`, default `sendinput`) in `agent/internal/config/config.go` alongside `PAMEnabled`.
- `newActuator` indirection in `handlers_actuate.go` (currently `= pamactuator.New`) and the
  `pam_flow.go` deny path select the strategy from config. Preserve the `swapActuatorForTest` seam.

### Changed: actuate payload carries the target
- The remote `actuate_elevation` command payload (`handlers_actuate.go`) and the local `RunPamFlow`
  actuation must pass `{targetPath, commandLine}` to the actuator. ETW 15028 discovery already
  extracts both (`Event.TargetExecutablePath`, `Event.CommandLine`), so the data exists on the
  local path. For the remote path, the server must echo the stored request's target back in the
  command payload (the agent can also cache it locally by `elevationRequestId`). Spec the simplest
  reliable source during planning; prefer server-echo so the agent holds no cross-request state.
- Credential (`~breeze_elev` password) remains agent-minted and never crosses the wire — unchanged.

### Reused unchanged
- `agent/internal/etwlua/` — discovery (event 15028), `PamRunner`, `RunPamFlow` dispatch.
- `agent/internal/elevaccount/` — `Promote`/`Demote`, `GeneratePassword`, self-heal.
- `agent/internal/sessionbroker/pam_decision.go` — `ComposePamDecision`.
- Server decision chain, `POST /devices/:id/actuate-elevation` (single-use CAS, 403-when-disabled),
  audit, mobile bridge, web console.

## Known Win32 wrinkles (implementation risk — called out, not hidden)

1. **Interactive-desktop access.** Launching as a *different* account onto `winsta0\default`
   requires granting `~breeze_elev`'s logon SID access to the window station + desktop DACL, else
   the process starts with no visible window (the classic `runas`-interactive problem). Grant before
   `CreateProcessAsUser`, revoke in a defer.
2. **Session placement.** Without `SetTokenInformation(hToken, TokenSessionId, <user session>)` the
   process lands in session 0 (invisible). SYSTEM holds `SE_TCB_NAME`, so this is permitted.
3. **Required privileges.** `CreateProcessAsUser` needs `SE_ASSIGNPRIMARYTOKEN` + `SE_INCREASE_QUOTA`;
   the SYSTEM service has both. Verify on the target VM.
4. **CVE-2026-20824 (Jan 2026 Credential-UI hardening).** Microsoft added input-source validation to
   the credential-UI path. The SYSTEM-context injection path is not explicitly named as blocked, but
   Path B's `Dismiss` (suppression) touches consent.exe input — verify empirically on the VM matrix.
5. **EDR scrutiny.** `CreateProcessAsUser` from SYSTEM to a freshly-promoted hidden admin account is
   a behavior AV/EDR may flag. The existing EDR-allowlist work (#1158) covers the broker binary;
   confirm the new launch pattern is within the submitted exclusions.

## AP boundary (explicit)

- **Launch is AP-forward:** steps 3–7 don't touch consent.exe / CredentialUIBroker and keep working
  under AP.
- **Suppression is NOT AP-forward:** step 1 (`Dismiss` via Escape into consent.exe) has no injectable
  prompt under AP. Under AP the suppression story is unsolved and gated on Microsoft's rollout — this
  matches #1157's "external blocker: Microsoft AP rollout timing." This spec does **not** claim full
  AP compatibility; it delivers the AP-forward *launch* primitive and leaves AP suppression as
  explicit future work.

## Phasing

1. **Phase 1 — the primitive, flag-gated dark.** `tokenLaunchActuator.Trigger` (steps 3–7) +
   `pamactuator.Request` target/cmdline fields + desktop/session plumbing. Selectable via config on
   the test VM only. This is the soonest-runnable, observable unit inside the production codebase.
2. **Phase 2 — wire selection + suppression ordering.** Actuator-strategy selection in
   `pam_flow.go` / `handlers_actuate.go`; Dismiss-then-launch sequencing; reuse `pamActuateMu` so
   Path A and Path B never drive input concurrently; server-echo of target in the actuate payload.
3. **Phase 3 — hardening + tests.** Desktop-DACL grant/revoke lifecycle; failure/demote paths
   (any failure in 3–6 must still demote `~breeze_elev`); Go unit tests + on-VM manual matrix.

## Error handling

- Every failure in steps 3–6 must run the `elevaccount.Demote()` + re-randomize defer — never leave
  `~breeze_elev` promoted. Mirror Path A's guaranteed-demote pipeline in `handlers_actuate.go`.
- `LogonUser` / `CreateProcessAsUser` failures return a typed `Result` reason (see codes above) and
  log at WARN with `elevationRequestId`; the elevation is treated as failed (not silently approved).
- Panics on the etwlua loop goroutine stay contained by the existing `recover()` in `RunPamFlow`.
- Desktop-DACL grant must be revoked even on launch failure (defer).

## Testing

- **Go unit tests** for `tokenLaunchActuator` with the syscall layer faked behind the existing
  `pamactuator` test seams (`swapActuatorForTest`): assert LogonUser→SetSession→grant→
  CreateProcessAsUser call ordering, target/cmdline plumbed through, demote-on-failure, reason codes.
- **Config-selection test:** strategy field routes to the right actuator; default stays `sendinput`.
- **On-hardware matrix (Windows test VM, 100.101.150.55):**
  - Standard user triggers UAC → auto-approve rule → target launches elevated as `~breeze_elev` on
    the user's desktop, no native prompt survives.
  - Deny → nothing launches; consent.exe dismissed.
  - Post-run: `~breeze_elev` demoted (not in Administrators) + password re-randomized.
  - Verify session placement (process visible on the user's desktop, not session 0).
  - CVE-2026-20824 / EDR interaction sanity check.

## Out of scope

- User-identity token mixing (D3 alternative) — deferred.
- AP suppression (intercept before CredentialUIBroker) — gated on Microsoft AP rollout.
- macOS Path B (SAP Privileges pattern) — tracked separately in #1156.
- "User never sees any native prompt" via shell hook / custom credential provider — Phase 6+ per
  Discussion #858.
