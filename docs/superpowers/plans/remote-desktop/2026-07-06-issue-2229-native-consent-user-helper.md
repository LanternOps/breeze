# Native Remote-Session Consent in the User-Helper (Issue #2229) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the remote-session consent dialog and active-session banner work on devices that do NOT have the Tauri Breeze Assist app installed, by rendering native OS surfaces from the Go user-helper — and fix the prompt to show the technician's MSP (partner) name instead of the client org's name ("Billy from Olive Technology connected").

**Architecture:** The consent gate (`agent/internal/heartbeat/consent_gate.go`) already routes consent/banner IPC messages to whichever helper session holds the `consent_ui` scope — today only the Tauri assist helper. We add a new `consent_ui_fallback` scope that the session broker grants to user-role helpers that advertise native consent support at auth time; the gate tries `consent_ui` first (rich Tauri dialog wins when present) then falls back. The Go user-helper gains handlers for `consent_request` / `banner_show` / `banner_hide` that mimic the Tauri helper's exact wire format: native dialogs via `MessageBoxTimeoutW` (Windows), `osascript display dialog` (macOS), `zenity` (Linux); a native Win32 topmost pill window for the banner (Windows only — macOS/Linux fallback has no persistent banner; documented limitation, the Assist app provides it there). Separately, the API's prompt block is fixed to resolve `partners.name` (the MSP) instead of `organizations.name` (the client).

**Tech Stack:** Go (pure, `CGO_ENABLED=0` — Win32 via `syscall.NewLazyDLL` only, following `pam_dialog_windows.go`), Hono + Drizzle (API), Vitest, Go `testing`.

## Global Constraints

- **No cgo.** The shipped `breeze-user-helper` is built `CGO_ENABLED=0` windows/amd64 (`.github/workflows/release.yml:377-381`); on macOS/Linux the same code runs as `breeze-agent user-helper`. All Windows UI must be raw `syscall` (see `agent/internal/userhelper/pam_dialog_windows.go` for the pattern).
- **Wire format is fixed** (mixed-fleet compatibility with the shipped Tauri helper): inbound `consent_request` (payload `ipc.ConsentRequest`) is answered with type `consent_result`, **same envelope ID** (`consent-<sessionId>`), payload `{"decision":"allow"|"deny"}`. `banner_show` (payload `ipc.BannerShowRequest`) and `banner_hide` (payload `{"sessionId":...}`) are fire-and-forget, no reply.
- **Timeout semantics mirror the Tauri dialog** (`apps/helper/src/windows/ConsentDialog.tsx:25`): when the countdown expires the helper SENDS a decision — `allow` if `onTimeout == "proceed"` else `deny`. It does not go silent.
- **Never edit shipped migrations; no DB changes are needed in this plan.**
- **Go tests:** `cd agent && go test -race ./internal/...`; always also cross-compile check: `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./...` from `agent/`.
- **Copy rules:** technician line format is `<Name> from <Partner>` (e.g. "Billy from Olive Technology"); generic identity level renders "A technician from <Partner>"; no logos/branding.
- Commit after every task. Branch: `ToddHebebrand/issue-2229-remote-session-end` (current).

---

### Task 1: API — prompt block ships the PARTNER (MSP) name, not the client org name

**Files:**
- Modify: `apps/api/src/routes/remote/sessions.ts:6-12` (imports) and `:928-938` (org lookup)
- Test: `apps/api/src/routes/remote/sessions.test.ts` (schema mock + assertion)
- Test: `apps/api/src/__tests__/integration/remote-session-consent.integration.test.ts` (partner-name assertion, real DB — run only if local Postgres is up)

**Interfaces:**
- Produces: the `prompt.technicianDisplay.orgName` field in the desktop-start payload now carries `partners.name`. No shape change — consumers (agent `ipc.DesktopPrompt.OrgName`, Tauri dialog) are untouched.

**Context:** `agent/internal/ipc/message.go:433` documents `OrgName` as "the partner/MSP organisation name shown in dialogs", but `sessions.ts` populates it from `organizations.name` for `device.orgId` — the CLIENT company. An end user at Acme Dental currently sees "Billy from Acme Dental", which defeats the trust signal.

- [ ] **Step 1: Write the failing unit test**

In `apps/api/src/routes/remote/sessions.test.ts`: the file mocks `../../db/schema` with a partial table map (line ~77) and mocks `buildTechnicianDisplay` from `./helpers` (line ~139). Add `partners` to the schema mock:

```ts
  organizations: { id: 'organizations.id', name: 'organizations.name', partnerId: 'organizations.partnerId' },
  partners: { id: 'partners.id', name: 'partners.name' },
```

Then find the existing test that drives the desktop-start path with a prompt config (the one that exercises `resolveRemoteSessionPromptConfig` — it's mocked; search for `resolveRemoteSessionPromptConfig` in the file and follow the existing arrangement). Extend/add a test asserting `buildTechnicianDisplay` receives the partner name as its 4th argument. Follow the file's existing db-mock chain style (the select-chain mock in the same file shows how rows are queued):

```ts
it('feeds the PARTNER (MSP) name into technicianDisplay, not the client org name', async () => {
  // arrange: db mock returns tech row for users query, then a partner-name row
  // for the org→partner join (queue rows exactly like the neighbouring tests do)
  // ... existing arrangement code ...
  expect(vi.mocked(buildTechnicianDisplay)).toHaveBeenCalledWith(
    expect.anything(),        // identityLevel
    expect.anything(),        // tech name
    expect.anything(),        // tech email
    'Olive Technology',       // partner name — NOT the org name
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run src/routes/remote/sessions.test.ts -t 'PARTNER'`
Expected: FAIL — called with the org name (or the mock chain returns the org row).

- [ ] **Step 3: Implement the fix**

In `apps/api/src/routes/remote/sessions.ts` add `partners` to the schema import block (lines 6–12):

```ts
import {
  remoteSessions,
  devices,
  deviceHardware,
  users,
  organizations,
  partners
} from '../../db/schema';
```

Replace the org-name query (currently lines ~928–932):

```ts
      // The dialog shows who the technician WORKS FOR — the MSP (partner) —
      // not the client org the device belongs to. Showing the client's own
      // company name is what a social engineer would claim anyway.
      const [partnerRow] = await db
        .select({ name: partners.name })
        .from(organizations)
        .innerJoin(partners, eq(organizations.partnerId, partners.id))
        .where(eq(organizations.id, device.orgId))
        .limit(1);
      const technicianDisplay = buildTechnicianDisplay(
        promptCfg.identityLevel,
        tech?.name ?? null,
        tech?.email ?? null,
        partnerRow?.name ?? null,
      );
```

(Keep the `users` query as-is; only the second query changes. Verify the actual FK column name on `organizations` — it is `partnerId` per the dual-axis schema.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/api && npx vitest run src/routes/remote/sessions.test.ts`
Expected: PASS (whole file — no regressions in neighbouring session tests).

- [ ] **Step 5: Update the integration test**

In `apps/api/src/__tests__/integration/remote-session-consent.integration.test.ts`, find where the prompt block / `technicianDisplay` is asserted (or where fixture org+partner are created) and assert `orgName` equals the seeded **partner** name. If the local integration DB (`:5433`) isn't running, note it in the commit body and rely on CI's smoke job.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/remote/sessions.ts apps/api/src/routes/remote/sessions.test.ts apps/api/src/__tests__/integration/remote-session-consent.integration.test.ts
git commit -m "fix(remote): consent prompt shows partner (MSP) name, not client org name

The IPC contract (DesktopPrompt.OrgName) documents the partner/MSP name but
sessions.ts shipped organizations.name for the device org — the end user's
own company. Refs #2229"
```

---

### Task 2: Agent — "Billy from Olive Technology" wording in notify body and banner label

**Files:**
- Modify: `agent/internal/heartbeat/consent_gate.go:246-258` (`connectedNotifyBody`, `bannerLabel`)
- Test: `agent/internal/heartbeat/consent_test.go` (add table-driven tests)

**Interfaces:**
- Produces: `connectedNotifyBody(prompt *ipc.DesktopPrompt) string`, `bannerLabel(prompt *ipc.DesktopPrompt) string` — same signatures, new copy. Task 5's dialog text builder uses the same copy rules but lives in `userhelper` (helper side receives `ipc.ConsentRequest`, not the prompt).

- [ ] **Step 1: Write the failing tests**

Append to `agent/internal/heartbeat/consent_test.go`:

```go
func TestConnectedNotifyBody(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	tests := []struct {
		name   string
		prompt *ipc.DesktopPrompt
		want   string
	}{
		{"name and partner", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy"), OrgName: strPtr("Olive Technology")}, "Billy from Olive Technology connected to your computer"},
		{"name only", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy")}, "Billy connected to your computer"},
		{"partner only (generic identity)", &ipc.DesktopPrompt{OrgName: strPtr("Olive Technology")}, "A technician from Olive Technology connected to your computer"},
		{"neither", &ipc.DesktopPrompt{}, "A technician connected to your computer"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := connectedNotifyBody(tt.prompt); got != tt.want {
				t.Errorf("connectedNotifyBody() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestBannerLabel(t *testing.T) {
	strPtr := func(s string) *string { return &s }
	tests := []struct {
		name   string
		prompt *ipc.DesktopPrompt
		want   string
	}{
		{"name and partner", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy"), OrgName: strPtr("Olive Technology")}, "Billy from Olive Technology is connected"},
		{"name only", &ipc.DesktopPrompt{TechnicianName: strPtr("Billy")}, "Billy is connected"},
		{"partner only", &ipc.DesktopPrompt{OrgName: strPtr("Olive Technology")}, "A technician from Olive Technology is connected"},
		{"neither", &ipc.DesktopPrompt{}, "A technician is connected"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := bannerLabel(tt.prompt); got != tt.want {
				t.Errorf("bannerLabel() = %q, want %q", got, tt.want)
			}
		})
	}
}
```

Add `"github.com/breeze-rmm/agent/internal/ipc"` to the test file's imports if not present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/heartbeat/ -run 'TestConnectedNotifyBody|TestBannerLabel' -v`
Expected: FAIL — current copy omits "from <org>".

- [ ] **Step 3: Implement**

Replace both helpers in `agent/internal/heartbeat/consent_gate.go`:

```go
func connectedNotifyBody(prompt *ipc.DesktopPrompt) string {
	return technicianLine(prompt) + " connected to your computer"
}

func bannerLabel(prompt *ipc.DesktopPrompt) string {
	return technicianLine(prompt) + " is connected"
}

// technicianLine renders the who-is-this prefix: "Billy from Olive Technology",
// "Billy", "A technician from Olive Technology", or "A technician". The partner
// name is the trust anchor for the end user, so it is kept even when the
// identity level redacts the technician's name.
func technicianLine(prompt *ipc.DesktopPrompt) string {
	name := derefString(prompt.TechnicianName)
	org := derefString(prompt.OrgName)
	switch {
	case name != "" && org != "":
		return name + " from " + org
	case name != "":
		return name
	case org != "":
		return "A technician from " + org
	default:
		return "A technician"
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/heartbeat/`
Expected: PASS (whole package — the existing consent-gate tests must not regress).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/consent_gate.go agent/internal/heartbeat/consent_test.go
git commit -m "feat(agent): session notices read 'Billy from <Partner> connected'

Keeps the partner name even at generic identity level - the MSP name is the
end user's trust anchor. Refs #2229"
```

---

### Task 3: IPC + broker — `consent_ui_fallback` scope, granted to user-helpers that advertise support

**Files:**
- Modify: `agent/internal/ipc/message.go:129-134` (scope consts), `:154-167` (`AuthRequest`)
- Create: `agent/internal/userhelper/consent_supported.go`, `consent_supported_linux.go`
- Modify: `agent/internal/userhelper/client.go` (`authenticate()`, the `ipc.AuthRequest` literal at ~line 214)
- Modify: `agent/internal/sessionbroker/broker.go:1534` (scope grant after `scopesForRole`)
- Test: `agent/internal/sessionbroker/broker_test.go`

**Interfaces:**
- Produces: `ipc.ScopeConsentUIFallback = "consent_ui_fallback"`; `ipc.AuthRequest.SupportsConsentUI bool` (JSON `supportsConsentUi`, omitempty — additive, old brokers ignore it, old helpers send false); `userhelper.consentUISupported() bool`.
- Consumed by: Task 4 (gate lookup), Task 5 (dispatch is only reachable when the scope was granted).

**Design note (mixed fleet):** granting the scope unconditionally would let a NEW agent send `consent_request` to an OLD user-helper that logs "unknown message type" and never replies — a 32s stall, and a block under `consent_unavailable_behavior: block`. The advertise-flag makes the grant exact: old helpers never advertise, so they keep today's `helper_absent` semantics. On macOS/Linux the user-helper is the agent binary itself, so skew is impossible there.

- [ ] **Step 1: Write the failing broker test**

Append to `agent/internal/sessionbroker/broker_test.go` (follow the file's existing auth-flow test helpers — there are existing tests that drive `scopesForRole`/auth and assert `AllowedScopes`; mirror the closest one):

```go
func TestConsentUIFallbackScopeGrant(t *testing.T) {
	b := &Broker{}
	tests := []struct {
		name             string
		role             string
		supportsConsent  bool
		wantFallback     bool
	}{
		{"user role advertising support", ipc.HelperRoleUser, true, true},
		{"user role not advertising", ipc.HelperRoleUser, false, false},
		{"system role advertising", ipc.HelperRoleSystem, true, false},
		{"assist role advertising", ipc.HelperRoleAssist, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scopes := b.grantScopes(tt.role, ipc.AuthRequest{
				BinaryKind:        ipc.HelperBinaryUserHelper,
				SupportsConsentUI: tt.supportsConsent,
			}, runtime.GOOS, "")
			got := false
			for _, s := range scopes {
				if s == ipc.ScopeConsentUIFallback {
					got = true
				}
			}
			if got != tt.wantFallback {
				t.Errorf("fallback scope granted = %v, want %v (scopes: %v)", got, tt.wantFallback, scopes)
			}
		})
	}
}

func TestConsentUIFallbackGrantDoesNotMutateSharedScopeSlices(t *testing.T) {
	b := &Broker{}
	before := len(userHelperScopes)
	_ = b.grantScopes(ipc.HelperRoleUser, ipc.AuthRequest{BinaryKind: ipc.HelperBinaryUserHelper, SupportsConsentUI: true}, runtime.GOOS, "")
	if len(userHelperScopes) != before {
		t.Fatalf("userHelperScopes mutated: len %d -> %d", before, len(userHelperScopes))
	}
	for _, s := range userHelperScopes {
		if s == ipc.ScopeConsentUIFallback {
			t.Fatal("shared userHelperScopes slice now contains the fallback scope")
		}
	}
}
```

(If `broker_test.go` has no exported-ish seam like this, introduce `grantScopes` in Step 3 exactly as specified — the test defines the seam.)

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestConsentUIFallback -v`
Expected: compile FAIL — `grantScopes`, `ScopeConsentUIFallback`, `SupportsConsentUI` undefined.

- [ ] **Step 3: Implement IPC constants + AuthRequest field**

`agent/internal/ipc/message.go` — extend the scope const block (lines 129-134):

```go
	// ScopeConsentUIFallback lets a user-role helper that advertised native
	// consent-dialog support (AuthRequest.SupportsConsentUI) receive the
	// remote-session consent prompt + banner messages when no assist helper
	// (ScopeConsentUI) is connected. Granted only on explicit advertisement so
	// older helpers keep helper_absent semantics instead of timing out.
	ScopeConsentUIFallback = "consent_ui_fallback"
```

Add to `AuthRequest` (after `DesktopContext`):

```go
	// SupportsConsentUI advertises that this helper can natively render the
	// remote-session consent dialog (consent_request) and banner messages.
	// Drives the consent_ui_fallback scope grant. Additive: absent/false on
	// older helpers.
	SupportsConsentUI bool `json:"supportsConsentUi,omitempty"`
```

- [ ] **Step 4: Implement the broker grant**

In `agent/internal/sessionbroker/broker.go`, add next to `scopesForRole` (line ~1860):

```go
// grantScopes computes the final AllowedScopes for an authenticated helper:
// the role's base scopes plus consent_ui_fallback when a user-role helper
// advertised native consent support. Always returns a fresh slice — the
// role-scope vars are shared package state and must not be appended to.
func (b *Broker) grantScopes(role string, authReq ipc.AuthRequest, goos, peerPath string) []string {
	base := b.scopesForRole(role, authReq.BinaryKind, goos, peerPath)
	scopes := make([]string, len(base), len(base)+1)
	copy(scopes, base)
	if role == ipc.HelperRoleUser && authReq.SupportsConsentUI {
		scopes = append(scopes, ipc.ScopeConsentUIFallback)
	}
	return scopes
}
```

At the call site (line ~1534) replace:

```go
	scopes := b.scopesForRole(helperRole, authReq.BinaryKind, runtime.GOOS, creds.BinaryPath)
```

with:

```go
	scopes := b.grantScopes(helperRole, authReq, runtime.GOOS, creds.BinaryPath)
```

- [ ] **Step 5: Implement `consentUISupported()` + advertise it at auth**

Create `agent/internal/userhelper/consent_supported.go`:

```go
//go:build !linux

package userhelper

// consentUISupported reports whether this platform can natively render the
// remote-session consent dialog. Windows uses MessageBoxTimeoutW and macOS
// uses osascript — both always present.
func consentUISupported() bool { return true }
```

Create `agent/internal/userhelper/consent_supported_linux.go`:

```go
//go:build linux

package userhelper

import "os/exec"

// consentUISupported reports whether this platform can natively render the
// remote-session consent dialog. On Linux the dialog uses zenity; without it
// (headless servers, minimal desktops) we do not advertise support so the
// agent's consent gate keeps helper_absent semantics instead of failing
// closed on a broken dialog.
func consentUISupported() bool {
	_, err := exec.LookPath("zenity")
	return err == nil
}
```

In `agent/internal/userhelper/client.go`, `authenticate()`, add to the `ipc.AuthRequest` literal (after `DesktopContext: c.context,`):

```go
		SupportsConsentUI: consentUISupported(),
```

- [ ] **Step 6: Run tests + cross-compile check**

Run: `cd agent && go test -race ./internal/sessionbroker/ ./internal/userhelper/ ./internal/ipc/ && GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./... && GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./...`
Expected: PASS, both builds clean.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/ipc/message.go agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_test.go agent/internal/userhelper/consent_supported.go agent/internal/userhelper/consent_supported_linux.go agent/internal/userhelper/client.go
git commit -m "feat(agent): consent_ui_fallback scope for user-helpers advertising native consent

User-role helpers that set AuthRequest.supportsConsentUi get the new scope;
advertise-gated so old helpers keep helper_absent semantics instead of
timing out on unknown message types. Refs #2229"
```

---

### Task 4: Consent gate — fall back to `consent_ui_fallback` when no assist helper is connected

**Files:**
- Modify: `agent/internal/heartbeat/consent_gate.go` (`requestConsent:86`, `sendBannerShow:174`, `sendBannerHide:194`)
- Test: `agent/internal/heartbeat/handlers_desktop_consent_test.go` (extend the existing fake broker)

**Interfaces:**
- Consumes: `ipc.ScopeConsentUIFallback` (Task 3).
- Produces: `(h *Heartbeat) consentUISession()` returning the same type `PreferredSessionWithScope` returns on `h.sessionBroker` (check the interface/struct type used by the fake in `handlers_desktop_consent_test.go` and match it).

- [ ] **Step 1: Write the failing tests**

`handlers_desktop_consent_test.go` uses REAL brokers over socket pairs — `sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "<id>", []string{"consent_ui"})` + `newTestBrokerWithSessions(t, session)` (see `TestConsentGate_UserDenies_EndToEnd` at line ~136 for the full arrangement including the helper-reply goroutine). Add two tests, cloning that arrangement:

```go
// TestConsentGate_FallbackScope_EndToEnd: a user-helper holding ONLY the
// consent_ui_fallback scope answers the consent prompt when no assist helper
// is connected. Clone TestConsentGate_UserDenies_EndToEnd wholesale, with two
// changes: the session's scopes are []string{"consent_ui_fallback"}, and the
// helper goroutine replies {"decision":"allow"} — then assert the session
// STARTS (assertNotConsentDenied) instead of denying.
func TestConsentGate_FallbackScope_EndToEnd(t *testing.T) {
	serverConn, clientConn := createTestSocketPair(t)
	serverIPC := ipc.NewConn(serverConn)
	clientIPC := ipc.NewConn(clientConn)

	session := sessionbroker.NewSession(serverIPC, 1000, "1000", "alice", "quartz", "helper-fallback", []string{ipc.ScopeConsentUIFallback})
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	done := make(chan struct{})
	go func() {
		defer close(done)
		clientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			t.Errorf("helper recv: %v", err)
			return
		}
		if env.Type != ipc.TypeConsentRequest {
			t.Errorf("expected %q envelope, got %q", ipc.TypeConsentRequest, env.Type)
		}
		payload, _ := json.Marshal(ipc.ConsentResult{Decision: "allow"})
		if err := clientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeConsentResult, Payload: payload}); err != nil {
			t.Errorf("helper send: %v", err)
		}
	}()

	broker := newTestBrokerWithSessions(t, session)
	h := &Heartbeat{sessionBroker: broker, desktopMgr: desktop.NewSessionManager()}

	result := handleStartDesktop(h, startDesktopCmd("sess-fallback", consentModePrompt("block", 5000)))

	<-done
	_ = session.Close()
	_ = clientIPC.Close()

	assertNotConsentDenied(t, result)
}

// TestConsentGate_AssistHelperPreferredOverFallback: when BOTH an assist
// helper (consent_ui) and a fallback user-helper (consent_ui_fallback) are
// connected, the consent request goes to the assist helper. The fallback
// client never receives an envelope (its Recv sees only the socket closing).
func TestConsentGate_AssistHelperPreferredOverFallback(t *testing.T) {
	assistServer, assistClient := createTestSocketPair(t)
	fallbackServer, fallbackClient := createTestSocketPair(t)
	assistIPC, fallbackIPC := ipc.NewConn(assistServer), ipc.NewConn(fallbackServer)
	assistClientIPC, fallbackClientIPC := ipc.NewConn(assistClient), ipc.NewConn(fallbackClient)

	assistSession := sessionbroker.NewSession(assistIPC, 1000, "1000", "alice", "quartz", "helper-assist", []string{"consent_ui"})
	fallbackSession := sessionbroker.NewSession(fallbackIPC, 1000, "1000", "alice", "quartz", "helper-native", []string{ipc.ScopeConsentUIFallback})
	go assistSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go fallbackSession.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})

	fallbackGotEnvelope := make(chan string, 1)
	go func() {
		fallbackClientIPC.SetReadDeadline(time.Now().Add(3 * time.Second))
		if env, err := fallbackClientIPC.Recv(); err == nil {
			fallbackGotEnvelope <- env.Type
		}
		close(fallbackGotEnvelope)
	}()

	done := make(chan struct{})
	go func() {
		defer close(done)
		assistClientIPC.SetReadDeadline(time.Now().Add(5 * time.Second))
		env, err := assistClientIPC.Recv()
		if err != nil {
			t.Errorf("assist helper recv: %v", err)
			return
		}
		if env.Type != ipc.TypeConsentRequest {
			t.Errorf("expected %q envelope, got %q", ipc.TypeConsentRequest, env.Type)
		}
		payload, _ := json.Marshal(ipc.ConsentResult{Decision: "deny"})
		if err := assistClientIPC.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeConsentResult, Payload: payload}); err != nil {
			t.Errorf("assist helper send: %v", err)
		}
	}()

	broker := newTestBrokerWithSessions(t, assistSession, fallbackSession)
	h := &Heartbeat{sessionBroker: broker, desktopMgr: desktop.NewSessionManager()}

	result := handleStartDesktop(h, startDesktopCmd("sess-prefer-assist", consentModePrompt("block", 5000)))

	<-done
	_ = assistSession.Close()
	_ = fallbackSession.Close()
	_ = assistClientIPC.Close()
	_ = fallbackClientIPC.Close()

	assertConsentDenied(t, result, "user")
	if typ, ok := <-fallbackGotEnvelope; ok {
		t.Errorf("fallback helper must not receive envelopes when assist helper is connected, got %q", typ)
	}
}
```

(Verify `newTestBrokerWithSessions` is variadic — the existing helper takes `(t, session)`; if it accepts only one session, extend it variadically, it's a test helper in this file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestRequestConsent -v`
Expected: FAIL — fallback scope is never queried.

- [ ] **Step 3: Implement**

In `agent/internal/heartbeat/consent_gate.go`, add (typed to match `h.sessionBroker`'s return type):

```go
// consentUISession returns the best helper session able to render consent UI:
// the Tauri assist helper (rich branded dialog) when connected, else a
// user-helper that advertised native fallback dialogs at auth.
func (h *Heartbeat) consentUISession() *sessionbroker.Session {
	if s := h.sessionBroker.PreferredSessionWithScope("consent_ui"); s != nil {
		return s
	}
	return h.sessionBroker.PreferredSessionWithScope(ipc.ScopeConsentUIFallback)
}
```

Replace the three lookups:
- `requestConsent` line 86: `session := h.consentUISession()`
- `sendBannerShow` line 174: `session := h.consentUISession()` (update the log message to "no consent-ui-capable helper for session banner")
- `sendBannerHide` line 194: `session := h.consentUISession()`

(`sendSessionNotify` keeps scope `"notify"` — unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test -race ./internal/heartbeat/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/heartbeat/consent_gate.go agent/internal/heartbeat/handlers_desktop_consent_test.go
git commit -m "feat(agent): consent gate falls back to native user-helper when Assist app absent

Assist helper (consent_ui) still wins when connected. Refs #2229"
```

---

### Task 5: User-helper — `consent_request` handler (dispatch, sanitize, timeout mapping, reply)

**Files:**
- Create: `agent/internal/userhelper/consent.go`
- Modify: `agent/internal/userhelper/client.go` (`commandLoop` switch, line ~360)
- Test: `agent/internal/userhelper/consent_test.go`

**Interfaces:**
- Consumes: `ipc.ConsentRequest`, `ipc.ConsentResult`, `ipc.TypeConsentRequest`/`ipc.TypeConsentResult`, `trimNotifyField` (from `notify_common.go`).
- Produces: `showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool)` — the platform seam Task 6 implements; `buildConsentDialogText(req ipc.ConsentRequest) (title, body string)`; package var `showConsentDialogFn` for test injection (the clipboard `Provider` pattern's cheaper cousin — matches how `client_test.go` injects `c.scopes` directly).

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/userhelper/consent_test.go`:

```go
package userhelper

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestBuildConsentDialogText(t *testing.T) {
	tests := []struct {
		name     string
		req      ipc.ConsentRequest
		wantBody []string // substrings that must appear
		notBody  []string // substrings that must NOT appear
	}{
		{
			"full identity",
			ipc.ConsentRequest{TechnicianName: "Billy", TechnicianEmail: "billy@example.com", OrgName: "Olive Technology"},
			[]string{"Billy (billy@example.com) from Olive Technology", "requesting remote access"},
			nil,
		},
		{
			"name only",
			ipc.ConsentRequest{TechnicianName: "Billy"},
			[]string{"Billy is requesting remote access"},
			[]string{"()", " from "},
		},
		{
			"generic with partner",
			ipc.ConsentRequest{OrgName: "Olive Technology"},
			[]string{"A technician from Olive Technology is requesting remote access"},
			nil,
		},
		{
			"fully generic",
			ipc.ConsentRequest{},
			[]string{"A technician is requesting remote access"},
			nil,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			title, body := buildConsentDialogText(tt.req)
			if title != "Remote Support Request" {
				t.Errorf("title = %q", title)
			}
			for _, want := range tt.wantBody {
				if !strings.Contains(body, want) {
					t.Errorf("body %q missing %q", body, want)
				}
			}
			for _, not := range tt.notBody {
				if strings.Contains(body, not) {
					t.Errorf("body %q must not contain %q", body, not)
				}
			}
		})
	}
}

func TestSanitizeConsentRequest(t *testing.T) {
	long := strings.Repeat("x", 5000)
	req := sanitizeConsentRequest(ipc.ConsentRequest{
		TechnicianName: "  Billy\x00 ", TechnicianEmail: long, OrgName: long,
		TimeoutMs: 99_999_999, OnTimeout: "PROCEED",
	})
	if strings.ContainsAny(req.TechnicianName, "\x00") || req.TechnicianName != "Billy" {
		t.Errorf("name not sanitized: %q", req.TechnicianName)
	}
	if len(req.TechnicianEmail) > maxNotifyTitleBytes || len(req.OrgName) > maxNotifyTitleBytes {
		t.Error("email/org not truncated")
	}
	if req.TimeoutMs != maxConsentTimeoutMs {
		t.Errorf("timeout not clamped: %d", req.TimeoutMs)
	}
	if req.OnTimeout != "proceed" {
		t.Errorf("onTimeout not normalized: %q", req.OnTimeout)
	}
}

func TestConsentDecisionMapping(t *testing.T) {
	tests := []struct {
		name      string
		allow     bool
		answered  bool
		onTimeout string
		want      string
	}{
		{"user allowed", true, true, "block", "allow"},
		{"user denied", false, true, "proceed", "deny"},
		{"timeout with proceed", false, false, "proceed", "allow"}, // mirrors Tauri ConsentDialog.tsx
		{"timeout with block", false, false, "block", "deny"},
		{"timeout with unknown behavior fails closed", false, false, "", "deny"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := consentDecision(tt.allow, tt.answered, tt.onTimeout); got != tt.want {
				t.Errorf("consentDecision() = %q, want %q", got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cd agent && go test -race ./internal/userhelper/ -run 'TestBuildConsentDialogText|TestSanitizeConsentRequest|TestConsentDecisionMapping' -v`
Expected: compile FAIL.

- [ ] **Step 3: Implement `consent.go`**

Create `agent/internal/userhelper/consent.go`:

```go
package userhelper

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// maxConsentTimeoutMs caps the dialog countdown at 10 minutes; the API sends
// 30s today, the cap only guards against a hostile/buggy daemon payload.
const maxConsentTimeoutMs = 600_000

// showConsentDialogFn is the platform dialog seam; tests swap it for a fake.
// It blocks until the user answers or the countdown expires.
// answered=false means the countdown expired with no user decision.
var showConsentDialogFn = showConsentDialogOS

// handleConsentRequest renders the native consent dialog and replies with a
// consent_result on the same envelope ID — the exact wire contract the Tauri
// assist helper implements (apps/helper/src-tauri/src/ipc/client.rs).
func (c *Client) handleConsentRequest(env *ipc.Envelope) {
	var req ipc.ConsentRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid consent_request payload", "error", err)
		if sendErr := c.conn.SendError(env.ID, ipc.TypeConsentResult, fmt.Sprintf("invalid payload: %v", err)); sendErr != nil {
			log.Warn("failed to send consent error", "error", sendErr)
		}
		return
	}
	req = sanitizeConsentRequest(req)
	allow, answered := showConsentDialogFn(req)
	decision := consentDecision(allow, answered, req.OnTimeout)
	log.Info("consent dialog decided", "sessionId", req.SessionID, "decision", decision, "answered", answered)
	if err := c.conn.SendTyped(env.ID, ipc.TypeConsentResult, ipc.ConsentResult{Decision: decision}); err != nil {
		log.Warn("failed to send consent result", "id", env.ID, "error", err)
	}
}

// consentDecision maps the dialog outcome to the wire decision. On countdown
// expiry the helper SENDS the policy verdict rather than going silent —
// mirroring the Tauri dialog (ConsentDialog.tsx: onDecision(onTimeout ===
// "proceed", "timeout")). Unknown onTimeout fails closed.
func consentDecision(allow, answered bool, onTimeout string) string {
	if answered {
		if allow {
			return "allow"
		}
		return "deny"
	}
	if onTimeout == "proceed" {
		return "allow"
	}
	return "deny"
}

func sanitizeConsentRequest(req ipc.ConsentRequest) ipc.ConsentRequest {
	req.TechnicianName = stripControl(trimNotifyField(req.TechnicianName, maxNotifyTitleBytes))
	req.TechnicianEmail = stripControl(trimNotifyField(req.TechnicianEmail, maxNotifyTitleBytes))
	req.OrgName = stripControl(trimNotifyField(req.OrgName, maxNotifyTitleBytes))
	req.OnTimeout = strings.ToLower(strings.TrimSpace(req.OnTimeout))
	if req.TimeoutMs < 0 {
		req.TimeoutMs = 0
	}
	if req.TimeoutMs > maxConsentTimeoutMs {
		req.TimeoutMs = maxConsentTimeoutMs
	}
	return req
}

func stripControl(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

// buildConsentDialogText renders the platform-neutral dialog copy.
// Examples: "Billy (billy@example.com) from Olive Technology is requesting
// remote access to view and control this computer."
func buildConsentDialogText(req ipc.ConsentRequest) (title, body string) {
	who := "A technician"
	if req.TechnicianName != "" {
		who = req.TechnicianName
		if req.TechnicianEmail != "" {
			who += " (" + req.TechnicianEmail + ")"
		}
	}
	if req.OrgName != "" {
		who += " from " + req.OrgName
	}
	return "Remote Support Request", who + " is requesting remote access to view and control this computer."
}
```

- [ ] **Step 4: Wire the dispatch case**

In `agent/internal/userhelper/client.go` `commandLoop()`, after the `ipc.TypePamRequestDialog` case:

```go
		case ipc.TypeConsentRequest:
			safeGo("consent_request", func() { c.handleConsentRequest(env) })
```

- [ ] **Step 5: Add a handler-level test with an injected dialog**

Append to `consent_test.go` (mirror how `client_test.go` constructs clients without a live conn — if `c.conn` is nil in that pattern, test via the exported seam instead: assert `consentDecision` + `sanitizeConsentRequest` compose; the full IPC round-trip is covered by the gate tests in Task 4):

```go
func TestShowConsentDialogFnInjectable(t *testing.T) {
	orig := showConsentDialogFn
	defer func() { showConsentDialogFn = orig }()
	called := false
	showConsentDialogFn = func(req ipc.ConsentRequest) (bool, bool) {
		called = true
		return true, true
	}
	allow, answered := showConsentDialogFn(ipc.ConsentRequest{})
	if !called || !allow || !answered {
		t.Fatal("injection seam broken")
	}
}
```

- [ ] **Step 6: Run tests + cross-compile (will fail until Task 6 provides `showConsentDialogOS` — so create temporary stubs NOW if you want green here, or do Tasks 5+6 in one commit; RECOMMENDED: proceed straight to Task 6 and run/commit both together)**

- [ ] **Step 7: (joint commit happens at end of Task 6)**

---

### Task 6: Platform consent dialogs — Windows `MessageBoxTimeoutW`, macOS `osascript`, Linux `zenity`

**Files:**
- Create: `agent/internal/userhelper/consent_dialog_windows.go`
- Create: `agent/internal/userhelper/consent_dialog_darwin.go`
- Create: `agent/internal/userhelper/consent_dialog_linux.go`

**Interfaces:**
- Produces: `showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool)` per platform (consumed via `showConsentDialogFn`, Task 5).

- [ ] **Step 1: Windows implementation**

Create `agent/internal/userhelper/consent_dialog_windows.go`:

```go
//go:build windows

package userhelper

import (
	"syscall"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/ipc"
)

var procMessageBoxTimeoutW = pamDialogUser32.NewProc("MessageBoxTimeoutW")

const (
	consentMBYesNo         = 0x00000004
	consentMBIconQuestion  = 0x00000020
	consentMBSystemModal   = 0x00001000
	consentMBSetForeground = 0x00010000
	consentMBTopMost       = 0x00040000

	consentIDYes     = 6
	consentIDNo      = 7
	consentIDTimeout = 32000 // MessageBoxTimeoutW's timeout return value

	consentInfiniteMs = 0xFFFFFFFF
)

// showConsentDialogOS renders a native Yes/No prompt via MessageBoxTimeoutW
// (undocumented-but-stable user32 export; used because MessageBoxW has no
// countdown). Yes=Allow, No=Deny; the timeout return maps to answered=false
// and consentDecision applies the onTimeout policy — mirroring the Tauri
// dialog's auto-decide countdown.
func showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool) {
	titleStr, bodyStr := buildConsentDialogText(req)
	bodyStr += "\r\n\r\nSelect Yes to allow, or No to decline."
	title, err := syscall.UTF16PtrFromString(titleStr)
	if err != nil {
		return false, true // treat as an explicit deny; never crash the helper on bad input
	}
	body, err := syscall.UTF16PtrFromString(bodyStr)
	if err != nil {
		return false, true
	}
	timeoutMs := uintptr(consentInfiniteMs)
	if req.TimeoutMs > 0 {
		timeoutMs = uintptr(req.TimeoutMs)
	}
	flags := uintptr(consentMBYesNo | consentMBIconQuestion | consentMBTopMost | consentMBSystemModal | consentMBSetForeground)
	ret, _, _ := procMessageBoxTimeoutW.Call(
		0,
		uintptr(unsafe.Pointer(body)),
		uintptr(unsafe.Pointer(title)),
		flags,
		0, // language id
		timeoutMs,
	)
	switch ret {
	case consentIDYes:
		return true, true
	case consentIDTimeout:
		return false, false
	default: // IDNO, dialog dismissed, or call failure (ret 0)
		return false, true
	}
}
```

(`pamDialogUser32` is the existing `user32.dll` lazy handle from `pam_dialog_windows.go` — same package, reuse it.)

- [ ] **Step 2: macOS implementation**

Create `agent/internal/userhelper/consent_dialog_darwin.go`:

```go
//go:build darwin

package userhelper

import (
	"fmt"
	"os/exec"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showConsentDialogOS renders the consent prompt via osascript, the same
// no-cgo technique notify_darwin.go uses. "giving up after N" implements the
// countdown; a gave-up result maps to answered=false so consentDecision
// applies the onTimeout policy.
func showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool) {
	title, body := buildConsentDialogText(req)
	script := fmt.Sprintf(
		`display dialog "%s" with title "%s" buttons {"Deny", "Allow"} default button "Allow" cancel button "Deny" with icon caution`,
		escapeAppleScript(body), escapeAppleScript(title),
	)
	if req.TimeoutMs > 0 {
		script += fmt.Sprintf(" giving up after %d", (req.TimeoutMs+999)/1000)
	}
	out, err := exec.Command("osascript", "-e", script).Output()
	if err != nil {
		// Cancel button (Deny) makes osascript exit non-zero (user canceled -128).
		return false, true
	}
	result := string(out)
	if strings.Contains(result, "gave up:true") {
		return false, false
	}
	return strings.Contains(result, "button returned:Allow"), true
}
```

(`escapeAppleScript` already exists in `notify_darwin.go` — same package.)

- [ ] **Step 3: Linux implementation**

Create `agent/internal/userhelper/consent_dialog_linux.go`:

```go
//go:build linux

package userhelper

import (
	"fmt"
	"os/exec"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// showConsentDialogOS renders the consent prompt via zenity (presence was
// verified by consentUISupported before the fallback scope was granted).
// zenity exit codes: 0=OK(Allow), 1=Cancel(Deny), 5=timeout.
func showConsentDialogOS(req ipc.ConsentRequest) (allow bool, answered bool) {
	title, body := buildConsentDialogText(req)
	args := []string{
		"--question",
		"--title", title,
		"--text", body,
		"--ok-label", "Allow",
		"--cancel-label", "Deny",
	}
	if req.TimeoutMs > 0 {
		args = append(args, fmt.Sprintf("--timeout=%d", (req.TimeoutMs+999)/1000))
	}
	err := exec.Command("zenity", args...).Run()
	if err == nil {
		return true, true
	}
	if exitErr, ok := err.(*exec.ExitError); ok {
		switch exitErr.ExitCode() {
		case 1:
			return false, true // Deny
		case 5:
			return false, false // timeout
		}
	}
	// zenity missing/crashed: deny explicitly rather than pretend a timeout.
	return false, true
}
```

Note: zenity args are passed as an argv slice (no shell), so the sanitized-but-attacker-influenced technician strings cannot inject options — but prefix `--text` values are still argv-safe because they follow their flag. Body strings can't start with `-` in practice ("A technician…"/name), and `sanitizeConsentRequest` strips control chars.

- [ ] **Step 4: Run everything from Tasks 5+6 together**

Run:
```bash
cd agent && go test -race ./internal/userhelper/ && \
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./... && \
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./... && \
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build ./...
```
Expected: tests PASS, all three cross-compiles clean.

- [ ] **Step 5: Commit (Tasks 5+6 together)**

```bash
git add agent/internal/userhelper/consent.go agent/internal/userhelper/consent_test.go agent/internal/userhelper/consent_dialog_windows.go agent/internal/userhelper/consent_dialog_darwin.go agent/internal/userhelper/consent_dialog_linux.go agent/internal/userhelper/client.go
git commit -m "feat(agent): native consent dialog in the user-helper (no Assist app needed)

MessageBoxTimeoutW on Windows, osascript on macOS, zenity on Linux. Same
wire contract as the Tauri assist helper incl. timeout auto-decision.
Refs #2229"
```

---

### Task 7: User-helper — banner handlers + native Windows topmost pill

**Files:**
- Create: `agent/internal/userhelper/banner.go` (dispatch handlers, session tracking)
- Create: `agent/internal/userhelper/banner_windows.go` (real window)
- Create: `agent/internal/userhelper/banner_other.go` (stub)
- Modify: `agent/internal/userhelper/client.go` (`commandLoop` switch)
- Test: `agent/internal/userhelper/banner_test.go`

**Interfaces:**
- Consumes: `ipc.BannerShowRequest`, `ipc.TypeBannerShow`, `ipc.TypeBannerHide`.
- Produces: `showBannerOS(label string) bool`, `hideBannerOS()` per platform.

**Design:** one banner window at a time (concurrent remote sessions to one device share the surface; last `banner_show` wins the label, and `banner_hide` for a stale session ID is ignored). macOS/Linux stubs return false → no persistent indicator without the Assist app there (documented limitation — the consent dialog + notify toasts still work; do NOT substitute a toast, it would double up with the connected notice in notify mode).

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/userhelper/banner_test.go`:

```go
package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestBannerSessionTracking(t *testing.T) {
	shown := []string{}
	hidden := 0
	origShow, origHide := showBannerFn, hideBannerFn
	defer func() { showBannerFn, hideBannerFn = origShow, origHide }()
	showBannerFn = func(label string) bool { shown = append(shown, label); return true }
	hideBannerFn = func() { hidden++ }

	handleBannerShow(ipc.BannerShowRequest{SessionID: "s1", Label: "Billy from Olive Technology is connected"})
	handleBannerShow(ipc.BannerShowRequest{SessionID: "s2", Label: "Sue from Olive Technology is connected"})

	handleBannerHide("s1") // stale — s2 owns the banner now
	if hidden != 0 {
		t.Fatalf("stale hide must be ignored, hides=%d", hidden)
	}
	handleBannerHide("s2")
	if hidden != 1 {
		t.Fatalf("owner hide must hide, hides=%d", hidden)
	}
	if len(shown) != 2 || shown[1] != "Sue from Olive Technology is connected" {
		t.Fatalf("labels: %v", shown)
	}
	// hide with empty session id always hides (defensive daemon-side payloads)
	handleBannerShow(ipc.BannerShowRequest{SessionID: "s3", Label: "x"})
	handleBannerHide("")
	if hidden != 2 {
		t.Fatalf("empty-session hide must hide, hides=%d", hidden)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail to compile**

Run: `cd agent && go test -race ./internal/userhelper/ -run TestBannerSessionTracking -v`
Expected: compile FAIL.

- [ ] **Step 3: Implement `banner.go`**

```go
package userhelper

import (
	"encoding/json"
	"sync"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Platform seams (swapped in tests).
var (
	showBannerFn = showBannerOS
	hideBannerFn = hideBannerOS
)

var (
	bannerSessionMu sync.Mutex
	bannerSessionID string // session that currently owns the banner ("" = none)
)

// handleBannerShow shows (or relabels) the active-session banner. One banner
// window exists at a time; the most recent session owns it.
func handleBannerShow(req ipc.BannerShowRequest) {
	label := stripControl(trimNotifyField(req.Label, maxNotifyTitleBytes))
	if label == "" {
		label = "A technician is connected"
	}
	if !showBannerFn(label) {
		return // platform has no banner surface (macOS/Linux fallback)
	}
	bannerSessionMu.Lock()
	bannerSessionID = req.SessionID
	bannerSessionMu.Unlock()
}

// handleBannerHide hides the banner if the given session owns it. An empty
// session ID force-hides (defensive against malformed daemon payloads).
func handleBannerHide(sessionID string) {
	bannerSessionMu.Lock()
	owns := sessionID == "" || sessionID == bannerSessionID
	if owns {
		bannerSessionID = ""
	}
	bannerSessionMu.Unlock()
	if owns {
		hideBannerFn()
	}
}

func (c *Client) handleBannerShowEnvelope(env *ipc.Envelope) {
	var req ipc.BannerShowRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid banner_show payload", "error", err)
		return
	}
	handleBannerShow(req)
}

func (c *Client) handleBannerHideEnvelope(env *ipc.Envelope) {
	var payload struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		log.Warn("invalid banner_hide payload", "error", err)
		return
	}
	handleBannerHide(payload.SessionID)
}
```

Wire into `commandLoop()` in `client.go`, after the consent case:

```go
		case ipc.TypeBannerShow:
			safeGo("banner_show", func() { c.handleBannerShowEnvelope(env) })
		case ipc.TypeBannerHide:
			safeGo("banner_hide", func() { c.handleBannerHideEnvelope(env) })
```

- [ ] **Step 4: Implement `banner_other.go`**

```go
//go:build !windows

package userhelper

// showBannerOS: no native persistent banner without cgo on macOS/Linux. The
// Assist (Tauri) helper provides the banner there; the native fallback covers
// the consent dialog and toasts only.
func showBannerOS(label string) bool {
	log.Debug("session banner not supported on this platform", "label", label)
	return false
}

func hideBannerOS() {}
```

- [ ] **Step 5: Implement `banner_windows.go`**

```go
//go:build windows

package userhelper

import (
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

// A borderless, always-on-top, non-activating pill window pinned top-center
// showing "Billy from Olive Technology is connected". Pure user32/gdi32
// syscalls — the user-helper ships CGO_ENABLED=0.

var (
	bannerGdi32               = syscall.NewLazyDLL("gdi32.dll")
	procRegisterClassExW      = pamDialogUser32.NewProc("RegisterClassExW")
	procCreateWindowExW       = pamDialogUser32.NewProc("CreateWindowExW")
	procDefWindowProcW        = pamDialogUser32.NewProc("DefWindowProcW")
	procDestroyWindow         = pamDialogUser32.NewProc("DestroyWindow")
	procShowWindow            = pamDialogUser32.NewProc("ShowWindow")
	procGetMessageW           = pamDialogUser32.NewProc("GetMessageW")
	procTranslateMessage      = pamDialogUser32.NewProc("TranslateMessage")
	procDispatchMessageW      = pamDialogUser32.NewProc("DispatchMessageW")
	procPostMessageW          = pamDialogUser32.NewProc("PostMessageW")
	procPostQuitMessage       = pamDialogUser32.NewProc("PostQuitMessage")
	procBeginPaint            = pamDialogUser32.NewProc("BeginPaint")
	procEndPaint              = pamDialogUser32.NewProc("EndPaint")
	procDrawTextW             = pamDialogUser32.NewProc("DrawTextW")
	procGetClientRect         = pamDialogUser32.NewProc("GetClientRect")
	procGetSystemMetrics      = pamDialogUser32.NewProc("GetSystemMetrics")
	procInvalidateRect        = pamDialogUser32.NewProc("InvalidateRect")
	procSetLayeredWindowAttrs = pamDialogUser32.NewProc("SetLayeredWindowAttributes")
	procGetModuleHandleW      = syscall.NewLazyDLL("kernel32.dll").NewProc("GetModuleHandleW")
	procCreateSolidBrush      = bannerGdi32.NewProc("CreateSolidBrush")
	procSetBkMode             = bannerGdi32.NewProc("SetBkMode")
	procSetTextColor          = bannerGdi32.NewProc("SetTextColor")
)

const (
	bwsPopup          = 0x80000000
	bwsExTopmost      = 0x00000008
	bwsExToolwindow   = 0x00000080
	bwsExNoactivate   = 0x08000000
	bwsExLayered      = 0x00080000
	bwmDestroy        = 0x0002
	bwmPaint          = 0x000F
	bwmClose          = 0x0010
	bswShowNoactivate = 4
	bsmCxScreen       = 0
	bdtCenter         = 0x0001
	bdtVCenter        = 0x0004
	bdtSingleline     = 0x0020
	bLWAAlpha         = 0x00000002
	bTransparentBk    = 1

	bannerBgColor   = 0x002D2D2D // COLORREF 0x00BBGGRR — dark grey
	bannerTextColor = 0x00FFFFFF // white
	bannerAlpha     = 230
	bannerWidth     = 460
	bannerHeight    = 34
)

var (
	bannerMu       sync.Mutex
	bannerHwnd     uintptr
	bannerLabelU16 []uint16
	bannerClassReg sync.Once
)

type bannerRect struct{ left, top, right, bottom int32 }

type bannerMsg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	ptX     int32
	ptY     int32
}

type bannerPaintStruct struct {
	hdc         uintptr
	fErase      int32
	rcPaint     bannerRect
	fRestore    int32
	fIncUpdate  int32
	rgbReserved [32]byte
}

type bannerWndClassEx struct {
	cbSize        uint32
	style         uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     uintptr
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

func bannerWndProc(hwnd uintptr, msg uint32, wParam, lParam uintptr) uintptr {
	switch msg {
	case bwmPaint:
		var ps bannerPaintStruct
		hdc, _, _ := procBeginPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		if hdc != 0 {
			var rc bannerRect
			procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
			procSetBkMode.Call(hdc, bTransparentBk)
			procSetTextColor.Call(hdc, bannerTextColor)
			bannerMu.Lock()
			label := bannerLabelU16
			bannerMu.Unlock()
			if len(label) > 0 {
				procDrawTextW.Call(hdc, uintptr(unsafe.Pointer(&label[0])), uintptr(len(label)-1),
					uintptr(unsafe.Pointer(&rc)), bdtCenter|bdtVCenter|bdtSingleline)
			}
			procEndPaint.Call(hwnd, uintptr(unsafe.Pointer(&ps)))
		}
		return 0
	case bwmClose:
		procDestroyWindow.Call(hwnd)
		return 0
	case bwmDestroy:
		procPostQuitMessage.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProcW.Call(hwnd, uintptr(msg), wParam, lParam)
	return ret
}

func registerBannerClass() {
	bannerClassReg.Do(func() {
		hInst, _, _ := procGetModuleHandleW.Call(0)
		brush, _, _ := procCreateSolidBrush.Call(bannerBgColor)
		className, _ := syscall.UTF16PtrFromString("BreezeSessionBanner")
		wc := bannerWndClassEx{
			cbSize:        uint32(unsafe.Sizeof(bannerWndClassEx{})),
			lpfnWndProc:   syscall.NewCallback(bannerWndProc),
			hInstance:     hInst,
			hbrBackground: brush,
			lpszClassName: className,
		}
		procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc)))
	})
}

// showBannerOS shows (or relabels) the banner window. The window lives on a
// dedicated locked OS thread running its own message loop; hide posts WM_CLOSE.
func showBannerOS(label string) bool {
	u16, err := syscall.UTF16FromString(label)
	if err != nil {
		return false
	}
	bannerMu.Lock()
	bannerLabelU16 = u16
	if bannerHwnd != 0 {
		hwnd := bannerHwnd
		bannerMu.Unlock()
		procInvalidateRect.Call(hwnd, 0, 1)
		return true
	}
	bannerMu.Unlock()

	ready := make(chan uintptr, 1)
	go bannerWindowLoop(ready)
	hwnd := <-ready
	if hwnd == 0 {
		return false
	}
	bannerMu.Lock()
	bannerHwnd = hwnd
	bannerMu.Unlock()
	return true
}

func hideBannerOS() {
	bannerMu.Lock()
	hwnd := bannerHwnd
	bannerHwnd = 0
	bannerMu.Unlock()
	if hwnd != 0 {
		procPostMessageW.Call(hwnd, bwmClose, 0, 0)
	}
}

func bannerWindowLoop(ready chan<- uintptr) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	registerBannerClass()
	screenW, _, _ := procGetSystemMetrics.Call(bsmCxScreen)
	x := (int32(screenW) - bannerWidth) / 2
	if x < 0 {
		x = 0
	}
	className, _ := syscall.UTF16PtrFromString("BreezeSessionBanner")
	title, _ := syscall.UTF16PtrFromString("Remote session active")
	hInst, _, _ := procGetModuleHandleW.Call(0)
	hwnd, _, _ := procCreateWindowExW.Call(
		bwsExTopmost|bwsExToolwindow|bwsExNoactivate|bwsExLayered,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		bwsPopup,
		uintptr(x), 0, bannerWidth, bannerHeight,
		0, 0, hInst, 0,
	)
	if hwnd == 0 {
		ready <- 0
		return
	}
	procSetLayeredWindowAttrs.Call(hwnd, 0, bannerAlpha, bLWAAlpha)
	procShowWindow.Call(hwnd, bswShowNoactivate)
	ready <- hwnd

	var msg bannerMsg
	for {
		ret, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if ret == 0 || int32(ret) == -1 { // WM_QUIT or error
			return
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&msg)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&msg)))
	}
}
```

- [ ] **Step 6: Run tests + all cross-compiles**

Run:
```bash
cd agent && go test -race ./internal/userhelper/ && \
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build ./... && \
GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build ./... && \
GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 go build ./...
```
Expected: PASS, clean builds. (The Win32 code only compiles under GOOS=windows — the cross-compile IS the syntax test; runtime behavior is manual-QA'd on the Windows VM.)

- [ ] **Step 7: Commit**

```bash
git add agent/internal/userhelper/banner.go agent/internal/userhelper/banner_windows.go agent/internal/userhelper/banner_other.go agent/internal/userhelper/banner_test.go agent/internal/userhelper/client.go
git commit -m "feat(agent): native Windows session banner in the user-helper

Topmost non-activating pill via raw user32/gdi32 (no cgo). macOS/Linux
fallback has no persistent banner (Assist app provides it there).
Refs #2229"
```

---

### Task 8: Full-suite verification, manual QA, docs, comms, PR

**Files:**
- Create: `docs/release-notes/native-consent-fallback.md`
- No code changes expected (fix anything the suites surface).

- [ ] **Step 1: Run the full agent + API suites**

```bash
cd agent && go test -race ./... 
cd ../apps/api && npx vitest run src/routes/remote/ 
```
Expected: PASS. Fix regressions before proceeding.

- [ ] **Step 2: Manual QA on the Windows test VM** (100.101.150.55 — see `dev-push` notes: kill the watchdog first)

Use `make dev-push` to ship the dev agent+user-helper build, set a `remote_access` policy with `{"session_prompt_mode":"consent"}` on the VM's org, ensure the Assist app is NOT running, then from the web UI start a remote desktop session and verify:
1. Native Yes/No dialog appears: "Billy from <Partner> is requesting remote access…" — Deny → technician sees session denied.
2. Accept → session starts, top-center pill shows "<Tech> from <Partner> is connected".
3. Disconnect → pill disappears, "Remote session ended" toast.
4. `session_prompt_mode: "notify"` → toast "<Tech> from <Partner> connected to your computer", pill shown, no dialog.
5. Let the consent dialog time out → session proceeds (default `consent_unavailable_behavior: proceed`) and dialog closes.

- [ ] **Step 3: Write the release note**

Create `docs/release-notes/native-consent-fallback.md` covering: consent dialogs/banner now work without the Assist app on Windows (dialog on all 3 OSes, banner Windows-only); prompt now names the PARTNER; behavior change — devices that previously fell into `helper_absent → proceed` will now show a dialog once the user-helper updates; Linux requires zenity for the dialog.

- [ ] **Step 4: Open the PR**

```bash
git push -u origin ToddHebebrand/issue-2229-remote-session-end
gh pr create --repo LanternOps/breeze --title "feat(agent): native remote-session consent + banner without the Assist app" --body "$(cat <<'EOF'
## Summary
- Consent dialog + session notices now render natively from the Go user-helper when the Tauri Assist app is not installed (Refs #2229)
- New `consent_ui_fallback` IPC scope, advertise-gated for mixed-fleet safety
- Native surfaces: MessageBoxTimeoutW (Win), osascript (macOS), zenity (Linux); Win32 topmost pill banner (Windows)
- Fix: prompt shows the PARTNER (MSP) name, not the client org name
- Wording: "Billy from Olive Technology connected"

Refs #2229

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 5: Comment on issue #2229 + file the step-up MFA follow-up issue**

Comment on #2229 (thank @win-wxx; summarize what shipped in v0.83.0 / PR #1694, what this PR adds, and that step-up MFA is split out). Create the new issue `[API/Web] Step-up MFA before remote tools and Tier 3 actions` crediting @win-wxx with a link back to #2229. Do NOT close #2229.
