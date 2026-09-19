# Caller Verification W02: Workstation Agent and Helper — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a caller-verification card to the explicitly selected user's console session, report the answering OS principal, and reliably apply its decision through either agent transport, including late rejection and crash recovery.

**Architecture:** W01 owns the verification transaction, policy, state machine, binding rules and delivery outbox. W02 adds a pre-created `device_commands` row to that transaction and dispatches its existing id after commit. The Go session broker resolves an OS login before selecting an authenticated Tauri `assist` helper; IPC uses correlated, typed responses. A Rust bridge owns each prompt and its deadline; React renders it. Both API transports call the same handler. A short BullMQ reconciliation tick repairs missed decisions. Fresh heartbeat telemetry supplies per-device readiness without another table or migration.

**Tech Stack:** Go, authenticated local IPC, Tauri/Rust/Tokio, React/TypeScript, Hono, Drizzle/PostgreSQL, Redis/BullMQ, Vitest, Go race tests and Rust tests.

**Spec:** `docs/superpowers/specs/security-auth/2026-09-18-caller-verification-design.md` (v5). Covers W02; D2–D4, D9, D11's independent observed-login path, D13's device-move revocation, D16–D17; “Agent and helper change”, workstation delivery/result/reconciliation in “Service layer”, device suggestions in “API”, agent/helper tests, and the review-note fixes for native-helper preference, transport duplication and late `not_me`. The naming authority is `docs/superpowers/plans/security-auth/2026-09-19-caller-verification.md`.

## Global Constraints

- Implement only W02. W01 must land first. Its schema, service directory and route module do **not exist in this checkout**; paths identified as W01 additions below have no honest current line number. Resolve their named anchors after rebasing onto W01. Do not build a second state machine or invent replacement public signatures.
- W02 adds no tables or migrations. Reserved slots remain `2026-10-15-180000-caller-verification-tables.sql`, `2026-10-15-180100-caller-verification-policies.sql`, `2026-10-15-180200-caller-verification-destinations-backfill.sql` (W01), and `2026-10-15-180300-action-intents-caller-target.sql` (W05).
- RLS must be enabled + forced + policies in the creating migration. Composite FKs carrying `org_id` are **DEFERRABLE INITIALLY IMMEDIATE**. Migrations are idempotent, contain no inner BEGIN/COMMIT, and DML migrations start with `SELECT set_config('breeze.scope','system',true);`; report DML row counts. Never edit shipped migrations.
- Before every implementation commit run `ls apps/api/migrations | sort | tail -1`; also run `find apps/api/migrations -maxdepth 1 -name '*.sql' -print | sort | tail -1` because the literal command currently returns the directory `preflight`. Re-check main's migration ceiling and rename any unshipped migration upward with all path references if necessary. No migration renaming is expected in W02.
- Never name a column `device_id` or `ticket_id` on the new caller-verification tables. Use `workstation_device_ref`, `ticket_ref`, `consumed_intent_ref`. The existing system-scoped `device_commands.device_id` is unchanged.
- Reuse `callerVerifications`, `callerVerificationSubjectBindings`, `callerVerificationDestinations`, `callerVerificationPolicies` and `callerVerificationMethodEnum`, `callerVerificationStatusEnum`, `callerVerificationActionScopeEnum`, `callerVerificationBindingSourceEnum`, `callerVerificationDestinationKindEnum`, `callerVerificationDestinationSourceEnum` exactly as listed in the index. Do not add capability columns to those tables or `devices`.
- `CALLER_VERIFICATION_ENABLED` remains false by default; W01 config access and 404 behavior remain authoritative. W02 does not enable M365 enforcement or user entry points. Existing issued results and rejection recovery must still be processed when readiness is disabled.
- Unbound workstation = tier **1**, bound = tier **3**. The spec contains stale “tier 2” prose in workstation paragraphs; D4 and the index supersede it. A username/device hint, UPN string alone, helper version, or successful delivery is not a binding.
- Never use `SessionForUser`, `PreferredSessionWithScope`, native fallback, or `consentUISessionForTarget` directly for this command. The last helper explicitly falls back to `ScopeConsentUIFallback`. Resolve OS identity first, require console, then select `HelperRoleAssist` + `ScopeConsentUI` + `Capabilities.CallerVerify` in that session.
- Broker capability reads use `GetCapabilities()`; helper-supplied username is not identity evidence. Windows SID and session id are kernel verified; Unix UID is kernel verified. Use the OS detector's username for reporting and SID lookup for Windows UPN. Timeout, malformed output, disconnected helper and closing a window never approve.
- Create command + verification + W01 outbox record in one transaction. `dispatchCommandToAgent` transmits only (`apps/api/src/services/agentCommandRelay.ts:204`); it creates no row. Never hold a request transaction across IPC, Redis relay wait or human interaction. Background DB calls use labeled `runOutsideDbContext(() => withSystemDbAccessContext(...))`.
- Web HTTP mutations use `runAction`; W02's helper response uses Tauri IPC, with visible retry/error feedback, not an HTTP mutation. All new helper copy has real translations in all eight shipped locales: `en`, `de-DE`, `es-419`, `fr-CA`, `fr-FR`, `it-IT`, `pt-BR`, `tr-TR`.
- Branch `feature/<parent#>-caller-verification/wave-<sub#>`; PR body `Closes #<sub#>`. Obtain actual issue numbers from feature tracking when implementing, never invent them. This planning session creates only this document; its future commit/PR commands are instructions, not actions performed now.
- Run targeted API tests with `cd apps/api && npx vitest run <path>`, helper tests with `cd apps/helper && npx vitest run <path>`, web tests with `cd apps/web && npx vitest run <path>`, and agent tests with `cd agent && go test -race ./internal/<pkg>/...`. Integration suites require `pnpm test-stack up` / `pnpm test-stack down`; unit green does not prove RLS, org cascade, export or merge contracts.

---

## File structure

| Path | Responsibility | Tasks |
|---|---|---|
| `agent/internal/ipc/message.go` | Caller request/response types and `CallerVerify` capability | 1 |
| `agent/internal/sessionbroker/session.go` | Expected response type binding | 1 |
| `agent/internal/sessionbroker/caller_verify.go`, `agent/internal/sessionbroker/caller_verify_test.go`, `agent/internal/sessionbroker/caller_verify_windows.go`, `agent/internal/sessionbroker/caller_verify_unix.go` | OS-login-to-console-assist selection using existing detector fakes | 2 |
| `agent/internal/sessionbroker/detector_windows.go` | Domain-qualified OS username | 2 |
| `agent/internal/heartbeat/caller_verify.go`, `agent/internal/heartbeat/caller_verify_test.go` | Command handler and result mapping | 3 |
| `agent/internal/heartbeat/caller_principal_windows.go`, `agent/internal/heartbeat/caller_principal_unix.go` | OS principal and best-effort UPN | 3 |
| `agent/internal/heartbeat/heartbeat.go` | Live helper readiness telemetry | 4, 16 |
| `apps/helper/src-tauri/src/ipc/caller_verify.rs` | Pending requests, response bridge, deadlines, windows, Rust tests | 5 |
| `apps/helper/src-tauri/src/ipc/client.rs`, `apps/helper/src-tauri/src/ipc/mod.rs`, `apps/helper/src-tauri/src/lib.rs` | Capability frame, IPC loop, managed state and Tauri commands | 5 |
| `apps/helper/src/windows/CallerVerifyWindow.tsx`, `apps/helper/src/windows/CallerVerifyWindow.test.tsx`, `apps/helper/src/windows/callerVerifyMessages.ts` | Card, behavior tests, eight locales | 6 |
| `apps/helper/src/main.tsx` | Hash-routed caller window hydration | 6 |
| `apps/helper/src-tauri/capabilities/default.json`, `apps/helper/src-tauri/tauri.conf.json` | Window permissions and HTTPS logo images | 5, 6 |
| `apps/api/src/services/callerVerification/workstationCapabilities.ts`, `apps/api/src/services/callerVerification/workstationCapabilities.test.ts` | Fresh, org/device/user-keyed readiness cache | 4 |
| `apps/api/src/routes/agents/schemas.ts`, `apps/api/src/routes/agents/heartbeat.ts` | Parse and replace capability telemetry | 4, 16 |
| `apps/api/src/routes/helper/index.ts` | Authenticated partner branding on existing config response | 7 |
| `apps/api/src/services/callerVerification/workstationProtocol.ts`, `apps/api/src/services/callerVerification/workstationProtocol.test.ts` | Frozen command/result codec | 8 |
| `apps/api/src/services/callerVerification/deliverers/workstation.ts`, `apps/api/src/services/callerVerification/deliverers/workstation.test.ts` | Same-transaction preparation and after-commit dispatch | 9 |
| `apps/api/src/services/callerVerification/service.ts` | W01 workstation branch, method availability, outbox dispatch hook | 9, 10, 13, 17 |
| `apps/api/src/services/commandResultHandlers.ts`, `apps/api/src/services/commandResultHandlers.callerVerify.test.ts` | Single decision handler for both transports | 10 |
| `apps/api/src/services/callerVerification/workstationResult.ts`, `apps/api/src/services/callerVerification/workstationResult.test.ts` | Parsing, ownership, principal conversion, durable rejection receipt | 10, 11 |
| `apps/api/src/routes/agents/commands.ts`, `apps/api/src/routes/agentWs.ts` | HTTP registry and authenticated late-rejection ingress | 11 |
| `apps/api/src/jobs/callerVerificationReconciliation.ts`, `apps/api/src/jobs/callerVerificationReconciliation.test.ts` | Expiry, terminal-result repair, late-rejection repair | 12 |
| `apps/api/src/services/workerRegistry.ts`, `apps/api/src/jobs/workerReadinessManifest.ts` | Worker lifecycle and readiness registration | 12 |
| `apps/api/src/services/callerVerification/deviceSuggestions.ts`, `apps/api/src/services/callerVerification/deviceSuggestions.test.ts` | Org/site-scoped hints and per-device readiness | 13 |
| `apps/api/src/routes/callerVerification.ts`, `apps/api/src/routes/callerVerificationWorkstation.ts`, `apps/api/src/routes/callerVerificationWorkstation.test.ts` | W01 route integration and authenticated suggestions handler/tests | 14 |
| `apps/api/src/routes/orgContacts.ts` | Export the existing site-reach helper | 14 |
| `apps/api/src/services/partnerTrust.ts`, `apps/api/src/services/commandTypes.ts`, `apps/api/src/services/commandOfflinePolicy.ts` | Known gated command inventory and live-only offline policy | 8 |
| `apps/docs/src/content/docs/agents/commands.mdx` | Wire contract and rollout limitations | 15 |
| `apps/api/src/services/callerVerification/workstation.integration.test.ts` | Live-DB transaction, ownership, duplicate and recovery tests | 15 |
| `apps/api/vitest.integration.config.ts`, `apps/api/vitest.config.ts` | Discover live suite and exclude it from unit runs | 15–17 |
| `apps/api/src/services/callerVerification/ports.ts` | W01 preparation/delivery/availability adapters | 9 |
| `apps/api/src/services/callerVerification/helperBranding.ts`, `apps/api/src/services/callerVerification/helperBranding.test.ts`, `apps/helper/src/windows/callerVerifyBranding.ts` | Authenticated branding and URL filtering | 7 |
| `apps/api/src/services/callerVerification/workstationReceipt.test.ts`, `apps/api/src/services/callerVerification/workstation.contract.test.ts` | Durable rejection receipt and registration contracts | 11, 18 |
| `agent/internal/collectors/sessions.go`, `agent/internal/collectors/sessions_test.go`, `agent/internal/collectors/session_principal_windows.go`, `agent/internal/collectors/session_principal_unix.go` | W01 session principal wire contract; OS identity collection and retry tests | 16 |
| `apps/api/src/routes/agents/sessions.ts`, `apps/api/src/routes/agents/sessions.test.ts`, `apps/api/src/services/callerVerification/loginObservation.ts`, `apps/api/src/services/callerVerification/subjects.ts` | W01 consumer and binding uniqueness; authenticated ingestion and device locking | 16 |
| `apps/api/src/routes/agents/sessions.callerVerification.integration.test.ts` | Independent login, snapshot, retry, unmatched/ambiguous/cross-org evidence | 16 |
| `apps/api/src/services/callerVerification/deviceMove.ts` (W01-owned), `apps/api/src/routes/devices/moveOrg.ts`, `apps/api/src/routes/devices/moveOrg.test.ts`, `apps/api/src/routes/devices/moveOrg.callerVerification.integration.test.ts` | Reuse W01 move hook and lock order; serialize starts/results and prove old grants unusable | 17 |
| `apps/web/src/lib/api/callerVerification.workstation.test.ts` | Real W02 route response through W04 client, after W04 Task 1 exists | 14, 18 |

### Task 1: Freeze the Go IPC request and response contract

**Files:** Modify `agent/internal/ipc/message.go:89,225,572`; `agent/internal/sessionbroker/session.go:473`. Create `agent/internal/ipc/caller_verify_test.go`; modify `agent/internal/sessionbroker/session_test.go:210` (typed-response tests).

**Interfaces:** Consumes `ipc.Envelope`, `Session.SendCommand(id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error)`. Produces the following exact command/IPC types; IPC adds no approval boolean.

- [ ] **Step 1: Write failing wire tests.**

```go
package ipc

import (
    "encoding/json"
    "testing"
)

func TestCallerVerifyWire(t *testing.T) {
    var caps Capabilities
    if err := json.Unmarshal([]byte(`{"callerVerify":true}`), &caps); err != nil { t.Fatal(err) }
    if !caps.CallerVerify { t.Fatal("capability lost") }
    req := CallerVerifyRequest{VerificationID: "v", Username: "ACME\\alex",
        TechnicianName: "Sam", OrgName: "Acme", ActionLabel: "reset the password",
        TargetLabel: "alex@example.com", ReverseCode: "7319",
        Choices: []string{"42", "17", "86"}, TimeoutMs: 120000}
    b, err := json.Marshal(req); if err != nil { t.Fatal(err) }
    var decoded map[string]any
    if err := json.Unmarshal(b, &decoded); err != nil { t.Fatal(err) }
    if len(decoded) != 9 || decoded["timeoutMs"] != float64(120000) { t.Fatalf("%s", b) }
    if TypeCallerVerifyRequest != "caller_verify_request" || TypeCallerVerifyResponse != "caller_verify_response" { t.Fatal("wire names changed") }
}
```

Add to package `sessionbroker`:

```go
func TestCallerVerifyExpectedResponse(t *testing.T) {
    if got := expectedResponseType(ipc.TypeCallerVerifyRequest); got != ipc.TypeCallerVerifyResponse {
        t.Fatalf("response type = %q", got)
    }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/ipc/... ./internal/sessionbroker/...`. Expected: undefined caller types/field, then missing expected-response mapping.
- [ ] **Step 3: Add the types and response mapping.** Keep `Choices` a slice and validate its length; Go fixed arrays silently truncate extra JSON elements.

```go
const TypeCallerVerifyRequest = "caller_verify_request"
const TypeCallerVerifyResponse = "caller_verify_response"

type CallerVerifyRequest struct {
    VerificationID string   `json:"verificationId"`
    Username       string   `json:"username"`
    TechnicianName string   `json:"technicianName"`
    OrgName        string   `json:"orgName"`
    ActionLabel    string   `json:"actionLabel"`
    TargetLabel    string   `json:"targetLabel"`
    ReverseCode    string   `json:"reverseCode"`
    Choices        []string `json:"choices"`
    TimeoutMs      int      `json:"timeoutMs"`
}
type CallerVerifyResponse struct {
    Choice        string `json:"choice"`
    HelperVersion string `json:"helperVersion,omitempty"`
}
```

Add this field to `Capabilities`:

```go
CallerVerify bool `json:"callerVerify"`
```

Add this branch to `expectedResponseType`:

```go
case ipc.TypeCallerVerifyRequest:
    return ipc.TypeCallerVerifyResponse
```

`Capabilities` is already decoded and installed under `session.mu` in `broker.go:3003`; no second mutable capability cache is needed in Go. Preserve the existing fields.

- [ ] **Step 4: Run** `cd agent && go test -race ./internal/ipc/... ./internal/sessionbroker/...`. Expected: pass, including old-helper JSON where missing `callerVerify` remains false.
- [ ] **Step 5: Commit** after the migration-ceiling check in Global Constraints.

```bash
git add agent/internal/ipc/message.go agent/internal/ipc/caller_verify_test.go agent/internal/sessionbroker/session.go agent/internal/sessionbroker/session_test.go
git commit -m "feat(agent): define caller verification IPC contract"
```

### Task 2: Resolve the explicit OS login and select only its console assist helper

**Files:** Create `agent/internal/sessionbroker/caller_verify.go`, `agent/internal/sessionbroker/caller_verify_test.go`, `agent/internal/sessionbroker/caller_verify_windows.go`, `agent/internal/sessionbroker/caller_verify_unix.go`. Modify `agent/internal/sessionbroker/detector_windows.go:139` (username assembly). Reference `agent/internal/sessionbroker/broker.go:930,987,1001,1088,1118,2397`; `agent/internal/sessionbroker/session.go:329`; `agent/internal/sessionbroker/detector.go:30`; `agent/internal/sessionbroker/broker_admission_test.go:15`.

**Interfaces:** Consumes `SessionDetector.ListSessions() ([]DetectedSession, error)`, `Session.GetCapabilities() *ipc.Capabilities`, `Session.HasScope(string) bool`, `Broker.ConsoleSessionID() string`. Produces `func (b *Broker) CallerVerifySession(username string, detector SessionDetector) (*Session, DetectedSession, string)` and `func (b *Broker) CallerVerifyUsers(detector SessionDetector) []string`.

- [ ] **Step 1: Write table-driven tests using existing `admissionTestDetector`.**

```go
package sessionbroker

import (
    "testing"
    "github.com/breeze-rmm/agent/internal/ipc"
)
func TestCallerVerifySession(t *testing.T) {
    original := callerOwnsLogin
    callerOwnsLogin = func(sid, user string) bool { return sid == "S-1-5-21-1" && user == "ACME\\alex" }
    t.Cleanup(func() { callerOwnsLogin = original })
    for _, tc := range []struct{name, user, session string; native, assist, capable bool; want string}{
        {"explicit", "ACME\\alex", "7", false, true, true, ""},
        {"missing", "ACME\\nobody", "7", true, true, true, "no_session_for_user"},
        {"non-console", "ACME\\alex", "8", true, true, true, "session_not_console"},
        {"old", "ACME\\alex", "7", false, true, false, "helper_outdated"},
        {"both", "ACME\\alex", "7", true, true, true, ""},
        {"native-only", "ACME\\alex", "7", true, false, true, "helper_outdated"},
        {"wrong SID", "ACME\\alex", "7", false, true, true, "helper_outdated"},
        {"empty", "", "7", true, true, true, "no_session_for_user"},
    } {
        t.Run(tc.name, func(t *testing.T) {
            b := New("test", nil); b.SetGOOSForTest("windows")
            b.SetConsoleSessionIDFunc(func() string { return "7" })
            det := admissionTestDetector{sessions: []DetectedSession{{Username: "ACME\\alex", Session: tc.session, Type: "console", State: "active"}}}
            add := func(role ipc.HelperRole, scope string) {
                s := NewSession(nil, 0, "S-1-5-21-1", "ACME\\alex", "", string(role), []string{scope})
                s.WinSessionID = tc.session; s.HelperRole = role
                s.Capabilities = &ipc.Capabilities{CallerVerify: tc.capable}
                if tc.name == "wrong SID" { s.IdentityKey = "S-1-5-21-2" }
                b.sessions[s.SessionID] = s
            }
            if tc.native { add(ipc.HelperRoleUser, ipc.ScopeConsentUIFallback) }
            if tc.assist { add(ipc.HelperRoleAssist, ipc.ScopeConsentUI) }
            s, login, reason := b.CallerVerifySession(tc.user, det)
            if reason != tc.want { t.Fatalf("reason=%q want=%q", reason, tc.want) }
            if reason == "" && (s == nil || s.HelperRole != ipc.HelperRoleAssist || login.Username != "ACME\\alex") { t.Fatal("wrong identity/helper") }
        })
    }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/sessionbroker/...`. Expected: `CallerVerifySession` undefined.
- [ ] **Step 3: Implement selection, with `strings` and `ipc` imports.** `detector` is injected instead of adding a mutable global or assuming `Broker` owns one.

```go
func (b *Broker) CallerVerifySession(username string, detector SessionDetector) (*Session, DetectedSession, string) {
    none := DetectedSession{}
    if strings.TrimSpace(username) == "" || detector == nil { return nil, none, "no_session_for_user" }
    logins, err := detector.ListSessions()
    if err != nil { return nil, none, "no_session_for_user" }
    b.mu.RLock(); goos := b.effectiveGOOS(); b.mu.RUnlock()
    consoleID := b.ConsoleSessionID()
    var target *DetectedSession
    found := false
    for i := range logins {
        login := &logins[i]
        same := login.Username == username
        if goos == "windows" { same = strings.EqualFold(login.Username, username) }
        if !same { continue }; found = true
        console := !login.IsRemote && login.State == "active"
        switch goos {
        case "windows": console = console && login.Session != "" && login.Session == consoleID
        case "darwin": console = console && login.Type == "console"
        default: console = console && login.Seat == "seat0" && (login.Display == "x11" || login.Display == "wayland" || login.Display == "mir")
        }
        if console { if target != nil { return nil, none, "session_not_console" }; target = login }
    }
    if !found { return nil, none, "no_session_for_user" }
    if target == nil { return nil, none, "session_not_console" }
    b.mu.RLock(); defer b.mu.RUnlock()
    var best *Session
    for _, s := range b.sessions {
        sameLogin := s.UID == target.UID
        if goos == "windows" { sameLogin = s.WinSessionID == target.Session && callerOwnsLogin(s.IdentityKey, target.Username) }
        if !sameLogin || s.HelperRole != ipc.HelperRoleAssist || !s.HasScope(ipc.ScopeConsentUI) || s.IsClosed() { continue }
        caps := s.GetCapabilities()
        if caps != nil && caps.CallerVerify && (best == nil || s.SessionID < best.SessionID) { best = s }
    }
    if best == nil { return nil, *target, "helper_outdated" }
    return best, *target, ""
}
func (b *Broker) CallerVerifyUsers(detector SessionDetector) []string {
    users := []string{}
    logins, err := detector.ListSessions(); if err != nil { return users }
    seen := map[string]bool{}
    for _, login := range logins {
        if _, _, reason := b.CallerVerifySession(login.Username, detector); reason == "" && !seen[login.Username] {
            seen[login.Username] = true; users = append(users, login.Username)
        }
    }
    return users
}
```

In `detector_windows.go`, immediately after the existing successful `querySessionString(info.SessionID, wtsUserName)` read, qualify it using the existing `wtsDomainName` constant and `querySessionString` helper:

```go
if domain := d.querySessionString(info.SessionID, wtsDomainName); domain != "" {
    username = domain + `\` + username
}
```

Add an OS-backed ownership check **before** sending (same Windows session can host a process under different credentials). New `caller_verify_windows.go` uses `//go:build windows`, package `sessionbroker`, imports `strings` and `golang.org/x/sys/windows`:

```go
var callerOwnsLogin = func(identityKey, username string) bool {
    sid, err := windows.StringToSid(identityKey); if err != nil { return false }
    account, domain, _, err := sid.LookupAccount(""); if err != nil { return false }
    if domain != "" { account = domain + `\` + account }
    return strings.EqualFold(account, username)
}
```

`caller_verify_unix.go` uses `//go:build !windows`, package `sessionbroker`, and `var callerOwnsLogin = func(identityKey, username string) bool { return false }`; Unix production selection uses verified UID instead. The cross-platform Windows selector test above temporarily installs `callerOwnsLogin = func(sid, user string) bool { return sid == "S-1-5-21-1" && user == "ACME\\alex" }`, restores it with `t.Cleanup`, and never uses `t.Parallel`. The override is test-only; production never resolves ownership by helper-supplied username.

Do not compare Unix detector session ids (`console` / loginctl id) with `WinSessionID` (UID on Unix). `SessionInConsoleSession` always returns true on Unix and is insufficient here. Add the following cases to `caller_verify_test.go`; add `sync` to its imports. These tests use the existing fake detector and race-safe setter rather than real OS/network calls.

```go
func TestCallerVerifyUnixConsoleAndCapabilityRace(t *testing.T) {
    for _, goos := range []string{"darwin", "linux"} {
        b := New("unix", nil); b.SetGOOSForTest(goos)
        s := NewSession(nil, 501, "501", "helper-claimed-name", "", "assist", []string{ipc.ScopeConsentUI})
        s.HelperRole = ipc.HelperRoleAssist; s.SetCapabilities(&ipc.Capabilities{CallerVerify: true})
        b.sessions[s.SessionID] = s
        login := DetectedSession{UID: 501, Username: "alex", Session: "console", Type: "console", State: "active", Seat: "seat0", Display: "wayland"}
        det := admissionTestDetector{sessions: []DetectedSession{login}}
        got, _, reason := b.CallerVerifySession("alex", det)
        if got != s || reason != "" { t.Fatalf("%s: %s", goos, reason) }
        det.sessions[0].IsRemote = true
        if _, _, reason = b.CallerVerifySession("alex", det); reason != "session_not_console" { t.Fatal(reason) }
        det.sessions[0].IsRemote = false; s.UID = 502
        if _, _, reason = b.CallerVerifySession("alex", det); reason != "helper_outdated" { t.Fatal(reason) }
        s.UID = 501
        var wg sync.WaitGroup; wg.Add(2)
        go func() { defer wg.Done(); for i:=0;i<100;i++ { s.SetCapabilities(&ipc.Capabilities{CallerVerify:i%2==0}) } }()
        go func() { defer wg.Done(); for i:=0;i<100;i++ { _,_,_=b.CallerVerifySession("alex", det) } }()
        wg.Wait()
    }
}
```

- [ ] **Step 4: Run** `cd agent && go test -race ./internal/sessionbroker/...`. Expected: all table cases pass; run the same package on Windows to exercise WTS qualification.
- [ ] **Step 5: Commit.**

```bash
git add agent/internal/sessionbroker/caller_verify.go agent/internal/sessionbroker/caller_verify_test.go agent/internal/sessionbroker/detector_windows.go agent/internal/sessionbroker/caller_verify_windows.go agent/internal/sessionbroker/caller_verify_unix.go
git commit -m "feat(agent): target caller verification to the explicit console login"
```

### Task 3: Execute the command and report the OS principal

**Files:** Create `agent/internal/heartbeat/caller_verify.go`, `agent/internal/heartbeat/caller_verify_test.go`, `agent/internal/heartbeat/caller_principal_windows.go`, `agent/internal/heartbeat/caller_principal_unix.go`. Reference `agent/internal/heartbeat/handlers_user.go:16` registration, `agent/internal/heartbeat/consent_gate.go:120` correlated wait, `agent/internal/heartbeat/heartbeat.go:6084` HTTP result posting. No bespoke result transport.

**Interfaces:** Consumes `handlerRegistry`, `Command`, `tools.CommandResult`, `Broker.SendCommandAndWait`. Produces `handleCallerVerify(h *Heartbeat, cmd Command) tools.CommandResult`; `runCallerVerify(req ipc.CallerVerifyRequest, resolve func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string), send func(*sessionbroker.Session, string, string, any, time.Duration) (*ipc.Envelope, error), principal func(*sessionbroker.Session, string) *callerPrincipal) callerVerifyResult`.

- [ ] **Step 1: Write a real timeout/principal/choice test against injected dependencies.**

```go
package heartbeat

import (
    "encoding/json"
    "errors"
    "testing"
    "time"
    "github.com/breeze-rmm/agent/internal/ipc"
    "github.com/breeze-rmm/agent/internal/sessionbroker"
)
func TestCallerVerifyDecision(t *testing.T) {
    for _, choice := range []string{"42", "not_me", "timeout", "allow"} {
        req := ipc.CallerVerifyRequest{VerificationID: "v", Username: "alex", Choices: []string{"42", "17", "86"}, TimeoutMs: 30000}
        s := sessionbroker.NewSession(nil, 501, "501", "untrusted-helper-name", "", "s", nil)
        resolve := func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) { return s, sessionbroker.DetectedSession{Username: "alex", UID: 501}, "" }
        send := func(_ *sessionbroker.Session, id, typ string, _ any, timeout time.Duration) (*ipc.Envelope, error) {
            if id != "caller-verify-v" || typ != ipc.TypeCallerVerifyRequest || timeout != 32*time.Second { t.Fatal("bad correlation/deadline") }
            if choice == "timeout" { return nil, errors.New("timeout") }
            raw, _ := json.Marshal(ipc.CallerVerifyResponse{Choice: choice})
            return &ipc.Envelope{Payload: raw}, nil
        }
        got := runCallerVerify(req, resolve, send, func(_ *sessionbroker.Session, username string) *callerPrincipal { uid := uint32(501); return &callerPrincipal{UID: &uid, Username: username} })
        if choice == "allow" || choice == "timeout" { if got.Choice != "timeout" { t.Fatal("failed open") }; continue }
        if got.Choice != choice || got.Principal == nil || got.Principal.Username != "alex" { t.Fatalf("%+v", got) }
    }
}
```

- [ ] **Step 2: Run** `cd agent && go test -race ./internal/heartbeat/...`. Expected: undefined handler/result/core.
- [ ] **Step 3: Implement the core and registration.** Import `encoding/json`, `fmt`, `regexp`, `time`, `ipc`, `tools`, `sessionbroker`.

```go
type callerPrincipal struct {
    SID string `json:"sid,omitempty"`
    UID *uint32 `json:"uid,omitempty"`
    Username string `json:"username"`
    UPN string `json:"upn,omitempty"`
}
type callerVerifyResult struct {
    Delivered bool `json:"delivered"`
    Choice string `json:"choice,omitempty"`
    Principal *callerPrincipal `json:"principal,omitempty"`
    HelperVersion string `json:"helperVersion,omitempty"`
    Error string `json:"error,omitempty"`
}
func init() { handlerRegistry["caller_verify"] = handleCallerVerify }
func handleCallerVerify(h *Heartbeat, cmd Command) tools.CommandResult {
    started := time.Now()
    raw, err := json.Marshal(cmd.Payload)
    var req ipc.CallerVerifyRequest
    if err == nil { err = json.Unmarshal(raw, &req) }
    digits := regexp.MustCompile(`^[0-9]{2}$`)
    seen := map[string]bool{}
    valid := err == nil && req.VerificationID != "" && req.Username != "" && req.TimeoutMs >= 30000 && req.TimeoutMs <= 300000 && len(req.Choices) == 3
    for _, choice := range req.Choices { valid = valid && digits.MatchString(choice) && !seen[choice]; seen[choice] = true }
    valid = valid && regexp.MustCompile(`^[0-9]{4}$`).MatchString(req.ReverseCode)
    if !valid { return tools.NewErrorResult(fmt.Errorf("invalid caller_verify payload"), time.Since(started).Milliseconds()) }
    out := callerVerifyResult{Error: "no_session_for_user"}
    if h.sessionBroker != nil {
        detector := sessionbroker.NewSessionDetector()
        out = runCallerVerify(req, func(u string) (*sessionbroker.Session, sessionbroker.DetectedSession, string) {
            return h.sessionBroker.CallerVerifySession(u, detector)
        }, h.sessionBroker.SendCommandAndWait, principalForCaller)
    }
    encoded, _ := json.Marshal(out)
    return tools.CommandResult{Status: "completed", Stdout: string(encoded), DurationMs: time.Since(started).Milliseconds()}
}
func runCallerVerify(req ipc.CallerVerifyRequest,
    resolve func(string) (*sessionbroker.Session, sessionbroker.DetectedSession, string),
    send func(*sessionbroker.Session, string, string, any, time.Duration) (*ipc.Envelope, error),
    principal func(*sessionbroker.Session, string) *callerPrincipal,
) callerVerifyResult {
    s, login, reason := resolve(req.Username)
    if reason != "" { return callerVerifyResult{Error: reason} }
    out := callerVerifyResult{Delivered: true, Choice: "timeout"}
    response, err := send(s, "caller-verify-"+req.VerificationID, ipc.TypeCallerVerifyRequest, req, time.Duration(req.TimeoutMs+2000)*time.Millisecond)
    if err != nil || response == nil || response.Error != "" { return out }
    var answer ipc.CallerVerifyResponse
    if json.Unmarshal(response.Payload, &answer) != nil { return out }
    allowed := answer.Choice == "not_me" || answer.Choice == "timeout"
    for _, choice := range req.Choices { allowed = allowed || answer.Choice == choice }
    if !allowed { return out }
    out.Choice = answer.Choice; out.HelperVersion = answer.HelperVersion
    out.Principal = principal(s, login.Username)
    if out.Principal == nil { return callerVerifyResult{Error: "no_session_for_user"} }
    return out
}
```

Windows file (`//go:build windows`, package heartbeat, imports `strings`, `golang.org/x/sys/windows`, `sessionbroker`):

```go
func principalForCaller(s *sessionbroker.Session, username string) *callerPrincipal {
    p := &callerPrincipal{SID: s.IdentityKey, Username: username}
    sid, err := windows.StringToSid(s.IdentityKey); if err != nil { return nil }
    account, domain, _, err := sid.LookupAccount(""); if err != nil { return nil }
    canonical := account; if domain != "" { canonical = domain + `\` + account }
    if !strings.EqualFold(canonical, username) { return nil }
    upn, err := windows.TranslateAccountName(canonical, windows.NameSamCompatible, windows.NameUserPrincipal, 256)
    if err == nil { p.UPN = upn }; return p
}
```

Unix file (`//go:build !windows`, package heartbeat, import `sessionbroker`):

```go
func principalForCaller(s *sessionbroker.Session, username string) *callerPrincipal {
    uid := s.UID
    return &callerPrincipal{UID: &uid, Username: username, UPN: callerLoginUPN(username)}
}
func callerLoginUPN(username string) string {
    // Neither supported Unix detector exposes a verified Platform SSO UPN.
    // Empty is the supported best-effort result; never guess from email or home path.
    return ""
}
```

The repo's OneDrive `sessionUpns` reads account-slot email, not login identity; do not use it. Windows `GetUserNameEx` in the service would return the service identity; SID translation avoids that. Unix remains unbound unless W01 already has a valid binding for the reported principal. A future verified Platform SSO reader can replace only `callerLoginUPN`.

- [ ] **Step 4: Run** `cd agent && go test -race ./internal/heartbeat/... ./internal/sessionbroker/...`. Expected: pass. Validate SID lookup with Windows tests and UID including zero on Unix; pointer UID preserves zero on the wire.
- [ ] **Step 5: Commit.**

```bash
git add agent/internal/heartbeat/caller_verify.go agent/internal/heartbeat/caller_verify_test.go agent/internal/heartbeat/caller_principal_windows.go agent/internal/heartbeat/caller_principal_unix.go
git commit -m "feat(agent): execute caller verification and report session principal"
```

### Task 4: Carry live helper readiness to the API without a migration

**Files:** Modify `agent/internal/heartbeat/heartbeat.go:112,4307`; `agent/internal/sessionbroker/broker.go:3299`; `apps/api/src/routes/agents/schemas.ts:189`; `apps/api/src/routes/agents/heartbeat.ts:819`. Create `apps/api/src/services/callerVerification/workstationCapabilities.ts`, `apps/api/src/services/callerVerification/workstationCapabilities.test.ts`. Extend `agent/internal/heartbeat/caller_verify_test.go` and `agent/internal/sessionbroker/caller_verify_test.go`.

**Interfaces:** Produces `recordWorkstationCapabilities(orgId: string, deviceId: string, observation: { callerVerify: boolean; usernames: string[] } | undefined): Promise<void>` and `workstationUserAvailable(orgId: string, deviceId: string, username: string): Promise<boolean>`. This new heartbeat field is telemetry, not a change to the frozen device-command payload.

- [ ] **Step 1: Write cache behavior tests.**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const redis = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }));
vi.mock('../redis', () => ({ getRedis: () => redis }));
import { recordWorkstationCapabilities, workstationUserAvailable } from './workstationCapabilities';
beforeEach(() => vi.resetAllMocks());
it('replaces readiness with an expiring observation and clears old-agent reports', async () => {
  await recordWorkstationCapabilities('o', 'd', { callerVerify: true, usernames: ['ACME\\alex'] });
  expect(redis.set).toHaveBeenCalledWith('caller-verify-cap:o:d', JSON.stringify(['ACME\\alex']), 'EX', 180);
  await recordWorkstationCapabilities('o', 'd', undefined);
  expect(redis.del).toHaveBeenCalledWith('caller-verify-cap:o:d');
});
it('requires the chosen user on the chosen org/device and fails closed', async () => {
  redis.get.mockResolvedValueOnce('["ACME\\\\alex"]');
  expect(await workstationUserAvailable('o', 'd', 'ACME\\alex')).toBe(true);
  redis.get.mockResolvedValueOnce('["someone-else"]');
  expect(await workstationUserAvailable('o', 'd', 'ACME\\alex')).toBe(false);
  redis.get.mockRejectedValueOnce(new Error('redis unavailable'));
  expect(await workstationUserAvailable('o', 'd', 'ACME\\alex')).toBe(false);
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationCapabilities.test.ts`. Expected: missing module.
- [ ] **Step 3: Implement cache and telemetry.** Use exact username comparison: suggestions return the detector's canonical spelling; silently folding Unix usernames can select another account.

```ts
import { getRedis } from '../redis';
const key = (orgId: string, deviceId: string) => `caller-verify-cap:${orgId}:${deviceId}`;
export async function recordWorkstationCapabilities(orgId: string, deviceId: string,
  observation: { callerVerify: boolean; usernames: string[] } | undefined): Promise<void> {
  const redis = getRedis(); if (!redis) return;
  const users = observation?.callerVerify ? [...new Set(observation.usernames)].slice(0, 32) : [];
  try {
    if (users.length) await redis.set(key(orgId, deviceId), JSON.stringify(users), 'EX', 180);
    else await redis.del(key(orgId, deviceId));
  } catch (error) { console.warn('[CallerVerification] readiness cache write failed', { deviceId, error }); }
}
export async function workstationUserAvailable(orgId: string, deviceId: string, username: string): Promise<boolean> {
  try {
    const raw = await getRedis()?.get(key(orgId, deviceId));
    if (!raw) return false;
    const users: unknown = JSON.parse(raw);
    return Array.isArray(users) && users.some(value => typeof value === 'string' && value === username);
  } catch { return false; }
}
```

Go additions in `caller_verify.go`, with the field `HelperCapabilities callerHelperCapabilities` tagged `json:"helperCapabilities"` on `HeartbeatPayload`, and `HelperCapabilities: h.callerHelperCapabilities()` in the payload literal:

```go
type callerHelperCapabilities struct {
    CallerVerify bool `json:"callerVerify"`
    Usernames []string `json:"usernames"`
}
func (h *Heartbeat) callerHelperCapabilities() callerHelperCapabilities {
    users := []string{}
    if h.sessionBroker != nil { users = h.sessionBroker.CallerVerifyUsers(sessionbroker.NewSessionDetector()) }
    return callerHelperCapabilities{CallerVerify: len(users) > 0, Usernames: users}
}
```

In `sanitizeCapabilitiesForSession`, before the nil-session return:

```go
sanitized.CallerVerify = session != nil && session.HelperRole == ipc.HelperRoleAssist && session.HasScope(ipc.ScopeConsentUI) && caps.CallerVerify
```

API schema insertion and authenticated heartbeat call (import the function from `../../services/callerVerification/workstationCapabilities`):

```ts
// heartbeatSchema field beside helperVersion:
helperCapabilities: z.object({
  callerVerify: z.boolean(),
  usernames: z.array(z.string().min(1).max(255)).max(32),
}).optional().catch(undefined),
// In processHeartbeat, where device and parsed data are already resolved:
await recordWorkstationCapabilities(device.orgId, device.id, data.helperCapabilities);
```

No version-string comparison. False/missing replaces a former true report. TTL is deliberately short; a configured heartbeat slower than three minutes conservatively makes workstation unavailable between reports. Dispatch re-resolves the session even when telemetry is fresh.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationCapabilities.test.ts src/routes/agents/heartbeat.test.ts`; `cd agent && go test -race ./internal/heartbeat/... ./internal/sessionbroker/...`. Expected: pass; absent field remains accepted by old-agent schema fixtures.
- [ ] **Step 5: Commit.**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/caller_verify.go agent/internal/sessionbroker/broker.go agent/internal/heartbeat/caller_verify_test.go agent/internal/sessionbroker/caller_verify_test.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/heartbeat.ts apps/api/src/services/callerVerification/workstationCapabilities.ts apps/api/src/services/callerVerification/workstationCapabilities.test.ts
git commit -m "feat(caller-verification): report live per-user helper capability"
```

### Task 5: Add the Rust pending-request bridge and correlated IPC response

**Files:** Create `apps/helper/src-tauri/src/ipc/caller_verify.rs`. Modify `apps/helper/src-tauri/src/ipc/mod.rs:1`; `apps/helper/src-tauri/src/ipc/client.rs:176,253,274,320,373`; `apps/helper/src-tauri/src/lib.rs:1047,1258`; `apps/helper/src-tauri/capabilities/default.json:4`. Reference `apps/helper/src-tauri/src/ipc/desktop.rs:122,164` and client duplex tests at `apps/helper/src-tauri/src/ipc/client.rs:535`.

**Interfaces:** Produces `CallerVerifyBridge::{connect,clear,insert,get,submit}`, `show_window`, `get_caller_verify_request`, `submit_caller_verify`; response `{ choice, helperVersion }` on the original envelope id. No principal arrives from Rust/React.

- [ ] **Step 1: Write Rust tests in the new module.**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn request() -> Request {
        serde_json::from_str(r#"{"verificationId":"11111111-1111-4111-8111-111111111111","username":"alex","technicianName":"Sam","orgName":"Acme","actionLabel":"reset the password","targetLabel":"alex@example.com","reverseCode":"7319","choices":["42","17","86"],"timeoutMs":30000}"#).unwrap()
    }
    #[test]
    fn correlates_and_submits_once() {
        let bridge = CallerVerifyBridge::default();
        let mut rx = bridge.connect();
        let req = request(); let id = req.verification_id.clone();
        bridge.insert("original-envelope".into(), req).unwrap();
        assert!(bridge.submit(&id, "99").is_err());
        bridge.submit(&id, "not_me").unwrap();
        let response = rx.try_recv().unwrap();
        assert_eq!(response.envelope_id, "original-envelope");
        assert_eq!(response.choice, "not_me");
        assert!(bridge.submit(&id, "42").is_err());
    }
    #[test]
    fn disconnect_clears_pending_and_sender() {
        let bridge = CallerVerifyBridge::default(); let _rx = bridge.connect();
        let req = request(); let id = req.verification_id.clone();
        bridge.insert("e".into(), req).unwrap(); bridge.clear();
        assert!(bridge.get(&id).is_none()); assert!(bridge.submit(&id, "42").is_err());
    }
}
```

- [ ] **Step 2: Run** `cd apps/helper/src-tauri && cargo test ipc::caller_verify`. Expected: unresolved new types after registering `pub mod caller_verify;`.
- [ ] **Step 3: Implement bridge and window.** New module imports `std::{collections::HashMap,sync::Mutex,time::{Duration,Instant,SystemTime,UNIX_EPOCH}}`, `serde::{Serialize,Deserialize}`, `tauri::{Manager,WebviewUrl,WebviewWindowBuilder}`, `tokio::sync::mpsc`.

```rust
fn valid_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().enumerate().all(|(i,b)|
        if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub verification_id: String, pub username: String, pub technician_name: String,
    pub org_name: String, pub action_label: String, pub target_label: String,
    pub reverse_code: String, pub choices: [String; 3], pub timeout_ms: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View { pub request: Request, pub deadline_ms: u64 }
pub struct Response { pub envelope_id: String, pub choice: String }
struct Pending { envelope_id: String, view: View, deadline: Instant }
#[derive(Default)]
struct State { sender: Option<mpsc::UnboundedSender<Response>>, pending: HashMap<String, Pending> }
#[derive(Default)]
pub struct CallerVerifyBridge { state: Mutex<State> }
impl CallerVerifyBridge {
    pub fn connect(&self) -> mpsc::UnboundedReceiver<Response> {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut state = self.state.lock().unwrap(); state.pending.clear(); state.sender = Some(tx); rx
    }
    pub fn clear(&self) { let mut state = self.state.lock().unwrap(); state.pending.clear(); state.sender = None; }
    pub fn insert(&self, envelope_id: String, request: Request) -> Result<(), String> {
        if !(30000..=300000).contains(&request.timeout_ms) || !valid_id(&request.verification_id)
            || request.choices.iter().any(|v| v.len() != 2 || !v.bytes().all(|b| b.is_ascii_digit()))
            || request.choices[0] == request.choices[1] || request.choices[0] == request.choices[2] || request.choices[1] == request.choices[2]
            { return Err("invalid caller request".into()); }
        let mut state = self.state.lock().unwrap();
        if state.sender.is_none() || state.pending.contains_key(&request.verification_id) { return Err("request unavailable".into()); }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
        let deadline = Instant::now() + Duration::from_millis(request.timeout_ms);
        let view = View { deadline_ms: now + request.timeout_ms, request };
        state.pending.insert(view.request.verification_id.clone(), Pending { envelope_id, view, deadline }); Ok(())
    }
    pub fn get(&self, id: &str) -> Option<View> { self.state.lock().ok()?.pending.get(id).map(|p| p.view.clone()) }
    pub fn submit(&self, id: &str, choice: &str) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        let pending = state.pending.get(id).ok_or("request unavailable")?;
        if choice != "not_me" && choice != "timeout" && !pending.view.request.choices.iter().any(|v| v == choice) { return Err("invalid choice".into()); }
        let choice = if choice != "not_me" && Instant::now() >= pending.deadline { "timeout" } else { choice };
        let response = Response { envelope_id: pending.envelope_id.clone(), choice: choice.into() };
        state.sender.as_ref().ok_or("IPC disconnected")?.send(response).map_err(|e| e.to_string())?;
        state.pending.remove(id); Ok(())
    }
}
pub fn show_window(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    WebviewWindowBuilder::new(app, format!("caller-verify-{id}"), WebviewUrl::App(format!("index.html#caller-verify/{id}").into()))
        .title("Breeze").inner_size(520.0, 680.0).center().decorations(false)
        .always_on_top(true).focused(true).skip_taskbar(true).resizable(false)
        .build().map(|_| ()).map_err(|e| e.to_string())
}
```

The helper has no `uuid` dependency; `valid_id` validates the UUID-shaped window key without adding one. Add `caller_verify: Arc<CallerVerifyBridge>` to `DesktopCtx`, initialize and `app.manage` it beside the consent bridge. Register these commands in `generate_handler!`:

```rust
#[tauri::command]
fn get_caller_verify_request(window: tauri::WebviewWindow, bridge: tauri::State<'_, std::sync::Arc<crate::ipc::caller_verify::CallerVerifyBridge>>, verification_id: String) -> Result<crate::ipc::caller_verify::View, String> {
    if window.label() != format!("caller-verify-{verification_id}") { return Err("wrong window".into()); }
    bridge.get(&verification_id).ok_or_else(|| "request unavailable".into())
}
#[tauri::command]
fn submit_caller_verify(window: tauri::WebviewWindow, bridge: tauri::State<'_, std::sync::Arc<crate::ipc::caller_verify::CallerVerifyBridge>>, verification_id: String, choice: String) -> Result<(), String> {
    if window.label() != format!("caller-verify-{verification_id}") { return Err("wrong window".into()); }
    bridge.submit(&verification_id, &choice)?; window.close().map_err(|e| e.to_string())
}
```

In `client.rs`, add `Capabilities` (none exists today), initialize an always-present receiver before the select loop; only connect the managed bridge with a real `desktop_ctx`:

```rust
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capabilities { caller_verify: bool }
// Add `use tauri::Manager;` for get_webview_window / webview_windows.
// After successful authentication and consent channel setup:
let detached = super::caller_verify::CallerVerifyBridge::default();
let mut caller_rx = match desktop_ctx { Some(ctx) => ctx.caller_verify.connect(), None => detached.connect() };
let _bridge_guard = BridgeClearGuard {
    bridge: desktop_ctx.map(|c| c.bridge.clone()),
    caller: desktop_ctx.map(|c| c.caller_verify.clone()),
    app: desktop_ctx.map(|c| c.app.clone()),
};
let mut caller_tick = tokio::time::interval(std::time::Duration::from_millis(250));
if desktop_ctx.is_some() {
    write_frame(&mut stream, &session_key, &mut send_seq, "capabilities", "capabilities",
        Some(to_raw_payload(&Capabilities { caller_verify: true })?)).await?;
}
// New tokio::select! arm:
Some(response) = caller_rx.recv() => {
    let payload = serde_json::json!({"choice":response.choice,"helperVersion":env!("CARGO_PKG_VERSION")});
    write_frame(&mut stream, &session_key, &mut send_seq, &response.envelope_id,
        "caller_verify_response", Some(to_raw_payload(&payload)?)).await?;
    continue;
}
// New message match arm:
"caller_verify_request" => {
    let req: super::caller_verify::Request = parse_payload(&env.payload)?;
    if let Some(ctx) = desktop_ctx {
        let id = req.verification_id.clone();
        if ctx.caller_verify.insert(env.id.clone(), req).is_ok() {
            if super::caller_verify::show_window(&ctx.app, &id).is_err() { let _ = ctx.caller_verify.submit(&id, "timeout"); }

        }
    }
}
```

The IPC loop owns timeout polling; **do not spawn detached timers** that survive reconnect and expire a replacement request. Add this bridge method and select arm:

```rust
// Inside impl CallerVerifyBridge:
pub fn expire_due(&self) -> Vec<String> {
    let mut state = self.state.lock().unwrap();
    let due: Vec<String> = state.pending.iter().filter(|(_,p)| Instant::now() >= p.deadline).map(|(id,_)|id.clone()).collect();
    for id in &due {
        if let Some(pending) = state.pending.remove(id) {
            if let Some(sender) = &state.sender { let _ = sender.send(Response { envelope_id: pending.envelope_id, choice: "timeout".into() }); }
        }
    }
    due
}
// Inside client.rs tokio::select!:
_ = caller_tick.tick() => {
    if let Some(ctx) = desktop_ctx {
        for id in ctx.caller_verify.expire_due() {
            if let Some(window) = ctx.app.get_webview_window(&format!("caller-verify-{id}")) { let _ = window.close(); }
        }
    }
    continue;
}
// Replace the existing guard definition/drop; only ONE guard is constructed.
struct BridgeClearGuard {
    bridge: Option<std::sync::Arc<ConsentBridge>>,
    caller: Option<std::sync::Arc<super::caller_verify::CallerVerifyBridge>>,
    app: Option<AppHandle>,
}
impl Drop for BridgeClearGuard {
    fn drop(&mut self) {
        if let Some(bridge) = &self.bridge { bridge.clear_sender(); }
        if let Some(caller) = &self.caller { caller.clear(); }
        if let Some(app) = &self.app {
            for (label,window) in app.webview_windows() { if label.starts_with("caller-verify-") { let _ = window.close(); } }
        }
    }
}
```

Create/manage the additional bridge explicitly in `lib.rs:1258`:

```rust
let caller_verify = std::sync::Arc::new(crate::ipc::caller_verify::CallerVerifyBridge::default());
app.manage(caller_verify.clone());
let desktop_ctx = crate::ipc::client::DesktopCtx { app: app.handle().clone(), bridge, caller_verify };
```

Add `pub caller_verify: std::sync::Arc<super::caller_verify::CallerVerifyBridge>` to `DesktopCtx`; add both commands to `generate_handler!`; add `"caller-verify-*"` to capability `windows`. Construct the guard before sending capabilities so a failed write cleans up too. Add this reconnect/deadline regression inside the Rust test module:

```rust
#[test]
fn deadline_is_owned_by_current_session() {
    let bridge=CallerVerifyBridge::default();let mut old=bridge.connect();
    let req=request();let id=req.verification_id.clone();bridge.insert("old".into(),req.clone()).unwrap();
    bridge.state.lock().unwrap().pending.get_mut(&id).unwrap().deadline=Instant::now();
    bridge.clear();let mut current=bridge.connect();bridge.insert("new".into(),req).unwrap();
    assert!(bridge.expire_due().is_empty());assert!(current.try_recv().is_err());assert!(old.try_recv().is_err());
    bridge.state.lock().unwrap().pending.get_mut(&id).unwrap().deadline=Instant::now();
    assert_eq!(bridge.expire_due(),vec![id]);assert_eq!(current.try_recv().unwrap().choice,"timeout");
}
```

- [ ] **Step 4: Run** `cd apps/helper/src-tauri && cargo test ipc::caller_verify`; `cd apps/helper/src-tauri && cargo test ipc::client`. Expected: bridge tests and prior authenticated framing/sequence tests pass; add a capabilities serialization assertion `assert_eq!(serde_json::to_value(Capabilities { caller_verify: true }).unwrap(), serde_json::json!({"callerVerify":true}));` to the existing client test module.
- [ ] **Step 5: Commit.**

```bash
git add apps/helper/src-tauri/src/ipc/caller_verify.rs apps/helper/src-tauri/src/ipc/mod.rs apps/helper/src-tauri/src/ipc/client.rs apps/helper/src-tauri/src/lib.rs apps/helper/src-tauri/capabilities/default.json
git commit -m "feat(helper): bridge correlated caller verification prompts"
```

### Task 6: Render the translated caller card with a fixed deadline

**Files:** Create `apps/helper/src/windows/CallerVerifyWindow.tsx`, `apps/helper/src/windows/CallerVerifyWindow.test.tsx`, `apps/helper/src/windows/callerVerifyMessages.ts`; modify `apps/helper/src/main.tsx:73`. No existing helper i18n framework exists; introduce a typed local dictionary.

**Interfaces:** Produces `CallerVerifyWindow({ req, deadlineMs, branding, locale, onDecision })`, with `onDecision(choice: string): Promise<void>`. Consumes Task 5 `View`, hydration and submission commands. English safety copy is verbatim from the spec.

- [ ] **Step 1: Write React tests (helper defaults to node, so jsdom pragma is required).**

```tsx
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { CallerVerifyWindow } from './CallerVerifyWindow';
const req = { verificationId: '11111111-1111-4111-8111-111111111111', username: 'alex', technicianName: 'Sam', orgName: 'Acme', actionLabel: 'reset the password', targetLabel: 'alex@example.com', reverseCode: '7319', choices: ['42','17','86'], timeoutMs: 30000 };
afterEach(() => vi.useRealTimers());
it('shows exact action/target, three choices, reverse code and safety copy', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  render(<CallerVerifyWindow req={req} deadlineMs={Date.now()+30000} branding={{partnerName:'Northwind',logoUrl:null}} locale="en" onDecision={send}/>);
  expect(screen.getByText('7319')).toBeTruthy();
  expect(screen.getByText(/reset the password for alex@example.com/)).toBeTruthy();
  expect(screen.getByText(/number you already have/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button',{name:'42',exact:true}));
  fireEvent.click(screen.getByRole('button',{name:'42',exact:true}));
  expect(send).toHaveBeenCalledExactlyOnceWith('42');
});
it('timeout never chooses a number', async () => {
  vi.useFakeTimers(); const send = vi.fn().mockResolvedValue(undefined);
  render(<CallerVerifyWindow req={req} deadlineMs={Date.now()+1000} branding={null} locale="en" onDecision={send}/>);
  await act(async () => { vi.advanceTimersByTime(1001); });
  expect(send).toHaveBeenCalledExactlyOnceWith('timeout');
});
it('not-me is explicit and a failed send stays visible', async () => {
  const send = vi.fn().mockRejectedValue(new Error('offline'));
  render(<CallerVerifyWindow req={req} deadlineMs={Date.now()+30000} branding={null} locale="en" onDecision={send}/>);
  fireEvent.click(screen.getByRole('button',{name:'This is not me'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not send');
  expect(send).toHaveBeenCalledWith('not_me');
});
```

- [ ] **Step 2: Run** `cd apps/helper && npx vitest run src/windows/CallerVerifyWindow.test.tsx`. Expected: missing component.
- [ ] **Step 3: Implement dictionary and component.** Store these actual translations as the dictionary values in `callerVerifyMessages.ts`; all functions interpolate plain React text, never HTML.

```ts
type Copy = { title:string; notMe:string; failed:string; remaining:string; request:(t:string,o:string,a:string,x:string)=>string; safety:(t:string,p:string)=>string };
export const messages: Record<string, Copy> = {
  en: {title:'Caller verification',notMe:'This is not me',failed:'Could not send your answer. Try again.',remaining:'seconds remaining',request:(t,o,a,x)=>`${t} from ${o} is on the phone with you and wants to ${a} for ${x}`,safety:(t,p)=>`Only tap a number if you are on the phone with ${t} right now. If you are not sure, hang up and call ${p} on the number you already have.`},
  'de-DE': {title:'Anrufer bestätigen',notMe:'Das bin ich nicht',failed:'Ihre Antwort konnte nicht gesendet werden. Versuchen Sie es erneut.',remaining:'Sekunden verbleibend',request:(t,o,a,x)=>`${t} von ${o} spricht mit Ihnen am Telefon und möchte folgende Aktion für ${x} ausführen: ${a}`,safety:(t,p)=>`Tippen Sie nur auf eine Zahl, wenn Sie gerade mit ${t} telefonieren. Wenn Sie unsicher sind, legen Sie auf und rufen Sie ${p} unter der Ihnen bereits bekannten Nummer an.`},
  'es-419': {title:'Verificación de la persona que llama',notMe:'No soy yo',failed:'No se pudo enviar tu respuesta. Inténtalo de nuevo.',remaining:'segundos restantes',request:(t,o,a,x)=>`${t} de ${o} está hablando contigo por teléfono y quiere realizar esta acción para ${x}: ${a}`,safety:(t,p)=>`Toca un número solo si estás hablando por teléfono con ${t} en este momento. Si no estás seguro, cuelga y llama a ${p} al número que ya conoces.`},
  'fr-CA': {title:'Vérification de la personne qui appelle',notMe:'Ce n’est pas moi',failed:'Impossible d’envoyer votre réponse. Réessayez.',remaining:'secondes restantes',request:(t,o,a,x)=>`${t} de ${o} vous parle au téléphone et souhaite effectuer cette action pour ${x} : ${a}`,safety:(t,p)=>`Appuyez sur un numéro uniquement si vous êtes au téléphone avec ${t} en ce moment. En cas de doute, raccrochez et rappelez ${p} au numéro que vous connaissez déjà.`},
  'fr-FR': {title:'Vérification de l’appelant',notMe:'Ce n’est pas moi',failed:'Impossible d’envoyer votre réponse. Réessayez.',remaining:'secondes restantes',request:(t,o,a,x)=>`${t} de ${o} est au téléphone avec vous et souhaite effectuer cette action pour ${x} : ${a}`,safety:(t,p)=>`Appuyez sur un numéro uniquement si vous êtes au téléphone avec ${t} en ce moment. En cas de doute, raccrochez et rappelez ${p} au numéro que vous connaissez déjà.`},
  'it-IT': {title:'Verifica del chiamante',notMe:'Non sono io',failed:'Impossibile inviare la risposta. Riprova.',remaining:'secondi rimanenti',request:(t,o,a,x)=>`${t} di ${o} è al telefono con te e vuole eseguire questa azione per ${x}: ${a}`,safety:(t,p)=>`Tocca un numero solo se stai parlando al telefono con ${t} in questo momento. Se hai dubbi, riaggancia e chiama ${p} al numero che già conosci.`},
  'pt-BR': {title:'Verificação de quem está ligando',notMe:'Não sou eu',failed:'Não foi possível enviar sua resposta. Tente novamente.',remaining:'segundos restantes',request:(t,o,a,x)=>`${t} de ${o} está falando com você por telefone e quer realizar esta ação para ${x}: ${a}`,safety:(t,p)=>`Toque em um número somente se estiver falando ao telefone com ${t} agora. Se tiver dúvidas, desligue e ligue para ${p} usando o número que você já conhece.`},
  'tr-TR': {title:'Arayan doğrulaması',notMe:'Bu ben değilim',failed:'Yanıtınız gönderilemedi. Yeniden deneyin.',remaining:'saniye kaldı',request:(t,o,a,x)=>`${o} kuruluşundan ${t} sizinle telefonda konuşuyor ve ${x} için şu işlemi yapmak istiyor: ${a}`,safety:(t,p)=>`Yalnızca şu anda ${t} ile telefonda konuşuyorsanız bir sayıya dokunun. Emin değilseniz telefonu kapatın ve ${p} kuruluşunu zaten bildiğiniz numaradan arayın.`},
};
export function copyFor(locale: string): Copy {
  const base: Record<string,string> = {en:'en',de:'de-DE',es:'es-419',fr:'fr-FR',it:'it-IT',pt:'pt-BR',tr:'tr-TR'};
  return messages[locale] ?? messages[base[locale.split('-')[0]!] ?? 'en']!;
}
```

```tsx
import { useEffect, useRef, useState } from 'react';
import { copyFor } from './callerVerifyMessages';
export interface CallerRequest { verificationId:string; username:string; technicianName:string; orgName:string; actionLabel:string; targetLabel:string; reverseCode:string; choices:string[]; timeoutMs:number }
export type Branding = {partnerName:string; logoUrl:string|null}|null;
export function CallerVerifyWindow({req,deadlineMs,branding,locale,onDecision}:{req:CallerRequest;deadlineMs:number;branding:Branding;locale:string;onDecision:(choice:string)=>Promise<void>}) {
  const copy = copyFor(locale); const sent = useRef(false);
  const [remaining,setRemaining] = useState(Math.max(0,Math.ceil((deadlineMs-Date.now())/1000)));
  const [busy,setBusy] = useState(false); const [error,setError] = useState(false);
  const submit = async (choice:string) => {
    if (sent.current) return; sent.current=true; setBusy(true); setError(false);
    try { await onDecision(choice); } catch { sent.current=false; setBusy(false); setError(true); }
  };
  const submitRef = useRef(submit); submitRef.current=submit;
  useEffect(()=>{
    const tick=()=>{const n=Math.max(0,Math.ceil((deadlineMs-Date.now())/1000));setRemaining(n);if(n===0)void submitRef.current('timeout');};
    tick(); const timer=setInterval(tick,250); return ()=>clearInterval(timer);
  },[deadlineMs]);
  return <main role="alertdialog" aria-labelledby="caller-title" style={{padding:28,maxWidth:500,margin:'auto',fontFamily:'Inter, sans-serif'}}>
    <header>{branding?.logoUrl && <img src={branding.logoUrl} alt="" referrerPolicy="no-referrer" style={{maxWidth:180,maxHeight:56}}/>}<strong>{branding?.partnerName ?? 'Breeze'}</strong></header>
    <h1 id="caller-title">{copy.title}</h1>
    <p>{copy.request(req.technicianName,req.orgName,req.actionLabel,req.targetLabel)}</p>
    <p style={{fontSize:48,fontWeight:800,letterSpacing:12,textAlign:'center'}}>{req.reverseCode}</p>
    <div style={{display:'flex',gap:16,justifyContent:'center'}}>{req.choices.map(choice=><button key={choice} disabled={busy||remaining===0} onClick={()=>void submit(choice)} style={{fontSize:32,minWidth:92,minHeight:64}}>{choice}</button>)}</div>
    <button disabled={busy} onClick={()=>void submit('not_me')} style={{marginTop:24,minHeight:44,width:'100%'}}>{copy.notMe}</button>
    <p aria-live="off">{remaining} {copy.remaining}</p><p>{copy.safety(req.technicianName,branding?.partnerName ?? 'Breeze')}</p>
    {error && <p role="alert">{copy.failed}</p>}
  </main>;
}
```

**Apply this host integration in Task 7**, after its branding module exists, so Task 6 remains type-correct. Hydrate with `invoke('get_caller_verify_request',{verificationId})` after mount in a new `CallerVerifyHost` in `main.tsx`. Keep original `deadlineMs`; never restart timeout on render. Add the hash branch before `#consent`:

```tsx
function CallerVerifyHost({verificationId}:{verificationId:string}) {
  const [view,setView]=useState<{request:CallerRequest;deadlineMs:number}|null>(null);
  const [branding,setBranding]=useState<Branding>(null);
  useEffect(()=>{let live=true;
    invoke<{request:CallerRequest;deadlineMs:number}>('get_caller_verify_request',{verificationId}).then(v=>{if(live)setView(v);}).catch(()=>{void getCurrentWindow().close();});
    loadCallerBranding().then(v=>{if(live)setBranding(v);}).catch(()=>{});
    return ()=>{live=false;};
  },[verificationId]);
  if(!view)return null;
  return <CallerVerifyWindow req={view.request} deadlineMs={view.deadlineMs} branding={branding} locale={navigator.language} onDecision={choice=>invoke('submit_caller_verify',{verificationId,choice})}/>;
}
// Entry branch:
// if (hash.startsWith('#caller-verify/')) root=<CallerVerifyHost verificationId={hash.slice('#caller-verify/'.length)}/>;
```

Import the component/types and `loadCallerBranding` (Task 7). Add a dictionary parity test:

```ts
import { messages } from './callerVerifyMessages';
it('ships eight translated cards',()=>{
  expect(Object.keys(messages).sort()).toEqual(['de-DE','en','es-419','fr-CA','fr-FR','it-IT','pt-BR','tr-TR']);
  for(const [locale,copy] of Object.entries(messages)) {
    expect(Object.keys(copy).sort()).toEqual(Object.keys(messages.en!).sort());
    if(locale!=='en')expect(copy.safety('Sam','Northwind')).not.toBe(messages.en!.safety('Sam','Northwind'));
  }
});
```

- [ ] **Step 4: Run** `cd apps/helper && npx vitest run src/windows/CallerVerifyWindow.test.tsx`. Expected: pass; host integration is applied in Task 7. Verify long translated copy fits the fixed window on all three desktop platforms before release.
- [ ] **Step 5: Commit.**

```bash
git add apps/helper/src/windows/CallerVerifyWindow.tsx apps/helper/src/windows/CallerVerifyWindow.test.tsx apps/helper/src/windows/callerVerifyMessages.ts
git commit -m "feat(helper): render translated caller verification card"
```

### Task 7: Fetch partner branding through the authenticated helper config

**Files:** Create `apps/api/src/services/callerVerification/helperBranding.ts`, `apps/api/src/services/callerVerification/helperBranding.test.ts`, `apps/helper/src/windows/callerVerifyBranding.ts`. Modify `apps/api/src/routes/helper/index.ts:514`; `apps/helper/src/main.tsx:1`; `apps/helper/src-tauri/tauri.conf.json:31`; `apps/api/src/routes/helper/index.test.ts:267`. Verified sources: `apps/api/src/db/schema/orgs.ts:24`, `apps/api/src/db/schema/partnerLoginBranding.ts:9`, `apps/api/src/middleware/helperAuth.ts:156`, `apps/api/src/db/partnerAxisRead.ts:56`, `apps/api/src/routes/supportPublic.ts:188`.

**Interfaces:** Produces `callerHelperBranding(orgId: string): Promise<{partnerName:string;logoUrl:string|null}|null>` and `loadCallerBranding(): Promise<Branding>`. Consumes `helperRequest(config: AgentConfig, url: string, options): Promise<{ok:boolean;status:number;body:string}>`.

- [ ] **Step 1: Write URL-sanitization tests.**

```ts
import { expect, it } from 'vitest';
import { safeLogo } from './helperBranding';
it.each(['javascript:alert(1)','http://example.com/logo','data:image/svg+xml,x',''])('rejects %s', value=>expect(safeLogo(value)).toBeNull());
it('permits an HTTPS logo',()=>expect(safeLogo('https://example.com/logo.png')).toBe('https://example.com/logo.png'));
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/helperBranding.test.ts`. Expected: missing module.
- [ ] **Step 3: Implement authenticated lookup.** Resolve org under current RLS; only the resulting partner id may enter the partner-axis helper. This avoids assuming that an org context automatically reads partner-axis branding.

```ts
import { eq } from 'drizzle-orm';
import { db } from '../../db';
import { readWithPartnerAxisVisibility } from '../../db/partnerAxisRead';
import { organizations, partners, partnerLoginBranding } from '../../db/schema';
export function safeLogo(value: string | null): string | null {
  try { const url=new URL(value ?? ''); return url.protocol==='https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
}
export async function callerHelperBranding(orgId:string) {
  const [org]=await db.select({partnerId:organizations.partnerId}).from(organizations).where(eq(organizations.id,orgId)).limit(1);
  if(!org?.partnerId)return null;
  const [brand]=await readWithPartnerAxisVisibility(()=>db.select({name:partners.name,logo:partnerLoginBranding.logoUrl}).from(partners)
    .leftJoin(partnerLoginBranding,eq(partnerLoginBranding.partnerId,partners.id)).where(eq(partners.id,org.partnerId!)).limit(1));
  return brand ? {partnerName:brand.name.trim().slice(0,120),logoUrl:safeLogo(brand.logo)} : null;
}
```

Add `branding: await callerHelperBranding(device.orgId)` to existing `/helper/config` JSON. In `routes/helper/index.test.ts`, keep the config test isolated from the partner query using:

```ts
vi.mock('../../services/callerVerification/helperBranding',()=>({callerHelperBranding:vi.fn(async()=>({partnerName:'Northwind',logoUrl:null}))}));
```

 No client partner id is accepted. Frontend file:

```ts
import { invoke } from '@tauri-apps/api/core';
import { helperRequest, type AgentConfig } from '../lib/helperFetch';
import type { Branding } from './CallerVerifyWindow';
export async function loadCallerBranding():Promise<Branding> {
  const config=await invoke<AgentConfig>('read_agent_config');
  const response=await helperRequest(config,`${config.api_url.replace(/\/$/,'')}/api/v1/helper/config`,{method:'GET'});
  if(!response.ok)throw new Error(`Helper config failed (${response.status})`);
  return (JSON.parse(response.body) as {branding:Branding}).branding;
}
```

Apply Task 6's host integration now and import `loadCallerBranding` in main. Existing helper consumers append `/api/v1` to this origin (`stores/chatStore.ts:643`). Append `img-src 'self' https:` to the existing CSP, preserving all existing directives. Missing/failed branding uses visible Breeze text and never suppresses the safety copy or delays mounting the challenge.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/callerVerification/helperBranding.test.ts src/routes/helper/index.test.ts`; `cd apps/helper && npx tsc --noEmit`. Expected: pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/helperBranding.ts apps/api/src/services/callerVerification/helperBranding.test.ts apps/api/src/routes/helper/index.ts apps/api/src/routes/helper/index.test.ts apps/helper/src/windows/callerVerifyBranding.ts apps/helper/src/main.tsx apps/helper/src-tauri/tauri.conf.json
git commit -m "feat(helper): load authenticated partner branding for caller prompts"
```

### Task 8: Validate the frozen API wire shapes and register partner trust

**Files:** Create `apps/api/src/services/callerVerification/workstationProtocol.ts`, `apps/api/src/services/callerVerification/workstationProtocol.test.ts`; modify `apps/api/src/services/partnerTrust.ts:124`; `apps/api/src/services/commandTypes.ts:14`, `apps/api/src/services/commandOfflinePolicy.ts:82` (LIVE list). Reference its explicit classification contract; `apps/api/src/services/partnerTrust.commands.ts:12`.

**Interfaces:** Produces `workstationCommandSchema`, `workstationResultSchema`, `readWorkstationResult(stdout: string | undefined, result: unknown): WorkstationResult | null`. Frozen result stdout JSON is `{ delivered: boolean, choice?: string | 'not_me' | 'timeout', principal?: { sid?: string; uid?: number; username: string; upn?: string }, helperVersion?: string, error?: 'no_session_for_user' | 'session_not_console' | 'helper_outdated' }`.

- [ ] **Step 1: Write codec and trust tests.**

```ts
import { expect, it } from 'vitest';
import { GATED_COMMAND_TYPES, LIFECYCLE_COMMAND_TYPES } from '../partnerTrust';
import { defaultOfflinePolicy } from '../commandOfflinePolicy';
import { readWorkstationResult, workstationCommandSchema } from './workstationProtocol';
it('registers caller verification as gated operator content',()=>{
  expect(GATED_COMMAND_TYPES).toContain('caller_verify'); expect(LIFECYCLE_COMMAND_TYPES).not.toContain('caller_verify');
  expect(defaultOfflinePolicy('caller_verify')).toEqual({kind:'reject'});
});
it('reads both HTTP stdout and WS structured result',()=>{
  const value={delivered:true,choice:'42',principal:{uid:0,username:'root'}};
  expect(readWorkstationResult(JSON.stringify(value),undefined)).toEqual(value);
  expect(readWorkstationResult(undefined,value)).toEqual(value);
  expect(readWorkstationResult('{',undefined)).toBeNull();
  expect(readWorkstationResult(undefined,{delivered:true,choice:'allow'})).toBeNull();
  expect(readWorkstationResult(undefined,{delivered:true,principal:{sid:'S-1',uid:5,username:'alex'}})).toBeNull();
});
it('rejects extra or duplicate choices',()=>{
  const payload={verificationId:'11111111-1111-4111-8111-111111111111',username:'alex',technicianName:'Sam',orgName:'Acme',actionLabel:'reset the password',targetLabel:'alex@example.com',reverseCode:'7319',choices:['42','42','17'],timeoutMs:120000};
  expect(workstationCommandSchema.safeParse(payload).success).toBe(false);
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationProtocol.test.ts`. Expected: missing module/allowlist membership.
- [ ] **Step 3: Implement codecs.**

```ts
import { z } from 'zod';
const numberChoice=z.string().regex(/^\d{2}$/);
export const workstationCommandSchema=z.object({
  verificationId:z.string().uuid(),username:z.string().min(1).max(255),
  technicianName:z.string().min(1).max(255),orgName:z.string().min(1).max(255),
  actionLabel:z.string().min(1).max(255),targetLabel:z.string().min(1).max(320),
  reverseCode:z.string().regex(/^\d{4}$/),choices:z.tuple([numberChoice,numberChoice,numberChoice]),
  timeoutMs:z.number().int().min(30000).max(300000),
}).refine(v=>new Set(v.choices).size===3);
export const workstationResultSchema=z.object({
  delivered:z.boolean(),choice:z.union([numberChoice,z.literal('not_me'),z.literal('timeout')]).optional(),
  principal:z.object({sid:z.string().regex(/^S-\d(?:-\d+)+$/).optional(),uid:z.number().int().min(0).max(4294967295).optional(),username:z.string().min(1).max(255),upn:z.string().max(320).optional()})
    .refine(p=>(p.sid!==undefined)!==(p.uid!==undefined)).optional(),
  helperVersion:z.string().max(64).optional(),
  error:z.enum(['no_session_for_user','session_not_console','helper_outdated']).optional(),
}).refine(v=>v.delivered ? !v.error : !v.choice);
export type WorkstationResult=z.infer<typeof workstationResultSchema>;
export function readWorkstationResult(stdout:string|undefined,result:unknown):WorkstationResult|null {
  try { const value=stdout!==undefined ? JSON.parse(stdout) : result;
    const parsed=workstationResultSchema.safeParse(value); return parsed.success ? parsed.data : null;
  } catch { return null; }
}
```

Insert `'caller_verify',` beside `notify_user` in `GATED_COMMAND_TYPES`; add `CALLER_VERIFY: 'caller_verify',` to `CommandTypes`. Add `C.CALLER_VERIFY,` to the `LIVE` array in `commandOfflinePolicy.ts:82`; the registry otherwise defaults new known commands to seven-day queueable standard policy. This makes it explicitly non-queueable: it is a short interactive challenge with `deliverBy`, not work to release days later. No lifecycle or probation bypass.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationProtocol.test.ts src/services/partnerTrust.commands.test.ts src/services/commandOfflinePolicy.test.ts`. Expected: pass.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/workstationProtocol.ts apps/api/src/services/callerVerification/workstationProtocol.test.ts apps/api/src/services/partnerTrust.ts apps/api/src/services/commandTypes.ts apps/api/src/services/commandOfflinePolicy.ts
git commit -m "feat(caller-verification): validate workstation wire protocol and trust inventory"
```

### Task 9: Prepare the command inside W01's transaction and dispatch after commit

**Files:** Create `apps/api/src/services/callerVerification/deliverers/workstation.ts`, `apps/api/src/services/callerVerification/deliverers/workstation.test.ts`. Modify W01 `apps/api/src/services/callerVerification/ports.ts` at `callerVerificationPorts.prepare`, `.deliver`, `.available` (planned in W01 Task 5, source not yet implemented). W01 `apps/api/src/services/callerVerification/service.ts:start` already calls `ports.prepare(row!, token)` inside the ambient transaction; reuse it. Reference `apps/api/src/db/schema/devices.ts:545`; `apps/api/src/routes/devices/actuateElevation.ts:259`; `apps/api/src/services/commandDispatch.ts:9,85`; `apps/api/src/services/agentCommandRelay.ts:204`.

**Interfaces:** Consumes the unchanged index signature `export async function start(actor: CallerVerificationActor, input: StartInput): Promise<VerificationView>;` and W01 delivery outbox. Produces:

```ts
export type WorkstationPreparation = { verificationId:string; orgId:string; deviceId:string; createdBy:string; expiresAt:Date; payload:z.infer<typeof workstationCommandSchema> };
export async function prepareWorkstationCommand(tx:Tx, input:WorkstationPreparation):Promise<string>;
export async function deliverWorkstation(verificationId:string):Promise<void>;
```

- [ ] **Step 1: Write a preparation test with separate insert/update chains.**

```ts
import { expect, it, vi } from 'vitest';
import { prepareWorkstationCommand } from './workstation';
import { deviceCommands } from '../../../db/schema';
import { callerVerifications } from '../../../db/schema/callerVerification';
it('writes command ownership and link on the supplied transaction only',async()=>{
  const values=vi.fn(()=>({returning:async()=>[{id:'22222222-2222-4222-8222-222222222222'}]}));
  const where=vi.fn(()=>({returning:async()=>[{id:'11111111-1111-4111-8111-111111111111'}]}));
  const tx={insert:vi.fn(()=>({values})),update:vi.fn(()=>({set:vi.fn(()=>({where}))}))};
  const payload={verificationId:'11111111-1111-4111-8111-111111111111',username:'alex',technicianName:'Sam',orgName:'Acme',actionLabel:'reset the password',targetLabel:'alex@example.com',reverseCode:'7319',choices:['42','17','86'] as [string,string,string],timeoutMs:120000};
  await prepareWorkstationCommand(tx as never,{verificationId:payload.verificationId,orgId:'o',deviceId:'d',createdBy:'u',expiresAt:new Date(),payload});
  expect(tx.insert).toHaveBeenCalledWith(deviceCommands); expect(tx.update).toHaveBeenCalledWith(callerVerifications);
  expect(values).toHaveBeenCalledWith(expect.objectContaining({type:'caller_verify',status:'pending',submittedOrgId:'o'}));
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/deliverers/workstation.test.ts`. Expected: missing deliverer.
- [ ] **Step 3: Implement the transaction seam and after-commit delivery.** No second command is created on outbox retry.

```ts
import { and, eq, gt } from 'drizzle-orm';
import type { z } from 'zod';
import { db, assertInTransaction, runOutsideDbContext, withSystemDbAccessContext } from '../../../db';
import { deviceCommands, devices, organizations } from '../../../db/schema';
import { callerVerifications } from '../../../db/schema/callerVerification';
import { dispatchCommandToAgent } from '../../agentCommandRelay';
import { claimPendingCommandForDelivery, releaseClaimedCommandDelivery } from '../../commandDispatch';
import { assertDeviceExecuteAllowed } from '../../partnerTrust.commands';
import { workstationCommandSchema } from '../workstationProtocol';
import { isCallerVerificationEnabled } from '../gate';
import { workstationUserAvailable } from '../workstationCapabilities';
import { CallerVerificationValidationError } from '../errors';
import type { VerificationRow } from '../types';
import { randomInt } from 'node:crypto';
type Tx=typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];
export type WorkstationPreparation={verificationId:string;orgId:string;deviceId:string;createdBy:string;expiresAt:Date;payload:z.infer<typeof workstationCommandSchema>};
export async function prepareWorkstationCommand(tx:Tx,input:WorkstationPreparation):Promise<string> {
  const payload=workstationCommandSchema.parse(input.payload);
  if(payload.verificationId!==input.verificationId)throw new Error('verification id mismatch');
  const [command]=await tx.insert(deviceCommands).values({deviceId:input.deviceId,type:'caller_verify',targetRole:'agent',status:'pending',createdBy:input.createdBy,submittedOrgId:input.orgId,deliverBy:input.expiresAt,payload}).returning();
  if(!command)throw new Error('caller command insert returned no row');
  const linked=await tx.update(callerVerifications).set({agentCommandId:command.id}).where(and(eq(callerVerifications.id,input.verificationId),eq(callerVerifications.orgId,input.orgId),eq(callerVerifications.status,'pending'))).returning({id:callerVerifications.id});
  if(linked.length!==1)throw new Error('caller verification link failed');
  return command.id;
}
const system=<T>(fn:()=>Promise<T>)=>runOutsideDbContext(()=>withSystemDbAccessContext(fn,'callerVerification.deliverWorkstation'));
export async function deliverWorkstation(verificationId:string):Promise<void> {
  if(!isCallerVerificationEnabled())return;
  const row=await system(async()=>{
    const [row]=await db.select({verification:callerVerifications,command:deviceCommands,device:devices}).from(callerVerifications)
      .innerJoin(deviceCommands,eq(deviceCommands.id,callerVerifications.agentCommandId))
      .innerJoin(devices,and(eq(devices.id,deviceCommands.deviceId),eq(devices.orgId,callerVerifications.orgId)))
      .where(and(eq(callerVerifications.id,verificationId),eq(callerVerifications.method,'workstation'),eq(callerVerifications.status,'pending'),gt(callerVerifications.expiresAt,new Date()))).limit(1);
    if(row)await assertDeviceExecuteAllowed(row.device.id,'caller_verify',row.verification.initiatedByUserId);
    return row;
  });
  if(!row)return;
  const payload=workstationCommandSchema.parse(row.command.payload);
  const claim=await system(()=>claimPendingCommandForDelivery(row.command.id));
  if(!claim)return; // HTTP polling or an earlier outbox attempt already claimed it.
  const outcome=await dispatchCommandToAgent(row.device.agentId,{id:row.command.id,type:'caller_verify',payload});
  if(outcome.status!=='sent') {
    await system(()=>releaseClaimedCommandDelivery(row.command.id,claim.executedAt));
    if(outcome.status==='infrastructure_error')throw new Error(outcome.message);
    // A live HTTP-polling agent may still claim pending before deliverBy.
  }
}
```

The W01 plan became available during authoring. Its concrete transaction/outbox seam is `ports.ts` (`CallerVerificationPorts.prepare(row: VerificationRow, token: string | null): Promise<void>`, `deliver(id: string): Promise<void>`, `available(method: 'workstation' | 'sms' | 'email', orgId: string, deviceId?: string): Promise<boolean>`), and its durable marker is `deliveryPublishedAt`. Preserve those internal signatures as well as the index. Add this adapter in the same deliverer file:

```ts
export async function prepareWorkstationVerification(row:VerificationRow):Promise<void> {
  assertInTransaction('prepareWorkstationVerification');
  if(!row.workstationDeviceRef || !row.osUsername)throw new CallerVerificationValidationError('device_required','Workstation requires device and username');
  const [device]=await db.select().from(devices).where(and(eq(devices.id,row.workstationDeviceRef),eq(devices.orgId,row.orgId),eq(devices.status,'online'))).limit(1);
  if(!device)throw new CallerVerificationValidationError('not_found','Device not found');
  if(!await workstationUserAvailable(row.orgId,device.id,row.osUsername))throw new CallerVerificationValidationError('helper_outdated','No compatible console helper');
  await assertDeviceExecuteAllowed(device.id,'caller_verify',row.initiatedByUserId);
  const [org]=await db.select({name:organizations.name}).from(organizations).where(eq(organizations.id,row.orgId)).limit(1);
  if(!org)throw new CallerVerificationValidationError('not_found','Organization not found');
  const choices=[row.matchValue,...row.decoyValues] as [string,string,string];
  for(let i=2;i>0;i--){const j=randomInt(i+1);[choices[i],choices[j]]=[choices[j]!,choices[i]!];}
  await prepareWorkstationCommand(db,{verificationId:row.id,orgId:row.orgId,deviceId:device.id,createdBy:row.initiatedByUserId,expiresAt:row.expiresAt,
    payload:{verificationId:row.id,username:row.osUsername,technicianName:row.technicianLabel,orgName:org.name,
      actionLabel:row.actionScope==='reset_password'?'reset the password':row.actionScope==='disable_user'?'disable the account':'confirm the support request',
      targetLabel:row.targetLabel ?? row.osUsername,reverseCode:row.reverseCode,choices,
      timeoutMs:Math.max(30000,Math.min(300000,row.expiresAt.getTime()-row.createdAt.getTime()))}});
}
```

In W01's `ports.ts`, replace only the workstation branches in its three defaults; keep W03's link branches when merging parallel work. New imports are `db`, `eq`, and `callerVerifications`. The complete W02 bodies are:

```ts
available:async(method,orgId,deviceId)=>{
  if(method!=='workstation')return false;
  const {workstationDeviceAvailable}=await import('./workstationCapabilities');
  return workstationDeviceAvailable(orgId,deviceId);
},
prepare:async(row,_token)=>{
  if(row.method!=='workstation')throw new Invalid('method_disabled','Delivery adapter is unavailable');
  const {prepareWorkstationVerification}=await import('./deliverers/workstation');
  await prepareWorkstationVerification(row);
},
deliver:async(id)=>{
  const [row]=await db.select({method:callerVerifications.method}).from(callerVerifications).where(eq(callerVerifications.id,id)).limit(1);
  if(!row || row.method!=='workstation')throw new Invalid('method_disabled','Delivery adapter is unavailable');
  const {deliverWorkstation}=await import('./deliverers/workstation');
  await deliverWorkstation(id);
},
```

For `deliver`, the method lookup must execute in a short labeled system context and **finish before** calling `deliverWorkstation`; W01's publisher must not wrap the network callback in its marking transaction. Use `await runOutsideDbContext(()=>withSystemDbAccessContext(()=>db.select({method:callerVerifications.method}).from(callerVerifications).where(eq(callerVerifications.id,id)).limit(1),'callerVerification.deliveryMethod'))` for that lookup. W01's outbox publisher marks `deliveryPublishedAt` only after this callback returns; retries always reuse the existing command. This durable verification-row outbox also works for starts without a ticket.

Add the following to `workstationCapabilities.ts` (imports `db`, `devices`, `and`, `eq`); org/site preview filtering remains Task 13's responsibility:

```ts
export async function workstationDeviceAvailable(orgId:string,deviceId?:string):Promise<boolean> {
  const rows=await db.select({id:devices.id,lastUser:devices.lastUser}).from(devices).where(and(eq(devices.orgId,orgId),eq(devices.status,'online'),deviceId?eq(devices.id,deviceId):undefined));
  for(const row of rows)if(row.lastUser && await workstationUserAvailable(orgId,row.id,row.lastUser))return true;
  return false;
}
```

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/callerVerification/deliverers/workstation.test.ts src/services/agentCommandRelay.test.ts src/services/commandDispatch.test.ts`. Expected: pass; Task 15 proves real rollback, which a mocked tx cannot prove.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/deliverers/workstation.ts apps/api/src/services/callerVerification/deliverers/workstation.test.ts apps/api/src/services/callerVerification/ports.ts apps/api/src/services/callerVerification/workstationCapabilities.ts
git commit -m "feat(caller-verification): persist workstation commands before outbox delivery"
```

### Task 10: Apply both transports through one idempotent decision handler

**Files:** Create `apps/api/src/services/callerVerification/workstationResult.ts`, `apps/api/src/services/callerVerification/workstationResult.test.ts`; modify `apps/api/src/services/commandResultHandlers.ts:842`; create `apps/api/src/services/commandResultHandlers.callerVerify.test.ts`. Modify W01 `apps/api/src/services/callerVerification/service.ts` at `applyDecision` (W01 plan Task 13) to preserve the ambient result transaction; `apps/api/src/services/callerVerification/subjects.ts` owns `observeLogin` (absent on this base).

**Interfaces:** Consumes verbatim:

```ts
export async function applyDecision(input: { verificationId: string; decision: { kind: 'choice'; value: string } | { kind: 'not_me' } | { kind: 'timeout' } | { kind: 'undeliverable'; reason: string }; principal?: { osPrincipal: string; osUsername: string; upn: string | null }; fromIp?: string }): Promise<VerificationView>;
export async function observeLogin(input: { orgId: string; contactId: string; osPrincipal: string; osUsername: string; upn: string | null }): Promise<void>;
```

Produces `handleCallerVerifyResult(params: Parameters<CommandResultHandler>[0]): Promise<void>` in the leaf module and registers that same function in the shared registry. Type-only registry import prevents loading WS code into the worker.

- [ ] **Step 1: Write decision/principal tests.**

```ts
import { expect, it } from 'vitest';
import { decisionForResult, principalForResult } from './workstationResult';
it.each([
  [{delivered:false,error:'no_session_for_user'},{kind:'undeliverable',reason:'no_session_for_user'}],
  [{delivered:false,error:'helper_outdated'},{kind:'undeliverable',reason:'helper_outdated'}],
  [{delivered:true,choice:'timeout'},{kind:'timeout'}],
  [{delivered:true,choice:'not_me'},{kind:'not_me'}],
  [{delivered:true,choice:'42'},{kind:'choice',value:'42'}],
] as const)('maps %j',(value,want)=>expect(decisionForResult(value)).toEqual(want));
it('uses persisted hostname to namespace Unix uid and preserves UID zero',()=>{
  expect(principalForResult({delivered:true,principal:{uid:0,username:'root'}},'host')).toEqual({osPrincipal:'uid:0@host',osUsername:'root',upn:null});
  expect(principalForResult({delivered:true,principal:{sid:'S-1-5-21-1',username:'ACME\\alex',upn:'alex@example.com'}},'host')?.osPrincipal).toBe('S-1-5-21-1');
});
```

Registry test follows `commandResultHandlers.test.ts:1` hoisted mock pattern:

```ts
import { expect, it, vi } from 'vitest';
const handle=vi.hoisted(()=>vi.fn().mockResolvedValue(undefined));
vi.mock('./callerVerification/workstationResult',()=>({handleCallerVerifyResult:handle}));
import { commandResultHandlers } from './commandResultHandlers';
it('passes transport-authorized ids unchanged',async()=>{
  const params={agentId:'agent',commandId:'22222222-2222-4222-8222-222222222222',resolvedDeviceId:'33333333-3333-4333-8333-333333333333',command:{id:'22222222-2222-4222-8222-222222222222'} as never,result:{status:'completed' as const},stdout:'{"delivered":true,"choice":"not_me"}'};
  await commandResultHandlers.caller_verify!(params); expect(handle).toHaveBeenCalledWith(params);
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationResult.test.ts src/services/commandResultHandlers.callerVerify.test.ts`. Expected: missing exports/registry entry.
- [ ] **Step 3: Implement using the command's persisted ownership, never payload verification id.**

```ts
import { and, eq, sql } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { deviceCommands, devices } from '../../db/schema';
import { callerVerifications } from '../../db/schema/callerVerification';
import type { CommandResultHandler } from '../commandResultHandlers';
import { applyDecision } from './service';
import { observeLogin } from './subjects';
import { readWorkstationResult, type WorkstationResult } from './workstationProtocol';
export function decisionForResult(value:WorkstationResult|null):Parameters<typeof applyDecision>[0]['decision'] {
  if(!value)return {kind:'undeliverable',reason:'invalid_result'};
  if(value.choice==='not_me')return {kind:'not_me'};
  if(!value.delivered)return {kind:'undeliverable',reason:value.error ?? 'helper_outdated'};
  if(!value.choice || value.choice==='timeout')return {kind:'timeout'};
  return {kind:'choice',value:value.choice};
}
export function principalForResult(value:WorkstationResult|null,hostname:string|null):Parameters<typeof applyDecision>[0]['principal'] {
  const p=value?.principal;if(!p)return undefined;
  const osPrincipal=p.sid ?? (p.uid!==undefined && hostname ? `uid:${p.uid}@${hostname}` : undefined);
  return osPrincipal ? {osPrincipal,osUsername:p.username,upn:p.upn || null} : undefined;
}
export async function handleCallerVerifyResult({commandId,resolvedDeviceId,result,stdout}:Parameters<CommandResultHandler>[0]):Promise<void> {
  await withSystemDbAccessContext(async()=>{
  const [owned]=await db.select({verification:callerVerifications}).from(callerVerifications)
    .innerJoin(deviceCommands,and(eq(deviceCommands.id,callerVerifications.agentCommandId),eq(deviceCommands.deviceId,resolvedDeviceId),eq(deviceCommands.type,'caller_verify'),eq(deviceCommands.targetRole,'agent')))
    .innerJoin(devices,and(eq(devices.id,resolvedDeviceId),eq(devices.orgId,callerVerifications.orgId)))
    .where(and(eq(callerVerifications.agentCommandId,commandId),eq(callerVerifications.method,'workstation'))).limit(1).for('share',{of:devices});
  if(!owned)return;
  const row=owned.verification;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${row.orgId}`}))`);
  const value=readWorkstationResult(stdout,result.result);
  const decision=decisionForResult(value);
  const principal=principalForResult(value,row.deviceHostname);
  // W01 serializes the status transition and outbox effects. Calling twice is safe.
  const view=await applyDecision({verificationId:row.id,decision,principal});
  if(view.status==='verified' && decision.kind==='choice' && principal && value?.choice===row.matchValue) {
    await observeLogin({orgId:row.orgId,contactId:row.contactId,...principal});
  }
  },'callerVerification.commandResult');
}
```

Register `caller_verify: handleCallerVerifyResult` after importing it in `commandResultHandlers.ts`. Both `applyDecision` and `observeLogin` run in the ambient result transaction. In W01 Task 13, remove only the outer `runOutsideDbContext` from `applyDecision`: its return becomes `return withSystemDbAccessContext(async()=>{` and its closing line becomes `},'callerVerification.applyDecision');`. The real `db/index.ts` implementation joins **any** ambient transaction; it does not elevate an org context to system.

**Parallel W03 merge rule:** W03 Task 6 replaces that function with a `decide` closure. Retain its expiry predicates, link rejection window, IP handling and reason persistence, but replace its final system-only test and detached fallback with these exact lines (the `getCurrentDbAccessContext` import is already required by W03):

```ts
  if (getCurrentDbAccessContext()) return decide();
  return withSystemDbAccessContext(decide, 'callerVerification.applyDecision');
```

An authorized org/partner context must never be discarded merely because it is not system-scoped. A row invisible to that context remains `not_found`; no privilege escalation fallback. Task 15's observation-failure test writes the command receipt and calls the real decision handler inside an authenticated org transaction, then proves receipt, decision and audit all roll back; repeat it after W03 lands. This is the acceptance condition for resolving the shared `service.ts` hunk.

W01's `observeLogin` keeps its index signature and does not invent an Entra identity. Task 16 adds an independent login consumer and tightens its uniqueness check. `applyDecision` owns expiry-aware number CAS and rejects after expiry; `not_me` remains legal from every non-rejected state. No W02 direct status UPDATE duplicates those rules.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationResult.test.ts src/services/commandResultHandlers.callerVerify.test.ts src/services/callerVerification/service.test.ts src/services/callerVerification/subjects.test.ts`. Expected: pass; W01 suites retain the same signatures.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/workstationResult.ts apps/api/src/services/callerVerification/workstationResult.test.ts apps/api/src/services/commandResultHandlers.ts apps/api/src/services/commandResultHandlers.callerVerify.test.ts apps/api/src/services/callerVerification/service.ts
git commit -m "feat(caller-verification): apply workstation results through shared handler"
```

### Task 11: Preserve late rejection before either transport discards a terminal result

**Files:** Modify `apps/api/src/routes/agents/commands.ts:91,400`; `apps/api/src/routes/agentWs.ts:1887,1924,1978,2107`; extend `apps/api/src/services/callerVerification/workstationResult.ts`, `apps/api/src/services/callerVerification/workstationResult.test.ts`; modify `apps/api/src/routes/agents/commands.test.ts:1288` and `apps/api/src/routes/agentWs.test.ts:1267` at existing authenticated command-result cases.

**Interfaces:** Produces `persistCallerNotMeReceipt(input: {commandId:string;deviceId:string;stdout?:string;result?:unknown}): Promise<boolean>`. Consumes authenticated device/command identity only. A durable marker in **existing** `device_commands.result` records a late rejection without reopening the command or losing its original result.

- [ ] **Step 1: Write a narrow receipt test with no DB call for non-rejection.**

```ts
import { beforeEach, expect, it, vi } from 'vitest';
const update=vi.hoisted(()=>vi.fn());
vi.mock('../../db',()=>({db:{update}}));
import { persistCallerNotMeReceipt } from './workstationResult';
beforeEach(()=>vi.clearAllMocks());
it('never changes a command for a number, timeout or malformed receipt',async()=>{
  for(const choice of ['42','timeout','allow']) {
    expect(await persistCallerNotMeReceipt({commandId:'c',deviceId:'d',result:{delivered:true,choice}})).toBe(false);
  }
  expect(update).not.toHaveBeenCalled();
});
it('stores a rejection receipt even when another result is already terminal',async()=>{
  const returning=vi.fn().mockResolvedValue([{id:'c'}]);
  const where=vi.fn(()=>({returning})); update.mockReturnValue({set:()=>({where})});
  expect(await persistCallerNotMeReceipt({commandId:'c',deviceId:'d',result:{delivered:true,choice:'not_me'}})).toBe(true);
  expect(returning).toHaveBeenCalled();
});
```

Keep this mock block in a separate new `workstationReceipt.test.ts` to avoid replacing `db` for Task 10's tests. Add that file to this task's commit.

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationReceipt.test.ts`. Expected: missing function.
- [ ] **Step 3: Add durable receipt storage and transport branches.** Import `sql` into `workstationResult.ts`.

```ts
export async function persistCallerNotMeReceipt(input:{commandId:string;deviceId:string;stdout?:string;result?:unknown}):Promise<boolean> {
  const value=readWorkstationResult(input.stdout,input.result);
  if(value?.choice!=='not_me' || !value.delivered)return false;
  const rows=await db.update(deviceCommands).set({
    result:sql`coalesce(${deviceCommands.result}, '{}'::jsonb) || jsonb_build_object('callerVerificationNotMe', true)`,
  }).where(and(eq(deviceCommands.id,input.commandId),eq(deviceCommands.deviceId,input.deviceId),eq(deviceCommands.targetRole,'agent'),eq(deviceCommands.type,'caller_verify'))).returning({id:deviceCommands.id});
  return rows.length===1;
}
```

HTTP: add `'caller_verify'` to `REGISTRY_DISPATCHED_COMMAND_TYPES` at line 91 (the spec's ~747 is the dispatch site, not the current set declaration). After authenticated command ownership/role checks, **before** `commandAcceptsAgentResult`, insert:

```ts
if(command.type==='caller_verify') {
  const {persistCallerNotMeReceipt,handleCallerVerifyResult}=await import('../../services/callerVerification/workstationResult');
  if(await persistCallerNotMeReceipt({commandId,deviceId:command.deviceId,stdout:data.stdout,result:data.result})) {
    await handleCallerVerifyResult({agentId:agent.agentId ?? agentId,command,commandId,result:data,resolvedDeviceId:command.deviceId,stdout:data.stdout});
    return c.json({success:true});
  }
}
```

This early rejection path intentionally leaves command status unchanged; reconciliation sees the marker and expiry eventually closes pending commands. This exact result route retains the authenticated org context (`agentAuth.ts:926`); the command-poll route is the self-managed exception. Receipt and decision commit together here, and failure rolls both back for HTTP retry. WS below commits the receipt separately because it has no request context.

WS: before its normal lookup filtered by `commandAcceptsAgentResultCondition`, add this narrow rejection branch after UUID validation. The owned join also covers missing socket `deviceId` metadata. Reauthorize before writing; do not bypass containment.

```ts
if((credentialAlreadyReauthorized || await isAgentDeviceStillAuthorized(agentId))) {
  const {readWorkstationResult}=await import('../services/callerVerification/workstationProtocol');
  if(readWorkstationResult(result.stdout,result.result)?.choice==='not_me') {
    const [owned]=await runOutsideDbContext(()=>withSystemDbAccessContext(()=>db.select({command:deviceCommands,deviceId:devices.id}).from(deviceCommands)
      .innerJoin(devices,eq(devices.id,deviceCommands.deviceId))
      .where(and(eq(deviceCommands.id,result.commandId),eq(devices.agentId,agentId),eq(deviceCommands.type,'caller_verify'),eq(deviceCommands.targetRole,'agent'))).limit(1),'callerVerification.wsOwnedCommand'));
    if(owned) {
      const {persistCallerNotMeReceipt,handleCallerVerifyResult}=await import('../services/callerVerification/workstationResult');
      const receipt=await runOutsideDbContext(()=>withSystemDbAccessContext(()=>persistCallerNotMeReceipt({commandId:result.commandId,deviceId:owned.deviceId,stdout:result.stdout,result:result.result}),'callerVerification.wsReceipt'));
      if(receipt) {
        await runWithAgentOrgDbAccess('callerVerification.wsDecision',orgId,partnerId,()=>handleCallerVerifyResult({agentId,command:owned.command,commandId:result.commandId,result,resolvedDeviceId:owned.deviceId,stdout:result.stdout}));
        return;
      }
    }
  }
}
```

Keep receipt persistence in its own committed short context before applying the decision: if the second stage throws, Task 12 recovers it. For ordinary first results, preserve a concurrent durable marker in both transports' existing terminal write:

```ts
result: sql`${JSON.stringify(storedCommandResult)}::jsonb ||
  CASE WHEN ${deviceCommands.result}->>'callerVerificationNotMe' = 'true'
  THEN '{"callerVerificationNotMe":true}'::jsonb ELSE '{}'::jsonb END`,
```

Use WS local variable `storedResult` there instead of HTTP's `storedCommandResult`; apply this expression only for `command.type==='caller_verify'`, leaving backup ack logic unchanged. Never broaden the shared acceptance predicate for all commands.

Add these tests inside the existing command-result describes. Add a hoisted `callerReceipt`/`callerDecision` mock pair in each suite, with its module path relative to that suite, and clear both in its existing `beforeEach`. These names are new test doubles; all harness names below already exist.

```ts
// commands.test.ts top-level:
const callerReceipt=vi.hoisted(()=>vi.fn());const callerDecision=vi.hoisted(()=>vi.fn());
vi.mock('../../services/callerVerification/workstationResult',()=>({persistCallerNotMeReceipt:callerReceipt,handleCallerVerifyResult:callerDecision}));
// Inside its existing result-route describe:
it.each(['completed','failed','cancelled'])('honors late caller rejection after %s',async status=>{
  callerReceipt.mockResolvedValue(true);callerDecision.mockResolvedValue(undefined);
  selectMock.mockReturnValueOnce(chainMock([{id:commandId,deviceId:'device-1',type:'caller_verify',targetRole:'agent',status}]));
  const response=await app.request(`/agents/${agentId}/commands/${commandId}/result`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'completed',result:{delivered:true,choice:'not_me'}})});
  expect(response.status).toBe(200);expect(callerReceipt).toHaveBeenCalledWith(expect.objectContaining({commandId,deviceId:'device-1'}));
  expect(callerDecision).toHaveBeenCalledWith(expect.objectContaining({commandId,resolvedDeviceId:'device-1'}));
});
it('rejects a foreign command before recording a caller receipt',async()=>{
  callerReceipt.mockClear();callerDecision.mockClear();selectMock.mockReturnValueOnce(chainMock([]));
  const response=await app.request(`/agents/${agentId}/commands/${commandId}/result`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:'completed',result:{delivered:true,choice:'not_me'}})});
  expect(response.status).toBe(404);expect(callerReceipt).not.toHaveBeenCalled();expect(callerDecision).not.toHaveBeenCalled();
});
```

```ts
// agentWs.test.ts top-level; add `type: 'deviceCommands.type'` to its schema mock:
const callerReceipt=vi.hoisted(()=>vi.fn());const callerDecision=vi.hoisted(()=>vi.fn());
vi.mock('../services/callerVerification/workstationResult',()=>({persistCallerNotMeReceipt:callerReceipt,handleCallerVerifyResult:callerDecision}));
// Inside its existing command-result describe:
it.each(['completed','failed','cancelled'])('honors late caller rejection after %s',async status=>{
  const {handlers,ws}=await connectedAgent('agent-123',{deviceId:'device-123',orgId:'org-123',partnerId:'partner-123'});
  const commandId='11111111-1111-4111-8111-111111111111';
  const command={id:commandId,deviceId:'device-123',type:'caller_verify',targetRole:'agent',status};
  const query:any={};for(const m of ['from','where','innerJoin'])query[m]=vi.fn(()=>query);
  query.limit=vi.fn(async()=>[{status:'online',agentTokenSuspendedAt:null,command,deviceId:'device-123'}]);vi.mocked(db.select).mockReturnValue(query);
  callerReceipt.mockResolvedValue(true);callerDecision.mockResolvedValue(undefined);
  await handlers.onMessage({data:JSON.stringify({type:'command_result',commandId,status:'completed',result:{delivered:true,choice:'not_me'}})} as any,ws as any);
  expect(callerReceipt).toHaveBeenCalledWith(expect.objectContaining({commandId,deviceId:'device-123'}));
  expect(callerDecision).toHaveBeenCalledWith(expect.objectContaining({commandId,command,resolvedDeviceId:'device-123'}));
});
it('never records a caller receipt for another socket device',async()=>{
  const {handlers,ws}=await connectedAgent('agent-123',{deviceId:'device-123',orgId:'org-123',partnerId:'partner-123'});
  callerReceipt.mockClear();callerDecision.mockClear();
  const query:any={};for(const m of ['from','where','innerJoin'])query[m]=vi.fn(()=>query);
  query.limit=vi.fn(async()=>[]);vi.mocked(db.select).mockReturnValue(query);
  await handlers.onMessage({data:JSON.stringify({type:'command_result',commandId:'11111111-1111-4111-8111-111111111111',status:'completed',result:{delivered:true,choice:'not_me'}})} as any,ws as any);
  expect(callerReceipt).not.toHaveBeenCalled();expect(callerDecision).not.toHaveBeenCalled();
});
```

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstationReceipt.test.ts src/routes/agents/commands.test.ts src/routes/agentWs.test.ts`. Expected: all late-status and foreign-device cases pass. Task 15 proves durable recovery with real SQL.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/routes/agents/commands.ts apps/api/src/routes/agents/commands.test.ts apps/api/src/routes/agentWs.ts apps/api/src/routes/agentWs.test.ts apps/api/src/services/callerVerification/workstationResult.ts apps/api/src/services/callerVerification/workstationReceipt.test.ts
git commit -m "fix(caller-verification): retain late not-me results on both transports"
```

### Task 12: Reconcile expiry, terminal results and late rejection

**Files:** Create `apps/api/src/jobs/callerVerificationReconciliation.ts`, `apps/api/src/jobs/callerVerificationReconciliation.test.ts`; modify `apps/api/src/services/workerRegistry.ts:1140`; `apps/api/src/jobs/workerReadinessManifest.ts:155`. Reference `apps/api/src/jobs/aiOperatorTaskWorker.ts:105,121,147,179` and `apps/api/src/jobs/scheduleRegistry.ts:45`.

**Interfaces:** Produces `reconcileCallerVerifications(): Promise<void>`, `initializeCallerVerificationReconciliation(): Promise<void>`, `shutdownCallerVerificationReconciliation(): Promise<void>`. Consumes the exact same leaf `handleCallerVerifyResult` as the registry; no duplicate decision implementation.

- [ ] **Step 1: Write reconciliation classification tests.**

```ts
import { expect, it } from 'vitest';
import { reconciliationAction } from './callerVerificationReconciliation';
it.each(['pending','verified','wrong_choice','expired','revoked','cancelled','undeliverable'])('replays not-me from %s',status=>{
  expect(reconciliationAction(status,true,true,true)).toBe('result');
});
it('distinguishes expiry from replay and stops rejected rows',()=>{
  expect(reconciliationAction('pending',true,false,false)).toBe('expire');
  expect(reconciliationAction('pending',true,true,false)).toBe('result');
  expect(reconciliationAction('verified',true,true,false)).toBe('skip');
  expect(reconciliationAction('rejected_by_user',true,true,true)).toBe('skip');
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/jobs/callerVerificationReconciliation.test.ts`. Expected: missing module.
- [ ] **Step 3: Implement bounded keyset reconciliation and lifecycle.** Import `Queue,Worker` from BullMQ, `and,eq,gt,ne,or,sql` from Drizzle, DB context helpers, caller tables, `deviceCommands`, `applyDecision`, `handleCallerVerifyResult`, `readWorkstationResult`, `getBullMQConnection`, `captureException`, `attachWorkerObservability` from their verified modules.

```ts
export function reconciliationAction(status:string,expired:boolean,terminal:boolean,notMe:boolean) {
  if(status==='rejected_by_user')return 'skip';
  if(notMe)return 'result';
  if(status!=='pending')return 'skip';
  return terminal?'result':expired?'expire':'skip';
}
const system=<T>(fn:()=>Promise<T>)=>runOutsideDbContext(()=>withSystemDbAccessContext(fn,'callerVerification.reconcile'));
export async function reconcileCallerVerifications():Promise<void> {
  let cursor:string|undefined;
  for(;;) {
    const rows=await system(()=>db.select({v:callerVerifications,c:deviceCommands}).from(callerVerifications)
      .leftJoin(deviceCommands,eq(deviceCommands.id,callerVerifications.agentCommandId))
      .where(and(eq(callerVerifications.method,'workstation'),ne(callerVerifications.status,'rejected_by_user'),
        or(eq(callerVerifications.status,'pending'),sql`${deviceCommands.result}->>'callerVerificationNotMe' = 'true'`,
          sql`${deviceCommands.result}->'result'->>'choice' = 'not_me'`,sql`${deviceCommands.result}->>'stdout' like '%not_me%'`),
        cursor?gt(callerVerifications.id,cursor):undefined)).orderBy(callerVerifications.id).limit(100));
    if(!rows.length)break;
    for(const {v,c} of rows) {
      try {
        const stored=(c?.result ?? {}) as {status?:string;stdout?:string;result?:unknown;callerVerificationNotMe?:boolean};
        const parsed=readWorkstationResult(stored.stdout,stored.result);
        const notMe=stored.callerVerificationNotMe===true || parsed?.choice==='not_me';
        const terminal=!!c && !['pending','sent'].includes(c.status);
        const action=reconciliationAction(v.status,v.expiresAt<=new Date(),terminal,notMe);
        await system(async()=>{
          if(action==='expire')await applyDecision({verificationId:v.id,decision:{kind:'timeout'}});
          if(action==='result' && c)await handleCallerVerifyResult({agentId:'reconciler',command:c,commandId:c.id,resolvedDeviceId:c.deviceId,
            result:{status:c.status==='completed'?'completed':'failed',result:notMe?{delivered:true,choice:'not_me'}:stored.result},
            stdout:notMe?undefined:stored.stdout});
        });
      } catch(error) {captureException(error instanceof Error?error:new Error(String(error)),undefined,{verificationId:v.id});}
    }
    cursor=rows[rows.length-1]!.v.id;
  }
}
let queue:Queue|null=null;let worker:Worker|null=null;
export async function initializeCallerVerificationReconciliation():Promise<void> {
  if(worker)return;
  queue=new Queue('caller-verification-reconciliation',{connection:getBullMQConnection()});
  worker=new Worker('caller-verification-reconciliation',()=>reconcileCallerVerifications(),{connection:getBullMQConnection(),concurrency:1});
  attachWorkerObservability(worker,'callerVerificationReconciliation');
  worker.on('error',error=>captureException(error));worker.on('failed',(_job,error)=>captureException(error));
  try {
    for(const job of await queue.getRepeatableJobs())if(job.name==='reconcile')await queue.removeRepeatableByKey(job.key);
    await queue.add('reconcile',{}, {jobId:'caller-verification-reconcile',repeat:{every:30000},removeOnComplete:{count:20},removeOnFail:{count:200}});
  } catch(error) {await shutdownCallerVerificationReconciliation();throw error;}
}
export async function shutdownCallerVerificationReconciliation():Promise<void> {
  const w=worker,q=queue;worker=null;queue=null;await w?.close();await q?.close();
}
```

The marker branch intentionally includes nonterminal command rows: Task 11 may receive an early rejection before a terminal status update. Ordinary replay processes terminal commands before considering expiry, but W01 still rejects a number received past `expiresAt`. There is no 24-hour cutoff for agent rejection; the spec's public-token 24-hour limit belongs to W03 only. Missing/deleted commands expire pending verification rows. Each DB operation has a short context, not a transaction spanning the fleet loop.

Register `{ name:'callerVerificationReconciliation', placement:'global', load:async()=>{const m=await import('../jobs/callerVerificationReconciliation');return {init:m.initializeCallerVerificationReconciliation,shutdown:m.shutdownCallerVerificationReconciliation};} }` in the worker registry; add `consumers('callerVerificationReconciliation')` to readiness manifest. The 30-second repeat is exempt from the coarse schedule registry; never use epoch-aligned `every:86400000`.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/jobs/callerVerificationReconciliation.test.ts src/jobs/workerReadinessCoverage.test.ts src/jobs/scheduleRegistry.contract.test.ts`. Expected: pass. Also run the existing worker entrypoint closure suite named in Task 18; no runtime import of `commandResultHandlers` is permitted in this leaf worker.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/jobs/callerVerificationReconciliation.ts apps/api/src/jobs/callerVerificationReconciliation.test.ts apps/api/src/services/workerRegistry.ts apps/api/src/jobs/workerReadinessManifest.ts
git commit -m "fix(caller-verification): reconcile expired and missed workstation decisions"
```

### Task 13: Suggest reachable online devices and expose per-device readiness

**Files:** Create `apps/api/src/services/callerVerification/deviceSuggestions.ts`, `apps/api/src/services/callerVerification/deviceSuggestions.test.ts`; modify W01 `apps/api/src/services/callerVerification/service.ts` at `methodsForContact`. Reference `apps/api/src/db/schema/devices.ts:15,16,82,122`, `apps/api/src/services/contacts/crud.ts:364`, W01 `apps/api/src/services/callerVerification/subjects.ts:bindingsForContact` (new dependency, not on this base).

**Interfaces:** Preserve verbatim `export async function methodsForContact(actor: CallerVerificationActor, orgId: string, contactId: string, actionScope: CallerVerificationActionScope): Promise<MethodAvailability[]>;`. Produce `deviceSuggestions(actor:CallerVerificationActor,orgId:string,contactId:string):Promise<DeviceSuggestion[]>`, with `DeviceSuggestion={deviceId:string;hostname:string;username:string;hasBinding:boolean;available:boolean;unavailableReason?:'helper_outdated'}`. Do not add a `deviceId` argument to `methodsForContact` or change `MethodAvailability`.

- [ ] **Step 1: Write matching tests.**

```ts
import { expect, it } from 'vitest';
import { matchSuggestedUsername } from './deviceSuggestions';
it('returns the actual last-user spelling and treats binding as a hint',()=>{
  expect(matchSuggestedUsername('ACME\\Alex',['acme\\alex'],['ACME\\Alex'])).toEqual({username:'ACME\\Alex',hasBinding:true});
  expect(matchSuggestedUsername('alex@example.com',['alex@example.com'],[])).toEqual({username:'alex@example.com',hasBinding:false});
  expect(matchSuggestedUsername('different',['alex'],['alex'])).toBeNull();
  expect(matchSuggestedUsername(null,['alex'],[])).toBeNull();
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/deviceSuggestions.test.ts`. Expected: missing module.
- [ ] **Step 3: Implement site-scoped suggestions.** A display-name or email match is only a hint; start still requires explicit user confirmation and the agent performs authoritative resolution.

```ts
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db';
import { devices } from '../../db/schema';
import { getContact } from '../contacts/crud';
import { bindingsForContact } from './subjects';
import { workstationUserAvailable } from './workstationCapabilities';
import { CallerVerificationValidationError } from './errors';
import type { CallerVerificationActor } from './types';
export type DeviceSuggestion={deviceId:string;hostname:string;username:string;hasBinding:boolean;available:boolean;unavailableReason?:'helper_outdated'};
export function matchSuggestedUsername(lastUser:string|null,candidates:string[],bound:string[]) {
  if(!lastUser)return null;const name=lastUser.trim().toLowerCase();
  if(!candidates.some(v=>v.trim().toLowerCase()===name))return null;
  return {username:lastUser,hasBinding:bound.some(v=>v.trim().toLowerCase()===name)};
}
export async function deviceSuggestions(actor:CallerVerificationActor,orgId:string,contactId:string):Promise<DeviceSuggestion[]> {
  if(actor.accessibleOrgIds!==null && !actor.accessibleOrgIds.includes(orgId))throw new CallerVerificationValidationError('not_found','Contact not found');
  const contact=await getContact(db,contactId,orgId);
  if(!contact || (contact.siteId!==null && actor.allowedSiteIds!==null && !actor.allowedSiteIds.includes(contact.siteId)))throw new CallerVerificationValidationError('not_found','Contact not found');
  if(actor.allowedSiteIds?.length===0)return [];
  const bindings=await bindingsForContact(orgId,contactId);
  const active=bindings.filter(b=>!b.revokedAt);
  const bound=active.flatMap(b=>b.osUsername?[b.osUsername]:[]);
  const candidates=[contact.name,contact.email,...bound,...active.map(b=>b.upnSnapshot)].filter((v):v is string=>!!v);
  if(!candidates.length)return [];
  const normalized=[...new Set(candidates.map(v=>v.trim().toLowerCase()))];
  const rows=await db.select({id:devices.id,hostname:devices.hostname,lastUser:devices.lastUser}).from(devices)
    .where(and(eq(devices.orgId,orgId),eq(devices.status,'online'),
      actor.allowedSiteIds===null?undefined:inArray(devices.siteId,actor.allowedSiteIds),
      inArray(sql<string>`lower(trim(${devices.lastUser}))`,normalized))).orderBy(devices.hostname,devices.id).limit(50);
  const result:DeviceSuggestion[]=[];
  for(const row of rows) {
    const match=matchSuggestedUsername(row.lastUser,candidates,bound);if(!match)continue;
    const available=await workstationUserAvailable(orgId,row.id,match.username);
    result.push({deviceId:row.id,hostname:row.hostname,...match,available,...(!available?{unavailableReason:'helper_outdated' as const}:{})});
  }
  return result;
}
```

An OS-binding username expands candidate matches; it does not associate every org device with the contact. Only a device's reported `lastUser` matching those candidates qualifies. Do not invent a contact-device relation or select every online device when `lastUser` is absent.

In W01 `methodsForContact`, replace its unavailable-workstation branch with this expression, using its existing effective policy `p` and return-array local `rows`, immediately before `return rows`:

```ts
const suggestions=await deviceSuggestions(actor,orgId,contactId);
const anyReady=suggestions.some(d=>d.available);
const workstation=rows.find(m=>m.method==='workstation');
if(workstation && p.allowedMethods.includes('workstation') && (!workstation.unavailableReason || workstation.unavailableReason==='helper_outdated')) {
  workstation.available=anyReady;
  workstation.unavailableReason=anyReady?undefined:'helper_outdated';
}
```

Retain W01's tier calculation and `feature_disabled`/`method_disabled` priorities. `hasBinding` must never independently set tier 3: the answering principal must match the non-revoked binding. API consumers receive per-device `helper_outdated` on this new route, while the fixed methods signature aggregates readiness over visible suggestions. Start rechecks its selected device and username, even when manually selected rather than suggested.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/services/callerVerification/deviceSuggestions.test.ts src/services/callerVerification/service.test.ts`. Expected: pass. Task 15 proves mixed ready/outdated suggestions, aggregate method readiness, selected-device refusal, and sibling-site/cross-org isolation against the real service and database.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/deviceSuggestions.ts apps/api/src/services/callerVerification/deviceSuggestions.test.ts apps/api/src/services/callerVerification/service.ts
git commit -m "feat(caller-verification): suggest reachable devices with helper readiness"
```

### Task 14: Register the authenticated device-suggestions route before `/:id`

**Files:** Create `apps/api/src/routes/callerVerificationWorkstation.ts`, `apps/api/src/routes/callerVerificationWorkstation.test.ts`, and the cross-wave `apps/web/src/lib/api/callerVerification.workstation.test.ts` after W04 Task 1. Modify W01 `apps/api/src/routes/callerVerification.ts` before its `${cv}/:id` registration (W01 plan Task 14). W01 already exports `canReachContactSite` from `apps/api/src/routes/orgContacts.ts:110`; consume it unchanged.

**Interfaces:** `GET /orgs/:orgId/caller-verifications/device-suggestions?contactId=` returns `{data: DeviceSuggestion[]}` including `available` and optional `unavailableReason`. Produces `registerCallerDeviceSuggestionsRoutes(orgRoutes:Hono):void`, consumes route-local `authMiddleware`, `requireScope` and `requirePermission(PERMISSIONS.ORGS_READ.resource,PERMISSIONS.ORGS_READ.action)`. No mutation and no extra MFA gate on this GET.

- [ ] **Step 1: Write functional route tests, not pass-through authorization stubs.**

```ts
import { Hono } from 'hono';
import { beforeEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({enabled:true,loggedIn:true,read:true,org:true,site:true}));
const suggestions=vi.hoisted(()=>vi.fn().mockResolvedValue([]));
vi.mock('../services/callerVerification/deviceSuggestions',()=>({deviceSuggestions:suggestions}));
vi.mock('../services/callerVerification/gate',()=>({isCallerVerificationEnabled:()=>state.enabled}));
vi.mock('../services/contacts/crud',()=>({getContact:async()=>({siteId:'22222222-2222-4222-8222-222222222222'})}));
vi.mock('./orgContacts',()=>({canReachContactSite:(auth:any,site:string|null)=>site===null||auth.canAccessSite(site)}));
vi.mock('../middleware/auth',()=>({
  authMiddleware:async(c:any,next:any)=>{if(!state.loggedIn)return c.json({error:'Unauthorized'},401);c.set('auth',{user:{id:'33333333-3333-4333-8333-333333333333',name:'Sam'},scope:'organization',partnerId:null,accessibleOrgIds:['11111111-1111-4111-8111-111111111111'],allowedSiteIds:[],canAccessOrg:()=>state.org,canAccessSite:()=>state.site});return next();},
  requireScope:()=>async(_c:any,next:any)=>next(),
  requirePermission:()=>async(c:any,next:any)=>state.read?next():c.json({error:'Forbidden'},403),
}));
import { registerCallerDeviceSuggestionsRoutes } from './callerVerificationWorkstation';
const org='11111111-1111-4111-8111-111111111111', contact='33333333-3333-4333-8333-333333333333';
function app(){const a=new Hono();registerCallerDeviceSuggestionsRoutes(a);return a;}
beforeEach(()=>{Object.assign(state,{enabled:true,loggedIn:true,read:true,org:true,site:true});suggestions.mockClear();});
it.each([['loggedIn',401],['enabled',404],['read',403],['org',404],['site',404]] as const)('gates %s',async(key,status)=>{state[key]=false;expect((await app().request(`/orgs/${org}/caller-verifications/device-suggestions?contactId=${contact}`)).status).toBe(status);expect(suggestions).not.toHaveBeenCalled();});
it('validates contact id and returns visible suggestions',async()=>{expect((await app().request(`/orgs/${org}/caller-verifications/device-suggestions?contactId=bad`)).status).toBe(400);expect((await app().request(`/orgs/${org}/caller-verifications/device-suggestions?contactId=${contact}`)).status).toBe(200);});
it('returns the data envelope and preserves mixed per-device readiness',async()=>{
  const rows=[
    {deviceId:'44444444-4444-4444-8444-444444444444',hostname:'ready',username:'alex',hasBinding:false,available:true},
    {deviceId:'55555555-5555-4555-8555-555555555555',hostname:'old',username:'alex',hasBinding:false,available:false,unavailableReason:'helper_outdated'},
  ];
  suggestions.mockResolvedValueOnce(rows);
  const response=await app().request(`/orgs/${org}/caller-verifications/device-suggestions?contactId=${contact}`);
  expect(response.status).toBe(200);expect(await response.json()).toEqual({data:rows});
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/routes/callerVerificationWorkstation.test.ts`. Expected: missing registration export.
- [ ] **Step 3: Implement the new registration module; W01 calls it on its existing router.** Reuse `canReachContactSite` without changing its body.

```ts
import type { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db';
import { authMiddleware, requireScope, requirePermission, type AuthContext } from '../middleware/auth';
import { PERMISSIONS } from '../services/permissions';
import { getContact } from '../services/contacts/crud';
import { canReachContactSite } from './orgContacts';
import { deviceSuggestions } from '../services/callerVerification/deviceSuggestions';
import { isCallerVerificationEnabled } from '../services/callerVerification/gate';
import type { CallerVerificationActor } from '../services/callerVerification/types';
export function registerCallerDeviceSuggestionsRoutes(orgRoutes:Hono):void {
  orgRoutes.get('/orgs/:orgId/caller-verifications/device-suggestions',
    async(c,next)=>isCallerVerificationEnabled()?next():c.json({error:'Not found'},404),
    authMiddleware,requireScope('organization','partner','system'),
    requirePermission(PERMISSIONS.ORGS_READ.resource,PERMISSIONS.ORGS_READ.action),async c=>{
      const parsed=z.object({orgId:z.string().uuid(),contactId:z.string().uuid()}).safeParse({orgId:c.req.param('orgId'),contactId:c.req.query('contactId')});
      if(!parsed.success)return c.json({error:'Invalid request'},400);
      const auth=c.get('auth') as AuthContext;const {orgId,contactId}=parsed.data;
      if(!auth.canAccessOrg(orgId))return c.json({error:'Not found'},404);
      const contact=await getContact(db,contactId,orgId);
      if(!contact || !canReachContactSite(auth,contact.siteId))return c.json({error:'Not found'},404);
      const actor:CallerVerificationActor={userId:auth.user.id,partnerId:auth.partnerId ?? null,scope:auth.scope==='organization'?'organization':'partner',accessibleOrgIds:auth.accessibleOrgIds ?? null,allowedSiteIds:auth.allowedSiteIds ?? null,displayName:auth.user.name ?? auth.user.email};
      return c.json({data:await deviceSuggestions(actor,orgId,contactId)});
    });
}
```

In W01 `routes/callerVerification.ts`, add `import { registerCallerDeviceSuggestionsRoutes } from './callerVerificationWorkstation';` and `registerCallerDeviceSuggestionsRoutes(callerVerificationRoutes);` before the `${cv}/:id` GET. W01 mounts this router at `/` and its routes include `/orgs`; the new handler has its own flag/auth/scope middleware, exactly like W01's `base`. The test therefore uses the complete `/orgs/...` path. Do not add a second root mount.

- [ ] **Step 4: Run** `cd apps/api && npx vitest run src/routes/callerVerificationWorkstation.test.ts src/routes/orgContacts.test.ts`. Expected: 401 unauthenticated, 403 no read permission, 404 flag off/cross-org/sibling-site, 400 malformed UUID, 200 allowed. The methods endpoint and start route must preserve their W01 flags and authorization.
- [ ] **Step 4b: Verify the real response through W04's reader after W04 Task 1 is present.** Create `apps/web/src/lib/api/callerVerification.workstation.test.ts`. This is an explicit cross-wave acceptance test, not a substitute implementation of the client. It mounts W02's real route and calls W04's real `deviceSuggestions`; only authentication, the device query and transport are mocked. W04 owns the additive `DeviceSuggestion` type fields, disabled choices, translated reason and selected-device validation; W02 must preserve the fields on every response, including when another device is ready.

```ts
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
const f=vi.hoisted(()=>({fetch:vi.fn(),suggest:vi.fn()}));
vi.mock('@/stores/auth',()=>({fetchWithAuth:f.fetch}));
vi.mock('@/lib/i18n',()=>({i18n:{t:(key:string)=>key}}));
vi.mock('@/lib/runAction',()=>({ActionError:class extends Error {},runAction:vi.fn()}));
vi.mock('../../../../api/src/db',()=>({db:{}}));
vi.mock('../../../../api/src/services/callerVerification/gate',()=>({isCallerVerificationEnabled:()=>true}));
vi.mock('../../../../api/src/services/callerVerification/deviceSuggestions',()=>({deviceSuggestions:f.suggest}));
vi.mock('../../../../api/src/services/contacts/crud',()=>({getContact:async()=>({siteId:null})}));
vi.mock('../../../../api/src/routes/orgContacts',()=>({canReachContactSite:()=>true}));
vi.mock('../../../../api/src/middleware/auth',()=>({
  authMiddleware:async(c:any,next:any)=>{c.set('auth',{user:{id:'33333333-3333-4333-8333-333333333333',name:'Sam'},scope:'organization',accessibleOrgIds:null,allowedSiteIds:null,canAccessOrg:()=>true});return next();},
  requireScope:()=>async(_c:any,next:any)=>next(),
  requirePermission:()=>async(_c:any,next:any)=>next(),
}));
import { registerCallerDeviceSuggestionsRoutes } from '../../../../api/src/routes/callerVerificationWorkstation';
import { deviceSuggestions } from './callerVerification';
it('reads the real W02 envelope without losing the unavailable device',async()=>{
  const rows=[
    {deviceId:'44444444-4444-4444-8444-444444444444',hostname:'ready',username:'alex',hasBinding:true,available:true},
    {deviceId:'55555555-5555-4555-8555-555555555555',hostname:'old',username:'alex',hasBinding:false,available:false,unavailableReason:'helper_outdated'},
  ];
  f.suggest.mockResolvedValue(rows);
  const app=new Hono();registerCallerDeviceSuggestionsRoutes(app);
  f.fetch.mockImplementation((path:string)=>app.request(path));
  await expect(deviceSuggestions('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222')).resolves.toEqual(rows);
  expect(f.suggest).toHaveBeenCalledOnce();
});
```

Run `cd apps/web && npx vitest run src/lib/api/callerVerification.workstation.test.ts src/lib/api/callerVerification.test.ts`. With W04 absent, record this as pending cross-wave acceptance (do not introduce a fake reader or claim it passed); run it on the combined branch before W05 activation. The API response test above runs independently in W02. Commit this test once W04's module is available with `git add apps/web/src/lib/api/callerVerification.workstation.test.ts && git commit -m "test(caller-verification): read workstation suggestions through web client"`.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/routes/callerVerification.ts apps/api/src/routes/callerVerificationWorkstation.ts apps/api/src/routes/callerVerificationWorkstation.test.ts
git commit -m "feat(caller-verification): expose site-scoped workstation suggestions"
```

### Task 15: Prove transaction/replay behavior against Postgres and document the command

**Files:** Create `apps/api/src/services/callerVerification/workstation.integration.test.ts`; modify `apps/api/vitest.integration.config.ts:12`, `apps/api/vitest.config.ts:15` (exclude); `apps/docs/src/content/docs/agents/commands.mdx:29`. Fixtures use verified `createPartner`, `createOrganization`, `createUser`, `createSite` from `apps/api/src/__tests__/integration/db-utils.ts`, `createContact(exec,input,actor)` from `apps/api/src/services/contacts/crud.ts:467`. No nonexistent `createDevice` fixture is assumed.

**Interfaces:** Consumes W01 `start`, `get`, `applyDecision`, the real DB context and Task 9/10/11 functions. Produces behavioral proof of atomic ownership, observation-failure rollback of decision/receipt/effect, mixed readiness with selected-device refusal, transport duplicates, late rejection and site isolation.

- [ ] **Step 1: Write the co-located integration suite.** Imports are explicit; set readiness before dynamically importing the service because config may be evaluated at module load.

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { devices, deviceCommands, auditLogs } from '../../db/schema';
import { callerVerifications } from '../../db/schema/callerVerification';
import { createPartner, createOrganization, createUser, createSite } from '../../__tests__/integration/db-utils';
import { createContact } from '../contacts/crud';
import { recordWorkstationCapabilities } from './workstationCapabilities';
import { handleCallerVerifyResult, persistCallerNotMeReceipt } from './workstationResult';
import { deviceSuggestions } from './deviceSuggestions';
import { reconcileCallerVerifications } from '../../jobs/callerVerificationReconciliation';
import type { CallerVerificationActor } from './types';
vi.hoisted(()=>{process.env.CALLER_VERIFICATION_ENABLED='true';});
const observationFault=vi.hoisted(()=>({fail:false}));
vi.mock('./subjects',async importOriginal=>{
  const actual=await importOriginal<typeof import('./subjects')>();
  return {...actual,observeLogin:async(input:Parameters<typeof actual.observeLogin>[0])=>{
    await actual.observeLogin(input);
    if(observationFault.fail)throw new Error('observation failed');
  }};
});
import * as service from './service';
async function fixture(){
  const partner=await createPartner();const org=await createOrganization({partnerId:partner.id});
  const user=await createUser({partnerId:partner.id,orgId:null});const site=await createSite({orgId:org.id});
  const actor:CallerVerificationActor={userId:user.id,partnerId:partner.id,scope:'partner',accessibleOrgIds:[org.id],allowedSiteIds:null,displayName:'Sam'};
  const context={scope:'partner' as const,orgId:null,accessibleOrgIds:[org.id],accessiblePartnerIds:[partner.id],userId:user.id};
  const data=await withSystemDbAccessContext(async()=>{
    const contact=await createContact(db,{orgId:org.id,siteId:site.id,name:'alex'}, {userId:user.id});
    const [device]=await db.insert(devices).values({orgId:org.id,siteId:site.id,agentId:randomUUID(),hostname:'test-workstation',osType:'linux',osVersion:'test',architecture:'amd64',agentVersion:'test',lastUser:'alex',status:'online'}).returning();
    return {contact,device:device!};
  });
  await recordWorkstationCapabilities(org.id,data.device.id,{callerVerify:true,usernames:['alex']});
  return {org,site,actor,context,...data};
}
it('rolls back command and verification together, with a committing positive control',async()=>{
  const f=await fixture();let id='';
  const input={orgId:f.org.id,contactId:f.contact.id,method:'workstation' as const,actionScope:'any' as const,deviceId:f.device.id,username:'alex'};
  await expect(withDbAccessContext(f.context,async()=>{const row=await service.start(f.actor,input);id=row.id;
    const rows=await db.select().from(callerVerifications).where(eq(callerVerifications.id,id));expect(rows[0]?.agentCommandId).toBeTruthy();throw new Error('rollback-control');})).rejects.toThrow('rollback-control');
  await withSystemDbAccessContext(async()=>{
    expect(await db.select().from(callerVerifications).where(eq(callerVerifications.id,id))).toHaveLength(0);
    expect(await db.select().from(deviceCommands).where(eq(deviceCommands.deviceId,f.device.id))).toHaveLength(0);
  });
  const view=await withDbAccessContext(f.context,()=>service.start(f.actor,input));
  await withSystemDbAccessContext(async()=>{const [v]=await db.select().from(callerVerifications).where(eq(callerVerifications.id,view.id));expect(v?.agentCommandId).toBeTruthy();});
});
it('rolls back the decision, effect and receipt when login observation fails in an org transaction',async()=>{
  const f=await fixture();
  const view=await withDbAccessContext(f.context,()=>service.start(f.actor,{orgId:f.org.id,contactId:f.contact.id,method:'workstation',actionScope:'any',deviceId:f.device.id,username:'alex'}));
  const orgContext={scope:'organization' as const,orgId:f.org.id,accessibleOrgIds:[f.org.id],accessiblePartnerIds:[],userId:f.actor.userId};
  const [v]=await withDbAccessContext(orgContext,()=>db.select().from(callerVerifications).where(eq(callerVerifications.id,view.id)));
  const [command]=await withDbAccessContext(orgContext,()=>db.select().from(deviceCommands).where(eq(deviceCommands.id,v!.agentCommandId!)));
  const stdout=JSON.stringify({delivered:true,choice:v!.matchValue,principal:{uid:501,username:'alex'}});
  const receive=()=>withDbAccessContext(orgContext,async()=>{
    await db.update(deviceCommands).set({status:'completed',result:{status:'completed',stdout}}).where(eq(deviceCommands.id,command!.id));
    await handleCallerVerifyResult({agentId:f.device.agentId,command:command!,commandId:command!.id,resolvedDeviceId:f.device.id,result:{status:'completed'},stdout});
  });
  observationFault.fail=true;
  try { await expect(receive()).rejects.toThrow('observation failed'); }
  finally { observationFault.fail=false; }
  await withDbAccessContext(orgContext,async()=>{
    const [row]=await db.select().from(callerVerifications).where(eq(callerVerifications.id,view.id));
    const [receipt]=await db.select().from(deviceCommands).where(eq(deviceCommands.id,command!.id));
    expect(row).toMatchObject({status:'pending',decidedAt:null,osPrincipalObserved:null});
    expect(receipt!.status).toBe(command!.status);expect(receipt!.result).toEqual(command!.result);
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.resourceId,view.id),eq(auditLogs.action,'caller_verification.verified')))).toHaveLength(0);
  });
  await receive(); // Same request succeeds once the observer recovers.
  await withDbAccessContext(orgContext,async()=>{
    expect((await service.get(f.actor,f.org.id,view.id)).status).toBe('verified');
    expect(await db.select().from(auditLogs).where(and(eq(auditLogs.resourceId,view.id),eq(auditLogs.action,'caller_verification.verified')))).toHaveLength(1);
    const [receipt]=await db.select().from(deviceCommands).where(eq(deviceCommands.id,command!.id));
    expect(receipt!.status).toBe('completed');
  });
});
it('applies duplicate approval once, then repairs a durable late rejection',async()=>{
  const f=await fixture();const view=await withDbAccessContext(f.context,()=>service.start(f.actor,{orgId:f.org.id,contactId:f.contact.id,method:'workstation',actionScope:'any',deviceId:f.device.id,username:'alex'}));
  await withSystemDbAccessContext(async()=>{
    const [v]=await db.select().from(callerVerifications).where(eq(callerVerifications.id,view.id));
    const [command]=await db.select().from(deviceCommands).where(eq(deviceCommands.id,v!.agentCommandId!));
    const params={agentId:f.device.agentId,command:command!,commandId:command!.id,resolvedDeviceId:f.device.id,result:{status:'completed' as const},stdout:JSON.stringify({delivered:true,choice:v!.matchValue,principal:{uid:501,username:'alex'}})};
    await handleCallerVerifyResult(params);await handleCallerVerifyResult(params);
    const first=await service.get(f.actor,f.org.id,view.id);expect(first.status).toBe('verified');expect(first.tier).toBe(1);
    await db.update(deviceCommands).set({status:'completed',result:{status:'completed',stdout:params.stdout}}).where(eq(deviceCommands.id,command!.id));
    expect(await persistCallerNotMeReceipt({commandId:command!.id,deviceId:f.device.id,result:{delivered:true,choice:'not_me'}})).toBe(true);
    // Simulated crash: receipt commits without calling the decision handler.
  });
  await reconcileCallerVerifications();await reconcileCallerVerifications();
  const final=await withDbAccessContext(f.context,()=>service.get(f.actor,f.org.id,view.id));expect(final.status).toBe('rejected_by_user');
});
it.each(['expire','repair'] as const)('reconciles a pending verification: %s',async mode=>{
  const f=await fixture();const view=await withDbAccessContext(f.context,()=>service.start(f.actor,{orgId:f.org.id,contactId:f.contact.id,method:'workstation',actionScope:'any',deviceId:f.device.id,username:'alex'}));
  await withSystemDbAccessContext(async()=>{
    const [v]=await db.select().from(callerVerifications).where(eq(callerVerifications.id,view.id));
    if(mode==='expire')await db.update(callerVerifications).set({expiresAt:new Date(Date.now()-1000)}).where(eq(callerVerifications.id,view.id));
    else await db.update(deviceCommands).set({status:'completed',result:{status:'completed',stdout:JSON.stringify({delivered:true,choice:v!.matchValue})}}).where(eq(deviceCommands.id,v!.agentCommandId!));
  });
  await reconcileCallerVerifications();
  const result=await withDbAccessContext(f.context,()=>service.get(f.actor,f.org.id,view.id));expect(result.status).toBe(mode==='expire'?'expired':'verified');
});
it('preserves mixed device readiness and refuses the selected outdated helper',async()=>{
  const f=await fixture();
  const old=await withSystemDbAccessContext(async()=>{
    const [d]=await db.insert(devices).values({orgId:f.org.id,siteId:f.site.id,agentId:randomUUID(),hostname:'old-helper',osType:'linux',osVersion:'test',architecture:'amd64',agentVersion:'test',lastUser:'alex',status:'online'}).returning();return d!;
  },'callerVerification.mixedHelpers');
  await recordWorkstationCapabilities(f.org.id,old.id,{callerVerify:false,usernames:[]});
  await withDbAccessContext(f.context,async()=>{
    const rows=await deviceSuggestions(f.actor,f.org.id,f.contact.id);
    expect(rows).toHaveLength(2);
    expect(rows.find(r=>r.deviceId===f.device.id)).toMatchObject({available:true});
    expect(rows.find(r=>r.deviceId===old.id)).toMatchObject({available:false,unavailableReason:'helper_outdated'});
    const methods=await service.methodsForContact(f.actor,f.org.id,f.contact.id,'any');
    expect(methods.find(m=>m.method==='workstation')?.available).toBe(true);
  });
  const input={orgId:f.org.id,contactId:f.contact.id,method:'workstation' as const,actionScope:'any' as const,username:'alex'};
  await expect(withDbAccessContext(f.context,()=>service.start(f.actor,{...input,deviceId:old.id}))).rejects.toMatchObject({code:'helper_outdated'});
  const good=await withDbAccessContext(f.context,()=>service.start(f.actor,{...input,deviceId:f.device.id}));
  expect(good.status).toBe('pending');
  await withDbAccessContext(f.context,async()=>{
    expect(await db.select().from(callerVerifications).where(eq(callerVerifications.workstationDeviceRef,old.id))).toHaveLength(0);
    expect(await db.select().from(deviceCommands).where(eq(deviceCommands.deviceId,old.id))).toHaveLength(0);
  });
});
it('excludes sibling sites and other organizations',async()=>{
  const a=await fixture(),b=await fixture();
  await withDbAccessContext(a.context,async()=>{
    await expect(deviceSuggestions({...a.actor,allowedSiteIds:[b.site.id]},a.org.id,a.contact.id)).rejects.toMatchObject({code:'not_found'});
    await expect(deviceSuggestions(a.actor,b.org.id,b.contact.id)).rejects.toMatchObject({code:'not_found'});
    expect(await deviceSuggestions(a.actor,a.org.id,a.contact.id)).toEqual([expect.objectContaining({deviceId:a.device.id,username:'alex',available:true,hasBinding:false})]);
    expect(await persistCallerNotMeReceipt({commandId:randomUUID(),deviceId:b.device.id,result:{delivered:true,choice:'not_me'}})).toBe(false);
  });
});
```

- [ ] **Step 2: Register `'src/services/callerVerification/workstation.integration.test.ts'` in `vitest.integration.config.ts` include **and** `apps/api/vitest.config.ts` exclude, so the no-DB unit runner never loads the real integration setup. Run `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/callerVerification/workstation.integration.test.ts`. Expected before implementation: missing W02 functions or transaction/replay assertions fail. Run with W01 migrations applied; never treat a skipped live-DB test as a pass.
- [ ] **Step 3: Add the exact documentation entry below, and correct any behavior exposed by the live tests in its owning task.**

```mdx
## Caller Verification

`caller_verify` asks the explicitly selected console user to confirm a support request. It requires a current Breeze agent and Tauri helper advertising `callerVerify`. The API creates the command together with the verification and sends it after commit; the start request returns 202 while the technician polls status.

| Payload field | Meaning |
|---|---|
| `verificationId` | Verification UUID |
| `username` | Explicit OS login; no preferred-user fallback |
| `technicianName`, `orgName` | Technician and organization shown on the card |
| `actionLabel`, `targetLabel` | Exact requested action and account |
| `reverseCode` | Four-digit request-confirmation code |
| `choices` | Three distinct two-digit numbers in stored order |
| `timeoutMs` | 30,000–300,000 milliseconds, chosen by effective policy |

The stdout JSON contains `delivered`, optional `choice` (`"42"`, `"not_me"`, or `"timeout"`), optional `principal` (`sid` or numeric `uid`, `username`, optional `upn`), optional `helperVersion`, and optional `error` (`no_session_for_user`, `session_not_console`, `helper_outdated`). The chosen number must be one of the three displayed candidates.

Native user helpers and non-console RDS sessions cannot render this card. Closing the window, losing the helper or reaching the deadline never approves. “This is not me” remains actionable after an earlier decision or expiry. Results are processed through the same handler over HTTP and WebSocket.

A bound workstation can provide tier 3; an unbound workstation provides tier 1 and does not satisfy the default tier-2 gate. Number matching confirms the request; it does not prove the technician's identity or prevent a relayed conversation. If unsure, hang up and call the MSP on a number already held.

The feature remains hidden behind `CALLER_VERIFICATION_ENABLED` until enforcement ships in W05. Deploy both agent and helper before expecting workstation availability; a version string alone is not a capability advertisement.
```

- [ ] **Step 4: Run** `cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/callerVerification/workstation.integration.test.ts`; `pnpm --filter @breeze/docs build`. Expected: non-skipped passing live tests and valid MDX. Run `pnpm test-stack down` from the repository root even when a test fails.
- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/services/callerVerification/workstation.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts apps/docs/src/content/docs/agents/commands.mdx
git commit -m "test(caller-verification): prove workstation atomicity and rejection recovery"
```

### Task 16: Observe authenticated logins through the existing session inventory

**Files:** Modify `agent/internal/collectors/sessions.go`, `agent/internal/collectors/sessions_test.go`, `apps/api/src/routes/agents/schemas.ts`, `apps/api/src/routes/agents/sessions.ts`, `apps/api/src/routes/agents/sessions.test.ts`, W01 `apps/api/src/services/callerVerification/subjects.ts`. Consume/extend W01's `agent/internal/collectors/session_principal_windows.go`, `agent/internal/collectors/session_principal_unix.go`, and `apps/api/src/services/callerVerification/loginObservation.ts`; create `apps/api/src/routes/agents/sessions.callerVerification.integration.test.ts`. Add the live suite to `apps/api/vitest.integration.config.ts` includes and `apps/api/vitest.config.ts` excludes. The existing `agent/internal/heartbeat/heartbeat.go:sendSessionInventory` sends these structs unchanged and requeues drained events after failed uploads; no second reporting path is added.

**Interfaces:** Add optional `principal:{sid?:string;uid?:number;username:string;upn?:string}` to session snapshots and login events. SID/UID and UPN come from the OS, never helper-supplied text. The authenticated device fixes org and hostname. Only a unique active **existing** directory binding across that org may be passed to the unchanged `observeLogin` signature. Login alone creates neither a verification nor an Entra identity. Snapshots cover agent restarts and upload retries; logout events are not evidence.

- [ ] **Step 1: Write collector and real API-consumer regressions.** Append to the existing Go test file; its `fakeDetector`, JSON and string imports already exist.

```go
func TestLoginPrincipalReporting(t *testing.T) {
    for _, tc := range []struct{name string; principal *SessionPrincipal}{
        {"directory", &SessionPrincipal{SID:"S-1-5-21-42", Username:"alice", UPN:"alice@example.com"}},
        {"unresolved", nil},
    } {
        t.Run(tc.name, func(t *testing.T) {
            now := time.Now()
            c := &SessionCollector{
                detector: &fakeDetector{sessions: []sessionbroker.DetectedSession{{Username:"alice", Session:"2", State:"active"}}},
                sessions: make(map[string]UserSession),
                principalReader: func(username, session string, uid uint32) *SessionPrincipal {
                    if session != "2" || username != "alice" { t.Fatalf("wrong OS session: %s %s", username, session) }
                    return tc.principal
                },
            }
            c.refreshSessions(now)
            rows, err := c.Collect()
            if err != nil || len(rows) != 1 || rows[0].Principal != tc.principal { t.Fatalf("snapshot: %+v, %v", rows, err) }
            c.applyEvent(sessionbroker.SessionEvent{Type:sessionbroker.SessionLogin, Username:"alice", Session:"2"}, now)
            events := c.DrainEvents(256)
            if len(events) != 1 || events[0].Principal != tc.principal { t.Fatalf("login: %+v", events) }
            c.RequeueEvents(events)
            retry := c.DrainEvents(256)
            if len(retry) != 1 || retry[0].Principal != tc.principal { t.Fatalf("retry: %+v", retry) }
            encoded, err := json.Marshal(retry[0]); if err != nil { t.Fatal(err) }
            if tc.principal != nil && !strings.Contains(string(encoded), `"upn":"alice@example.com"`) { t.Fatalf("wire: %s", encoded) }
            if tc.principal == nil && strings.Contains(string(encoded), `"principal"`) { t.Fatalf("invented principal: %s", encoded) }
            c.applyEvent(sessionbroker.SessionEvent{Type:sessionbroker.SessionLogout, Username:"alice", Session:"2"}, now)
            events = c.DrainEvents(256)
            if len(events) != 1 || events[0].Principal != nil { t.Fatalf("logout evidence: %+v", events) }
        })
    }
}
```

Create the live API suite below. It uses a synthetic already-authenticated agent context at the subrouter boundary, real `requireAgentRole`, real schema, real org RLS, real binding resolution and real `observeLogin`. It does not claim to retest token verification in `agentAuthMiddleware`. No mocks of the consumer or database.

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withDbAccessContext, withSystemDbAccessContext } from '../../db';
import { contacts, devices, deviceSessions } from '../../db/schema';
import { callerVerificationSubjectBindings as b, callerVerifications as v } from '../../db/schema/callerVerification';
import { createPartner, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { sessionsRoutes } from './sessions';
async function seed(){
  const partner=await createPartner(),org=await createOrganization({partnerId:partner.id}),other=await createOrganization({partnerId:partner.id});
  const site=await createSite({orgId:org.id});
  const device=await withSystemDbAccessContext(async()=>{
    const [d]=await db.insert(devices).values({orgId:org.id,siteId:site.id,agentId:randomUUID(),hostname:'login-test',osType:'windows',osVersion:'test',architecture:'amd64',agentVersion:'test'}).returning();return d!;
  },'callerVerification.login.seed');
  const bind=async(orgId:string,upn:string)=>withSystemDbAccessContext(async()=>{
    const [contact]=await db.insert(contacts).values({orgId,name:'Alice'}).returning();
    const [row]=await db.insert(b).values({orgId,contactId:contact!.id,entraTenantId:randomUUID(),entraOid:randomUUID(),upnSnapshot:upn,source:'directory_sync'}).returning();return row!;
  },'callerVerification.login.binding');
  const app=new Hono();
  app.use('*',async(c,next)=>{
    c.set('agent',{deviceId:device.id,agentId:device.agentId,orgId:org.id,role:'agent'} as never);
    return withDbAccessContext({scope:'organization',orgId:org.id,accessibleOrgIds:[org.id],accessiblePartnerIds:[]},async()=>{await next();if(c.error)throw c.error;});
  });
  app.route('/agents',sessionsRoutes);
  const send=(body:unknown,pathAgentId=device.agentId)=>app.request(`/agents/${pathAgentId}/sessions`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  return {org,other,device,bind,send};
}
const principal={sid:'S-1-5-21-42',username:'alice',upn:'alice@example.com'};
it.each(['matched','unmatched','ambiguous','cross-org'] as const)('resolves login events: %s',async mode=>{
  const f=await seed();
  const first=await f.bind(mode==='cross-org'?f.other.id:f.org.id,mode==='unmatched'?'other@example.com':'alice@example.com');
  if(mode==='ambiguous')await f.bind(f.org.id,'ALICE@example.com');
  const body={sessions:[],events:[{type:'login',username:'alice',sessionType:'console',sessionId:'2',principal}]};
  expect((await f.send(body)).status).toBe(200);
  expect((await f.send(body)).status).toBe(200); // Requeued login is idempotent.
  await withSystemDbAccessContext(async()=>{
    const rows=await db.select().from(b);expect(rows).toHaveLength(mode==='ambiguous'?2:1);
    expect(rows.find(r=>r.id===first.id)?.osPrincipal).toBe(mode==='matched'?principal.sid:null);
    if(mode!=='matched')expect(rows.every(r=>r.osPrincipal===null)).toBe(true);
    expect(await db.select().from(v)).toHaveLength(0);
  },'callerVerification.login.assert');
});
it('handles active snapshots without a challenge and ignores mismatched or missing identity',async()=>{
  const f=await seed(),binding=await f.bind(f.org.id,principal.upn);
  for(const p of [undefined,{...principal,username:'mallory'}]) {
    expect((await f.send({sessions:[{username:'alice',sessionType:'console',principal:p}]})).status).toBe(200);
    await withSystemDbAccessContext(async()=>{const [row]=await db.select().from(b).where(eq(b.id,binding.id));expect(row!.osPrincipal).toBeNull();},'callerVerification.login.unmatched');
  }
  expect((await f.send({sessions:[{username:'alice',sessionType:'console',principal}]})).status).toBe(200);
  await withSystemDbAccessContext(async()=>{
    const [row]=await db.select().from(b).where(eq(b.id,binding.id));expect(row!.osPrincipal).toBe(principal.sid);
    expect(await db.select().from(deviceSessions).where(eq(deviceSessions.deviceId,f.device.id))).toHaveLength(1);
  },'callerVerification.login.snapshot');
});
it('rejects another agent path and a device whose org moved since authentication',async()=>{
  const f=await seed();await f.bind(f.other.id,principal.upn);
  const body={sessions:[],events:[{type:'login',username:'alice',sessionType:'console',principal}]};
  expect((await f.send(body,randomUUID())).status).toBe(403);
  const site=await createSite({orgId:f.other.id});
  await withSystemDbAccessContext(()=>db.update(devices).set({orgId:f.other.id,siteId:site.id}).where(eq(devices.id,f.device.id)),'callerVerification.login.move');
  expect((await f.send(body)).status).toBe(404);
  await withSystemDbAccessContext(async()=>{expect((await db.select().from(b)).every(r=>r.osPrincipal===null)).toBe(true);},'callerVerification.login.foreign');
});
```

- [ ] **Step 2: Run red.** `cd agent && go test -race ./internal/collectors/...` fails on missing fields before W01's telemetry addition; with that addition present it is a regression test. With the new integration file registered, run `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/routes/agents/sessions.callerVerification.integration.test.ts`; the positive login assertions fail until the consumer exists; after W01 they may pass immediately, and the new device-ownership cases guard the W02 integration. Stop the stack with `pnpm test-stack down` from the repository root, including on failure.

- [ ] **Step 3: Add OS-derived identity to the existing structs and consume it.** In `sessions.go`, add:

```go
type SessionPrincipal struct {
    SID string `json:"sid,omitempty"`
    UID *uint32 `json:"uid,omitempty"`
    Username string `json:"username"`
    UPN string `json:"upn,omitempty"`
}
```

Add the field `Principal *SessionPrincipal` with the struct tag `json:"principal,omitempty"` to both `UserSession` and `UserSessionEvent`; reuse W01 Task 8 Step 3b's `principalReader func(string, string, uint32) *SessionPrincipal` field and method below. If rebasing onto that addition, extend it once; do not add a second principal field or consumer. Existing tests that instantiate a collector must inject a nil-returning reader when testing unrelated behavior:

```go
func (c *SessionCollector) readPrincipal(username, session string, uid uint32) *SessionPrincipal {
    if c.principalReader != nil { return c.principalReader(username, session, uid) }
    return principalForSession(username, session, uid)
}
```

In `refreshSessions`, immediately before `c.mu.Lock()`, resolve identity outside the mutex:

```go
principals := make(map[string]*SessionPrincipal, len(sessions))
for _, detected := range sessions {
    key := sessionKey(detected.Username, inferSessionType(detected), detected.Session)
    principals[key] = c.readPrincipal(detected.Username, detected.Session, detected.UID)
}
```

Add `Principal: principals[key],` to its `next[key] = UserSession{...}` literal. In `applyEvent`, before `c.mu.Lock()`, add:

```go
var principal *SessionPrincipal
if event.Type == sessionbroker.SessionLogin {
    principal = c.readPrincipal(event.Username, event.Session, event.UID)
}
```

Add `Principal: principal,` to the login case's `UserSession` literal and to the appended `UserSessionEvent` literal. Keep all existing fields, bounded buffering and requeue behavior. No change to `sendSessionInventory` is needed: its `sessions` and `events` payload values already serialize these structs.

```go
// agent/internal/collectors/session_principal_windows.go
//go:build windows

package collectors

import (
    "strconv"
    "strings"
    "golang.org/x/sys/windows"
)
func principalForSession(username, session string, _ uint32) *SessionPrincipal {
    id, err := strconv.ParseUint(session, 10, 32)
    if err != nil || id == 0 || strings.TrimSpace(username) == "" { return nil }
    var token windows.Token
    if windows.WTSQueryUserToken(uint32(id), &token) != nil { return nil }
    defer token.Close()
    user, err := token.GetTokenUser(); if err != nil { return nil }
    account, domain, _, err := user.User.Sid.LookupAccount(""); if err != nil { return nil }
    canonical := account; if domain != "" { canonical = domain + `\` + account }
    if !strings.EqualFold(username, account) && !strings.EqualFold(username, canonical) { return nil }
    p := &SessionPrincipal{SID:user.User.Sid.String(), Username:username}
    upn, err := windows.TranslateAccountName(canonical, windows.NameSamCompatible, windows.NameUserPrincipal, 256)
    if err == nil { p.UPN = upn }
    return p
}
```

```go
// agent/internal/collectors/session_principal_unix.go
//go:build !windows

package collectors

import (
    "strings"
)
func principalForSession(username, _ string, uid uint32) *SessionPrincipal {
    if strings.TrimSpace(username) == "" { return nil }
    return &SessionPrincipal{UID:&uid, Username:username}
}
```

The verified Windows APIs already appear in `sessionbroker/spawn_process_windows.go` and `agent/internal/onedrivehelper/onedrivehelper_windows.go`. The detector supplies the OS session; the token supplies its SID. UPN translation failure leaves UPN absent, never guesses from a contact email. Unix reports UID (including zero) but cannot auto-bind without a verified UPN provider.

In API `schemas.ts`, define this immediately before `submitSessionsSchema`, then add `principal: sessionPrincipalSchema.optional(),` to **both** its session and event object schemas:

```ts
const sessionPrincipalSchema=z.object({
  sid:z.string().regex(/^S-\d+(?:-\d+)+$/).max(184).optional(),
  uid:z.number().int().min(0).max(4294967295).optional(),
  username:z.string().min(1).max(255),
  upn:z.string().min(1).max(320).optional(),
}).strict().refine(p=>(p.sid!==undefined)!==(p.uid!==undefined),'Exactly one OS principal is required');
```

Reuse W01 Task 8 Step 3b's consumer unchanged (shown in full to make this task executable). If present after rebase, do not add a parallel implementation:

```ts
// loginObservation.ts
import { and,eq,isNotNull,isNull,sql } from 'drizzle-orm';
import { db,assertInTransaction } from '../../db';
import { callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { observeLogin } from './subjects';
export type SessionPrincipal={sid?:string;uid?:number;username:string;upn?:string};
export async function observeSessionPrincipal(orgId:string,hostname:string,username:string,p:SessionPrincipal|undefined):Promise<void>{
 if(!p?.upn||p.username.toLowerCase()!==username.toLowerCase()||((p.sid!==undefined)===(p.uid!==undefined)))return;
 assertInTransaction('observeSessionPrincipal');
 await db.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`caller-identity:${orgId}`}))`);
 const rows=await db.select().from(b).where(and(eq(b.orgId,orgId),isNull(b.revokedAt),isNotNull(b.entraTenantId),isNotNull(b.entraOid),sql`lower(${b.upnSnapshot})=lower(${p.upn})`)).limit(2);
 if(rows.length!==1)return;
 await observeLogin({orgId,contactId:rows[0]!.contactId,osPrincipal:p.sid??`uid:${p.uid}@${hostname}`,osUsername:p.username,upn:p.upn});
}
```

W01 Task 8 Step 3b also adds this org-wide uniqueness check to `subjects.ts:observeLogin`. Preserve it, the transaction assertion, identity lock and conflict-revocation code. In particular, do not restore the earlier contact-only lookup when integrating the challenge-success path:

```ts
 const matches=await db.select().from(b).where(and(eq(b.orgId,input.orgId),isNull(b.revokedAt),sql`${b.entraOid} IS NOT NULL AND ${b.entraTenantId} IS NOT NULL`,sql`lower(${b.upnSnapshot})=lower(${input.upn})`)).limit(2);
 if(matches.length!==1 || matches[0]!.contactId!==input.contactId)return;
 const target=matches[0]!;
```

In `routes/agents/sessions.ts`, import `observeSessionPrincipal` from `../../services/callerVerification/loginObservation`. Replace the existing agent cast and device lookup with this code; `agentAuthMiddleware` already supplies all these identity fields and the org transaction. Do not accept a request-body org/contact identifier:

```ts
  const agent=c.get('agent');
  if(!agent || agent.agentId!==agentId)return c.json({error:'Device not found'},403);
  const [device]=await db.select({id:devices.id,orgId:devices.orgId,siteId:devices.siteId,hostname:devices.hostname})
    .from(devices).where(and(eq(devices.id,agent.deviceId),eq(devices.agentId,agentId)))
    .limit(1).for('share');
  if(!device)return c.json({error:'Device not found'},404);
  if(agent.orgId!==device.orgId)return c.json({error:'Device not found'},403);
```

After the existing `await db.transaction(...)` session-row write and before event publishing, add:

```ts
  for(const session of activeSessions)await observeSessionPrincipal(device.orgId,device.hostname,session.username,session.principal);
  for(const event of data.events ?? [])if(event.type==='login')await observeSessionPrincipal(device.orgId,device.hostname,event.username,event.principal);
```

Both writes still live inside the authenticated outer transaction, and the device share lock prevents an org move until it commits. Propagate an observation failure so the request fails and the agent retries; do not catch it as a best-effort event-publish failure. In existing `sessions.test.ts`, retain W01's `observeSessionPrincipal` mock and forwarded-login/cross-org tests. Replace `mockDeviceLookup` with:

```ts
function mockDeviceLookup() {
  vi.mocked(db.select).mockReturnValueOnce({from:()=>({where:()=>({limit:()=>({
    for:async()=>[{id:DEVICE_ID,orgId:'org-1',hostname:'host-1'}],
  })})})} as never);
}
```

Ensure the authenticated middleware below precedes `app.route('/agents', sessionsRoutes)`. Use the same complete identity in the foreign-org middleware, retaining `orgId:'org-2'` in the latter:

```ts
app.use('*',async(c,next)=>{
  c.set('agent',{deviceId:DEVICE_ID,agentId:AGENT_ID,orgId:'org-1',role:'agent'} as never);
  await next();
});
```

The existing foreign-org mock remains 403; a real moved device hidden by old-org RLS is 404. Run both suites to prove normal ingestion still works.

- [ ] **Step 4: Run green and register live coverage.**

```bash
(cd agent && go test -race ./internal/collectors/... ./internal/heartbeat/...)
(cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/caller-session-collectors.test.exe ./internal/collectors)
(cd apps/api && npx vitest run src/routes/agents/sessions.test.ts src/services/callerVerification/subjects.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/routes/agents/sessions.callerVerification.integration.test.ts src/services/callerVerification/workstation.integration.test.ts)
pnpm test-stack down
```

Use finally/trap cleanup for the stack. Cross-compilation proves build compatibility; run the actual WTS token case on Windows during Task 18 platform verification.

- [ ] **Step 5: Commit.**

```bash
git add agent/internal/collectors/sessions.go agent/internal/collectors/sessions_test.go agent/internal/collectors/session_principal_windows.go agent/internal/collectors/session_principal_unix.go apps/api/src/routes/agents/schemas.ts apps/api/src/routes/agents/sessions.ts apps/api/src/routes/agents/sessions.test.ts apps/api/src/services/callerVerification/subjects.ts apps/api/src/services/callerVerification/loginObservation.ts apps/api/src/routes/agents/sessions.callerVerification.integration.test.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m "feat(caller-verification): observe directory-bound logins from session reports"
```

### Task 17: Revoke workstation grants in the device org-move transaction

**Files:** Create `apps/api/src/routes/devices/moveOrg.callerVerification.integration.test.ts`; consume W01 `apps/api/src/services/callerVerification/deviceMove.ts` (Task 13 Step 3a); retain W01's wiring in `apps/api/src/routes/devices/moveOrg.ts`; modify `apps/api/src/routes/devices/moveOrg.test.ts`, W01 `apps/api/src/services/callerVerification/service.ts:start`, and both API Vitest configs. Task 10 already locks the answering device through result processing. W01 Task 13 Step 3a now supplies the move hook; reuse its signature/body unchanged and add the W02 transport/locking proof below. No caller table joins the generic device-child walker.

**Interfaces:** `revokeWorkstationGrantsForMove(tx,sourceOrgId,deviceId):Promise<void>` uses the route's **explicit** transaction, original org and `workstationDeviceRef`. It expires pending and revokes verified, unconsumed workstation grants, locks requester and target bindings in the same sorted order as the gate, and leaves consumed status/history and snapshot ownership untouched. The device row is locked before scanning grants, preventing new starts and results from escaping the scan.

- [ ] **Step 1: Write the live route test.** The real JWT/permission fixture follows the existing `deviceMoveOrgCurrency.integration.test.ts`; no gate, move route, binding or authorization mock is used.

```ts
import '../../__tests__/integration/setup';
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, withSystemDbAccessContext } from '../../db';
import { contacts, devices } from '../../db/schema';
import { callerVerifications as v, callerVerificationSubjectBindings as b } from '../../db/schema/callerVerification';
import { setupTestEnvironment, createOrganization, createSite } from '../../__tests__/integration/db-utils';
import { createAccessToken } from '../../services/jwt';
import { moveOrgRoutes } from './moveOrg';
import { requireCallerVerification } from '../../services/callerVerification/gate';
import { CallerVerificationRequiredError } from '../../services/callerVerification/errors';
import { revokeWorkstationGrantsForMove } from '../../services/callerVerification/deviceMove';
vi.hoisted(()=>{process.env.CALLER_VERIFICATION_ENABLED='true';});
const sys=<T>(fn:()=>Promise<T>)=>withSystemDbAccessContext(fn,'callerVerification.move.test');
async function fixture(){
  const env=await setupTestEnvironment({scope:'partner'});
  const target=await createOrganization({partnerId:env.partner.id}),targetSite=await createSite({orgId:target.id});
  const device=await sys(async()=>{
    const [d]=await db.insert(devices).values({orgId:env.organization.id,siteId:env.site.id,agentId:randomUUID(),hostname:'move-test',osType:'windows',osVersion:'test',architecture:'amd64',agentVersion:'test',status:'offline'}).returning();return d!;
  });
  let principalNumber=100;
  const grant=async(orgId:string,deviceRef:string,consumed=false,status:'pending'|'verified'='verified')=>sys(async()=>{
    const [contact]=await db.insert(contacts).values({orgId,name:'Alex'}).returning();
    const [binding]=await db.insert(b).values({orgId,contactId:contact!.id,entraTenantId:randomUUID(),entraOid:randomUUID(),upnSnapshot:'alex@example.com',osPrincipal:`S-1-5-21-${++principalNumber}`,osUsername:'alex',source:'directory_sync'}).returning();
    const [row]=await db.insert(v).values({orgId,contactId:contact!.id,requesterBindingId:binding!.id,targetBindingId:binding!.id,targetEntraTenantId:binding!.entraTenantId,targetEntraOid:binding!.entraOid,
      initiatedByUserId:env.user.id,technicianLabel:'Tech',actionScope:'reset_password',method:'workstation',status,tier:3,tierReason:'bound_principal',osPrincipalObserved:binding!.osPrincipal,
      workstationDeviceRef:deviceRef,deviceHostname:'move-test',osUsername:'alex',matchValue:'42',decoyValues:['11','73'],reverseCode:'1234',attemptNo:1,
      expiresAt:new Date(Date.now()+120000),decidedAt:status==='verified'?new Date():null,consumedAt:consumed?new Date():null,consumedIntentRef:consumed?randomUUID():null}).returning();
    return {row:row!,binding:binding!};
  });
  const token=await createAccessToken({sub:env.user.id,email:env.user.email,roleId:env.role.id,orgId:null,partnerId:env.partner.id,scope:'partner',mfa:true,aep:1,mep:1,sid:randomUUID()});
  const app=new Hono();app.route('/devices',moveOrgRoutes);
  const move=()=>app.request(`/devices/${device.id}/move-org`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({orgId:target.id,siteId:targetSite.id})});
  return {...env,target,device,grant,move};
}
it('a real move revokes old-org authority and preserves consumed and unrelated history',async()=>{
  const f=await fixture();
  const active=await f.grant(f.organization.id,f.device.id);
  const pending=await f.grant(f.organization.id,f.device.id,false,'pending');
  const consumed=await f.grant(f.organization.id,f.device.id,true);
  const otherDevice=await f.grant(f.organization.id,randomUUID());
  const otherOrg=await f.grant(f.target.id,f.device.id);
  const input={orgId:f.organization.id,action:'reset_password' as const,target:{entraTenantId:active.binding.entraTenantId!,entraOid:active.binding.entraOid!},backendTenantId:active.binding.entraTenantId!,technicianUserId:f.user.id,intentId:randomUUID(),mode:'check' as const};
  await expect(requireCallerVerification(input)).resolves.toEqual({verificationId:active.row.id,tier:3});
  const response=await f.move();expect(response.status,JSON.stringify(await response.json())).toBe(200);
  await expect(requireCallerVerification({...input,mode:'consume'})).rejects.toBeInstanceOf(CallerVerificationRequiredError);
  await sys(async()=>{
    const [device]=await db.select().from(devices).where(eq(devices.id,f.device.id));expect(device!.orgId).toBe(f.target.id);
    const rows=await db.select().from(v),get=(id:string)=>rows.find(r=>r.id===id)!;
    expect(get(active.row.id)).toMatchObject({orgId:f.organization.id,workstationDeviceRef:f.device.id,status:'revoked',consumedAt:null,consumedIntentRef:null});
    expect(get(pending.row.id).status).toBe('expired');
    expect(get(consumed.row.id)).toMatchObject({status:'verified',orgId:f.organization.id,consumedAt:consumed.row.consumedAt,consumedIntentRef:consumed.row.consumedIntentRef});
    expect(get(otherDevice.row.id).status).toBe('verified');expect(get(otherOrg.row.id).status).toBe('verified');
  });
});
it('rolls back revocation with a failed move transaction',async()=>{
  const f=await fixture(),g=await f.grant(f.organization.id,f.device.id);
  await expect(sys(()=>db.transaction(async tx=>{
    await tx.select({id:devices.id}).from(devices).where(eq(devices.id,f.device.id)).limit(1).for('update');
    await revokeWorkstationGrantsForMove(tx,f.organization.id,f.device.id);
    const [changed]=await tx.select().from(v).where(eq(v.id,g.row.id));expect(changed!.status).toBe('revoked');
    await tx.update(devices).set({hostname:'rolled-back'}).where(eq(devices.id,f.device.id));
    throw new Error('move failed');
  }))).rejects.toThrow('move failed');
  await sys(async()=>{
    const [row]=await db.select().from(v).where(eq(v.id,g.row.id));expect(row!.status).toBe('verified');
    const [device]=await db.select().from(devices).where(eq(devices.id,f.device.id));expect(device!.hostname).toBe('move-test');
  });
});
```

- [ ] **Step 2: Run red.** Register `src/routes/devices/moveOrg.callerVerification.integration.test.ts` in integration includes and unit excludes. Run `pnpm test-stack up`, then `cd apps/api && npx vitest run --config vitest.integration.config.ts src/routes/devices/moveOrg.callerVerification.integration.test.ts`. Expected before W01's hook: the old grant still authorizes. With that hook already present, the live regression may pass immediately; retain it and complete the lock placement below. Always run `pnpm test-stack down` from root afterward.

- [ ] **Step 3: Implement and wire the locked revocation.**

W01 Task 13 Step 3a owns `deviceMove.ts` and its predicate/lock test. Do not recreate it with another signature. In `moveOrg.ts`, retain its `revokeWorkstationGrantsForMove` import and its **single** lock-and-hook block in W01's position: after the `lockedSource`/`lockedTarget` existence checks, `assertPamDeviceOrgMoveAllowed`, custom-field re-home and manual-asset detach, immediately before `tx.update(devices)`. Keep this existing block in place; do not insert a second copy or relocate it before the PAM guard:

```ts
const [callerMoveDevice]=await tx.select({orgId:devices.orgId}).from(devices)
  .where(eq(devices.id,deviceId)).limit(1).for('update');
if(callerMoveDevice?.orgId!==sourceOrgId)throw new Error('Device organization changed during move');
await revokeWorkstationGrantsForMove(tx,sourceOrgId,deviceId);
```

This preserves the route's existing ordered org locks as the first locking operation and W01's statement indices 0–5 unchanged. A PAM refusal exits before revocation; any later currency/cascade failure rolls the revocation back with the move. Do not call a detached system context or use ambient `db` inside the hook: the route owns a nested transaction/savepoint and its explicit `tx` is the rollback boundary.

In `moveOrg.test.ts`, retain W01's `rigTransactionSuccess` branch for `cols && 'orgId' in cols`, before its existing `payload` branch. It records `SELECT devices FOR update` and returns `[{orgId:SOURCE_ORG}]`; otherwise the new device read would fall through to the organization-lock fixture. In the existing test `runs after both organization SHARE locks and before the device update`, keep the inherited assertions below and append the three single-hook count assertions. Keep the existing response-status and `pamGuardMock` argument assertions too:

```ts
expect(statements[0]).toBe(
  'SET CONSTRAINTS time_entries_ticket_org_fk, ticket_parts_ticket_org_fk DEFERRED',
);
expect(statements.slice(1,4)).toEqual([
  'SELECT organizations FOR share (after 0 updates)',
  'SELECT organizations FOR share (after 0 updates)',
  'PAM guard',
]);
expect(collapseStmt(statements[4]!)).toContain('breeze_rehome_device_custom_field_values');
expect(collapseStmt(statements[5]!)).toContain('UPDATE manual_assets SET linked_device_id = NULL');
expect(statements[6]).toBe('SELECT devices FOR update');
expect(collapseStmt(statements[7]!)).toContain('SELECT requester_binding_id,target_binding_id FROM caller_verifications');
expect(collapseStmt(statements[8]!)).toContain('UPDATE caller_verifications');
expect(statements[9]).toBe('UPDATE devices');
expect(statements.filter(s=>s==='SELECT devices FOR update')).toHaveLength(1);
expect(statements.map(collapseStmt).filter(s=>s.startsWith('SELECT requester_binding_id,target_binding_id FROM caller_verifications'))).toHaveLength(1);
expect(statements.map(collapseStmt).filter(s=>s.startsWith('UPDATE caller_verifications'))).toHaveLength(1);
```

This fixture returns no caller grants, so the hook takes no subject advisory locks and occupies exactly indices 6–8. W01's `deviceMove.test.ts` covers sorted subject-lock acquisition with grants present; the live test above covers actual revocation and consumed history. The positional assertions catch moving the hook ahead of PAM, while the count assertions catch accidentally wiring it twice.

In W01 `service.ts:start`, replace its device lookup (before `lockContact`/`withSubjectLocks`) with:

```ts
 if(input.deviceId){
  [device]=await db.select().from(devices).where(and(eq(devices.id,input.deviceId),eq(devices.orgId,orgId))).limit(1).for('share');
  if(!device||actor.allowedSiteIds!==null&&(!device.siteId||!actor.allowedSiteIds.includes(device.siteId)))throw new Invalid('not_found','Device not found');
 }
```

Keep that share lock through verification/command creation. Task 10 takes the same device share lock before decision/binding locks, and Task 16 takes it before observing logins. The move takes the incompatible device update lock **before** scanning grants or taking subject locks. Therefore a start/result either commits before the scan and is revoked, or waits and fails old-org ownership after the move. Do not move this lock into `prepareWorkstationVerification`, which is called after binding locks and would invert the order. The gate only needs the existing subject locks: consumption that wins before the move remains historical; a later consumer sees revoked. W01 remains responsible for org merges and W05 for final dispatch checks.

- [ ] **Step 4: Run green.**

```bash
(cd apps/api && npx tsc --noEmit)
(cd apps/api && npx vitest run src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts src/services/callerVerification/deviceMove.test.ts src/services/callerVerification/service.test.ts src/services/callerVerification/workstationResult.test.ts)
pnpm test-stack up
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/routes/devices/moveOrg.callerVerification.integration.test.ts src/services/callerVerification/workstation.integration.test.ts src/__tests__/integration/deviceMoveOrgCurrency.integration.test.ts)
pnpm test-stack down
```

Use finally/trap cleanup. The first live test has a successful gate control before movement, so blanket denial cannot satisfy it; it then drives the real authenticated move and refuses consumption of the former grant. The second proves atomic rollback on the explicit transaction.

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/routes/devices/moveOrg.ts apps/api/src/routes/devices/moveOrg.test.ts apps/api/src/routes/devices/moveOrg.callerVerification.integration.test.ts apps/api/src/services/callerVerification/service.ts apps/api/vitest.integration.config.ts apps/api/vitest.config.ts
git commit -m "fix(caller-verification): revoke workstation grants when devices move orgs"
```

### Task 18: Wave verification, release evidence and PR

**Files:** Create `apps/api/src/services/callerVerification/workstation.contract.test.ts`. Review every file listed above; no migrations or W05 gate activation. Reference `CLAUDE.md` integration traps and `.claude/skills/agent-info/SKILL.md`, `.claude/skills/breeze-helper/SKILL.md` release guidance.

**Interfaces:** Consumes the complete W02 wire/service contract and produces an open W02 PR plus agent/helper release test evidence. No deployment, merge or feature-flag flip in this task.

- [ ] **Step 1: Write a contract test that fails on any missed registration.**

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const source=(path:string)=>readFileSync(new URL(path,import.meta.url),'utf8');
it('registers both transports and retains strict helper capability selection',()=>{
  expect(source('../../routes/agents/commands.ts')).toMatch(/REGISTRY_DISPATCHED_COMMAND_TYPES[\s\S]*?'caller_verify'/);
  expect(source('../commandResultHandlers.ts')).toContain('caller_verify: handleCallerVerifyResult');
  expect(source('../../../../../agent/internal/sessionbroker/caller_verify.go')).toContain('ipc.HelperRoleAssist');
  expect(source('../../../../../agent/internal/sessionbroker/caller_verify.go')).not.toContain('SessionForUser(');
  expect(source('../../../../../agent/internal/ipc/message.go')).toContain('json:"callerVerify"');
});
```

- [ ] **Step 2: Run** `cd apps/api && npx vitest run src/services/callerVerification/workstation.contract.test.ts`. Expected failure identifies an omitted registration if any; on a correctly completed wave this acceptance test passes immediately. Do not manufacture a failing product edit to make an acceptance task artificially red.
- [ ] **Step 3: Complete missing registrations using the exact code in Tasks 1, 8, 10 and 11; run typechecks and the targeted/contract suites.**

```bash
(cd apps/api && npx tsc --noEmit)
(cd apps/helper && npx tsc --noEmit)
(cd apps/api && npx vitest run src/services/callerVerification/workstationProtocol.test.ts src/services/callerVerification/workstationCapabilities.test.ts src/services/callerVerification/helperBranding.test.ts src/services/callerVerification/deliverers/workstation.test.ts src/services/callerVerification/workstationResult.test.ts src/services/callerVerification/workstationReceipt.test.ts src/services/commandResultHandlers.callerVerify.test.ts src/jobs/callerVerificationReconciliation.test.ts src/services/callerVerification/deviceSuggestions.test.ts src/routes/callerVerificationWorkstation.test.ts src/services/callerVerification/workstation.contract.test.ts)
(cd apps/api && npx vitest run src/routes/agents/commands.test.ts src/routes/agentWs.test.ts src/routes/agents/heartbeat.test.ts src/routes/agents/sessions.test.ts src/services/callerVerification/loginObservation.test.ts src/services/callerVerification/deviceMove.test.ts src/routes/helper/index.test.ts src/routes/orgContacts.test.ts src/jobs/workerReadinessCoverage.test.ts src/services/workerEntrypointClosure.contract.test.ts src/jobs/scheduleRegistry.contract.test.ts src/routes/devices/moveOrg.test.ts src/routes/devices/moveOrg.coverage.test.ts src/db/autoMigrate.test.ts src/db/migrationRlsScope.test.ts)
(cd apps/helper && npx vitest run src/windows/CallerVerifyWindow.test.tsx)
(cd apps/helper/src-tauri && cargo test ipc::caller_verify && cargo test ipc::client)
(cd agent && go test -race ./internal/ipc/... ./internal/sessionbroker/... ./internal/heartbeat/... ./internal/collectors/...)
```

After W04 Task 1 is available, also run `(cd apps/web && npx vitest run src/lib/api/callerVerification.workstation.test.ts src/lib/api/callerVerification.test.ts)`. Record missing W04 as pending integration evidence, not a passing check.

- [ ] **Step 4: Run live contracts and retain actual results.**

```bash
pnpm test-stack up
(cd apps/api && npx vitest run --config vitest.integration.config.ts src/services/callerVerification/workstation.integration.test.ts src/routes/agents/sessions.callerVerification.integration.test.ts src/routes/devices/moveOrg.callerVerification.integration.test.ts src/__tests__/integration/orgLifecycleFoundations.integration.test.ts src/__tests__/integration/tenantCascade.integration.test.ts src/__tests__/integration/tenant-export-policy.integration.test.ts src/__tests__/integration/tenantExportErasureRoundtrip.integration.test.ts)
(cd apps/api && npx vitest run --config vitest.config.rls-coverage.ts src/__tests__/integration/rls-coverage.integration.test.ts)
pnpm test-stack down
```

Use a shell trap or explicit finally cleanup if executing these commands through automation. Confirm file counts and zero skips. Review W01's no-`device_id`/`ticket_id` contract and all six enum names unchanged. On lab Windows, macOS and Linux, install both builds, connect native + assist helpers, target the explicit console user, submit each of three choices and `not_me`, disconnect during a prompt and allow a timeout. Record principal shape, correlation, helper version and final verification state without logging challenge secrets. Independently log in without starting a challenge and confirm the existing session upload carries OS identity, only a unique existing same-org directory binding gains the principal, and unknown/ambiguous UPNs do not. Confirm old helper/no capability reports `helper_outdated`, Windows non-console sessions are unavailable, and UID-only responses stay tier 1. A platform unavailable locally is pending release evidence, never claimed tested.

- [ ] **Step 5: Commit final contract and open the wave PR after all required checks pass.** Resolve tracking numbers into `CALLER_PARENT` and `CALLER_WAVE` from GitHub feature tracking before starting implementation. The following commands use those actual values; they are not literal branch placeholders.

```bash
ls apps/api/migrations | sort | tail -1
git diff --check
git add apps/api/src/services/callerVerification/workstation.contract.test.ts
git commit -m "test(caller-verification): verify workstation wave contracts"
git push -u origin "feature/${CALLER_PARENT}-caller-verification/wave-${CALLER_WAVE}"
python3 - "$CALLER_WAVE" <<'PY'
import pathlib, sys
pathlib.Path('/tmp/caller-verification-w02-pr.md').write_text(
    'Adds console-targeted caller verification through the Go agent and Tauri helper, '
    'with principal reporting, live capability availability, and shared HTTP/WS result processing. '
    'Commands are committed before dispatch; reconciliation recovers expiry and late rejection.\n\n'
    'Readiness remains off until W05. Requires both agent and helper promotion.\n\n'
    'Validation: targeted API/helper/Go race suites, typechecks, and live transaction/RLS/cascade/export contracts. '
    'Attach the recorded platform release evidence and actual command outcomes before marking ready.\n\n'
    f'Closes #{sys.argv[1]}\n')
PY
gh pr create --base main --title "feat(caller-verification): add workstation challenge delivery" --body-file /tmp/caller-verification-w02-pr.md
```

If W01 is not merged, base the PR on its actual branch and explicitly run the CI workflow for this branch; `pull_request` CI targets main and a stacked PR can otherwise appear green without required tests. Do not merge or close issues manually.

## Self-review

**Resolved executor blocker — inherited device-move lock order:** Task 17 keeps W01 Task 13 Step 3a's single device-lock/revocation block after PAM, custom-field re-home and manual-asset detach, immediately before the device UPDATE. Checked against the current `moveOrg.ts`, `moveOrg.test.ts` recorder and PAM guard, and W01's concrete hook/test additions: statement indices 0–5 stay unchanged, the empty-grant hook occupies 6–8, and the device UPDATE is 9. Task 17 retains those exact assertions, adds single-hook count assertions, includes the test in its commit command, and runs `moveOrg.test.ts` plus `deviceMove.test.ts`; Task 18 also runs the inherited route suite. These are implementation-time checks, not tests claimed run during this document-only correction.

**Spec coverage:** Tasks 1–4 cover explicit OS login, console-only assist capability, correlated timeouts and principal reporting. Tasks 5–7 cover always-on-top branded, translated request confirmation and the exact safety line. Tasks 8–11 cover partner trust, transactional command creation, W01 outbox delivery, shared HTTP/WS decision processing and late rejection persistence. Task 12 implements all three recovery classes. Tasks 13–14 produce the `{data:[...]}` suggestions envelope with per-device readiness and exercise it through W04's real reader. Task 15 proves decision/receipt/effect rollback, mixed ready/outdated selection, replay and site isolation. Task 16 sends OS-verified login evidence through existing session reporting and tests unmatched, ambiguous and cross-org cases. Task 17 reuses W01's locked move revocation, proves refusal after a real authenticated move and preserves consumption history. Task 18 covers release checks and an open PR.

**Cross-wave compatibility:** Public signatures, table/enum exports, migration slots, command fields, stdout shape and IPC names come from the index. W01 source modules are future dependencies; its now-available plan supplies the verified `ports.ts` and `routes/callerVerification.ts` anchors. No guessed current source-line references are presented for them. `methodsForContact` keeps its four arguments and its `MethodAvailability[]` result; device-specific detail is carried by the new suggestions response. The W01 verification-row outbox (`deliveryPublishedAt`, `publishCallerVerificationEffects`) remains the owner of after-commit scheduling. W01 Task 8 Step 3b supplies `observeSessionPrincipal` in `loginObservation.ts` and the collector `principalReader`; Task 13 Step 3a supplies the positional move-hook signature. W02 reuses those additions once, with stronger transport ownership locking and live tests. W04 owns disabled unavailable suggestions and selected-device UI validation; W02 supplies and tests the readiness fields and enforces selection at start.

**Resolved source discrepancies:** `SessionForUser` prefers native user helpers; consent selection itself has a fallback, so neither is reused as the final selector. Unix `WinSessionID` is not a loginctl session id. Session username is helper supplied; detector identity and kernel SID/UID win. Rust had no capability frame, helper had no branding/i18n, and API had no capability storage. These additions are explicit. Both terminal-result prefilters discard duplicates, requiring the narrow durable rejection receipt path, not merely a new registry entry.

**Authority boundaries:** Number choices pass through W01's expiry-aware CAS. `not_me` passes from any non-rejected verification state, including revoked and consumed rows. A challenge principal is observed only after a verified choice; independently, authenticated login events and active session snapshots use W01's unique existing-directory-binding consumer. Decision and observation share any authorized ambient transaction, including org contexts; W03's replacement must preserve that rule. OS-only observations never create directory subjects. Device suggestions do not authorize or bind an identity. Device moves cannot repoint caller tables. Shared device locks serialize start/results with W01's original-org move hook, which expires pending and revokes unused verified grants under subject locks; consumed history remains unchanged. Result ownership joins reject a moved device against its former org.

**Failure and lifecycle review:** Old helpers are detected by capability, not version. Timeout never approves. Rust serializes duplicate submissions and keeps the original envelope id. A missing initial frontend event cannot lose the prompt because the window hydrates pending state. The outbox owns dispatch retry, the persisted command owns transport correlation, and reconciliation owns crash repair. The worker remains active for cleanup even when readiness is off. No request waits on the human or holds a DB transaction across relay dispatch.

**Verification limits:** This document is a plan; tests and platform releases have not been run during authoring. W01's plan defines the outbox ports and route module; their implemented source must be re-read after rebase before applying the integration fragments. The Unix UPN helper deliberately returns empty until an OS-verified provider exists; that is conservative tier behavior, not guessed identity. Coarse migration ordering is rechecked despite W02 adding no DDL. The literal migration-tail command currently returns `preflight`, so the SQL-only companion check is required.
