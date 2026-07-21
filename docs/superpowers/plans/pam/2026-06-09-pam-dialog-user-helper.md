# PAM Approval Dialog in `breeze-user-helper.exe` — Implementation Plan

**Issue:** LanternOps/breeze#1152
**Pairs with:** #959 (ETW subscriber — the trigger source), #1150 (account manager — runs on approve), #960 (actuator), #1163 (remote-approval alternative).
**Design sources:** issue #1152; [Discussion #858 §5 step 2](https://github.com/LanternOps/breeze/discussions/858) (Breeze dialog on the user desktop while consent.exe idles); [Q2 ruling](https://github.com/LanternOps/breeze/discussions/858#discussioncomment-17033668) (broker stays in-agent).
**Status:** Draft, ready for pickup. Author: triage pass 2026-06-09.

---

## Goal

When the ETW subscriber detects a UAC prompt, render a branded native PAM dialog **on the user's interactive desktop** (via `breeze-user-helper.exe`) showing the executable, signer, and intent, with approve/deny. The SYSTEM broker drives it over the existing IPC channel and blocks on the result, which — combined with policy/remote-approval — decides whether to actuate (#1150 + #960).

## EXISTS vs GREENFIELD

- **EXISTS (cite-and-mirror):** IPC envelope + message-type pattern (`ipc/message.go`), broker→helper spawn + named-pipe channel (`sessionbroker/`), the request/response round-trip primitive `SendCommandAndWait` (`broker.go:980`), active-session detection (`detector_windows.go`), role/scope gating (`broker.go:209-217`), the helper's dispatch switch (`userhelper/client.go:358-396`), and the ETW detection hot path (`etwlua/etwlua.go:217`).
- **GREENFIELD:** (1) the native Win32 dialog window — the helper has **no** windowing infra today (toast is PowerShell-shelled `notify_windows.go:13-38`; tray is a stub); (2) the wire from `etwlua` → broker → helper (the current explicit TODO seam); (3) the approval round-trip semantics.

## Note on ETW event IDs

The issue body cites events **15006/15007**; the shipped subscriber (#959, `etwlua/etwlua_windows.go:32-35`) actually keys on **4100/4101/4102** (`consent_prompted`/`granted`/`denied`). Use the real IDs from the existing code. Flag any discrepancy if 15006/15007 turn out to be needed for the "switch-to-secure-desktop precedes paint" latency win.

## Conventions to mirror

- **IPC types** (`ipc/message.go:9-72` const block; `NotifyRequest`/`NotifyResult:196-209` shape): add `TypePamRequestDialog = "pam_request_dialog"` + `TypePamDialogResult = "pam_dialog_result"`, with `PamRequestDialog{ExePath, Signer, Hash, SubjectUser, CommandLine, Reason, IntentSummary}` and `PamDialogResult{Approved bool, Reason string, DismissedByUser bool}`.
- **Helper dispatch** (`userhelper/client.go:358`): add `case ipc.TypePamRequestDialog: safeGo("pam", func(){ c.handlePamDialog(env) })`.
- **Round-trip** (`broker.go:980 SendCommandAndWait(session, id, cmdType, payload, timeout)`): the broker pushes the dialog to the active user session's helper and blocks for `PamDialogResult` (bounded timeout, e.g. consent.exe lifetime).
- **Scope gating** (`broker.go:209-217`, `scopesForRole:1632-1651`, checks `:2141-2183`): add `ScopePam` const beside `ScopeAssist` (`ipc:121`) and `"pam"` to `userHelperScopes` — a user-facing modal on the interactive desktop belongs to the **user-token helper**, not the SYSTEM/desktop-capture role.

---

## Task 1 — IPC message types + structs

- `ipc/message.go`: add the two `Type*` consts + the `PamRequestDialog`/`PamDialogResult` structs on the `NotifyRequest`/`NotifyResult` pattern. No HMAC/envelope changes (reuse `Envelope:102-109`).

## Task 2 — Scope + role wiring

- Add `ipc.ScopePam` const; append `"pam"` to `userHelperScopes` (`broker.go:213`); add a gate case alongside the `notify`/`tray` checks (`broker.go:2164+`); map it in `scopesForRole`. Confirm the user-token helper is the one spawned for the active console session (`SpawnUserHelperInSession`, `spawner_windows.go:169`).

## Task 3 — Native dialog window (GREENFIELD)

`userhelper/pam_dialog_windows.go` (`//go:build windows`):

- The helper is GUI-subsystem (`spawner_windows.go:105-108`) so it can host a window, but there's no scaffolding. Two options:
  - **MVP:** `MessageBoxW` with `MB_YESNO | MB_TOPMOST | MB_SYSTEMMODAL | MB_SETFOREGROUND`, title/body built from the `PamRequestDialog` fields. Minimal, ships fast, returns `IDYES`/`IDNO` → `PamDialogResult.Approved`. No reason-entry field.
  - **Full:** `RegisterClassExW` + `CreateWindowEx` + message loop with branded layout (exe name, signer cert summary, requester-reason text field, AI intent summary placeholder for Phase 2), approve/deny buttons. Reuse SendInput primitives only from `pamactuator/wininput.go` if needed.
- **Recommendation:** ship the `MessageBoxW` MVP first (unblocks the end-to-end flow), file a follow-up for the branded `CreateWindowEx` window. Note the tradeoff in the PR.
- `pam_dialog_other.go` (`//go:build !windows`) stub returns `{Approved:false, DismissedByUser:true}`.
- `handlePamDialog(env)` in `client.go`: decode `PamRequestDialog`, render, reply with `PamDialogResult` via the existing envelope-reply path.

## Task 4 — Wire ETW → broker → helper (the TODO seam)

In `etwlua/etwlua.go:217 handleEvent`, after the existing dedupe + `SendElevationRequest` POST:

- Resolve the active user session (`detector_windows.go WTSGetActiveConsoleSessionId` / broker `FindCapableSession("pam", session)`).
- Call broker `SendCommandAndWait(session, id, TypePamRequestDialog, payload, timeout)` and read `PamDialogResult`.
- **Decision composition:** the dialog result is one input. Combine with policy (pamBridge/`pam_rules` verdict, if already evaluated agent-side or returned by the server) and the remote-approval path (#1163):
  - end-user-allowed policy + dialog approve → proceed to actuate (#1150 promote → #960 type → demote).
  - require-approval policy → dialog shows "awaiting tech approval"; the actual decision arrives via the server command path (#1163), not the local dialog.
  - deny / dismiss → send Escape to consent.exe (the actuator's denial path) + audit.
- This is the one new cross-package edge (`etwlua` → `sessionbroker`); keep it behind an interface so `etwlua` stays unit-testable without the broker.

## Task 5 — Latency + dedupe

- The dialog must appear within ~100ms of detection (consent.exe is idle awaiting input). Reuse the subscriber's existing `RateLimiter` dedupe so re-fired ETW events don't stack dialogs for one prompt.
- Bound the `SendCommandAndWait` timeout to consent.exe's lifetime; on timeout, treat as deny + dismiss.

## Task 6 — Tests

- Cross-platform: IPC struct round-trip (marshal/unmarshal `PamRequestDialog`/`PamDialogResult`), the decision-composition logic (policy × dialog-result × remote-approval → action) as a pure table-driven test, scope-gating allows `pam` for user role + rejects it for others.
- Windows-gated (VM/manual): real `MessageBoxW` render in an interactive session, broker→helper round-trip returns the click result, ETW-trigger → dialog appears.
- Mock the broker edge in `etwlua` tests via the interface from Task 4.

---

## Sequencing & estimate

Tasks 1→2→3→4 in order (each depends on the prior); 5–6 throughout. Effort: **M** (~1 wk incl. VM verification; less if MVP `MessageBoxW` only). Suggested build order from recon: IPC types → scope → `handlePamDialog` + dialog → the `etwlua`→broker wire (the seam). Pairs with #1150 to deliver the full local end-user elevation: detect → dialog → approve → promote → actuate → demote.

## Risks / watch-items

- **Native windowing is greenfield** — `MessageBoxW` MVP de-risks it; don't block the flow on the branded window.
- **Secure-desktop vs user-desktop** — the Breeze dialog renders on the **user's** desktop (correct: that's where the user is looking); consent.exe sits on the secure desktop. Do not try to render the Breeze dialog on WINLOGON.
- **CVE-2026-20824 / N-able deadlock** (§858 §5) — vet the dialog→actuate timing against the documented consent.exe hardening + N-able interaction before broad rollout.
- **Two approval routes** — keep the local dialog (#1152) and remote mobile/web approval (#1163/#1159) cleanly separated; policy decides which applies.

## Self-review checklist

- [ ] Dialog renders on the user's interactive desktop via the user-token helper (`pam` scope), not SYSTEM/secure desktop.
- [ ] Broker blocks on `PamDialogResult` with a bounded timeout; timeout = deny+dismiss.
- [ ] Real ETW event IDs (4100/4101/4102) used, not the issue body's 15006/15007.
- [ ] `etwlua`→broker edge behind an interface; `etwlua` unit tests don't need a live broker.
- [ ] Dedupe prevents stacked dialogs per prompt.
- [ ] Decision composition (policy × dialog × remote-approval) covered by a pure table test.
