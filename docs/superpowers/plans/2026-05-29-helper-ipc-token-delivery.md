# Helper IPC Token Delivery — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the per-device `helper_auth_token` to the Breeze Assist Helper over the existing authenticated agent IPC channel (kernel peer-auth + binary-hash allowlist) instead of the world-readable `agent.yaml`, closing security-review finding HIGH-1.

**Architecture:** Reuse the Go agent's existing IPC (`agent/internal/ipc` + `agent/internal/sessionbroker`). Add a least-privilege `assist` role/scope and a dedicated `helper_token_update` message so the helper token never shares a path with the watchdog's agent token. Add a focused Rust IPC client to the Tauri Helper (`apps/helper/src-tauri`) that authenticates, receives the token into memory, and feeds it to the existing `helper_fetch`. Two-phase rollout: **Phase 1 (this plan)** ships IPC delivery while the agent *still* writes the token to `agent.yaml` (file fallback retained); **Phase 2 (separate, gated release)** stops writing the file and removes the fallback.

**Tech Stack:** Go (agent, `go test -race`), Rust/Tauri 2 (`apps/helper/src-tauri`, `cargo test`), tokio, hmac/sha2, named pipe (Windows) / Unix domain socket (macOS/Linux).

**Spec:** `docs/superpowers/specs/2026-05-29-helper-ipc-token-delivery-design.md`

---

## Reference facts (verified against the codebase)

- **Wire format** (`agent/internal/ipc/protocol.go`): `[4-byte BE length][JSON Envelope]`. `Envelope{ID, Seq, Type, Payload(json.RawMessage), Error, HMAC}`. HMAC = `HMAC-SHA256(key, ID || decimal(Seq) || Type || Payload)`, where `key` is 32 zero bytes pre-auth and the 32-byte session key post-auth. A `nil`/absent payload is HMAC'd as the literal bytes `null` (4 bytes). `Seq` starts at 1 and must be strictly increasing per direction.
- **Handshake** (`broker.go:1090-1418`, modeled by `userhelper/client.go:178-290`): client sends `auth_request`; broker verifies protocol version, identity (`SID`==kernel SID on Windows / `UID`==kernel UID on unix), binary path allowlist, **binary-hash allowlist** (`selfHashes`, recomputed from on-disk trusted-path binaries — broker does NOT trust `authReq.BinaryHash`), duplicate session id, role↔identity (Windows: user-role must NOT be SYSTEM `S-1-5-18`), then replies `auth_response{accepted, sessionKey(hex), allowedScopes}`. On rejection before/at auth it may send `pre_auth_reject{code, reason, permanent}` or `auth_response{accepted:false, permanent}`.
- **Roles/scopes** (`ipc/message.go:113-115`, `broker.go:209-213, 1360-1375`): `HelperRoleSystem/User/Watchdog`; `userHelperScopes=[notify,clipboard,run_as_user]`, `watchdogHelperScopes=[watchdog]`.
- **Token push precedent** (`heartbeat.go:2462-2471`): `sendWatchdogTokenUpdate` finds `PreferredSessionWithScope("watchdog")` and `SendNotify("", ipc.TypeTokenUpdate, ipc.TokenUpdate{Token})`. Helper-token rotation value is available as `rotateResp.HelperAuthToken` at `heartbeat.go:2410-2433`.
- **Broker callbacks** (`broker.go:216-221, 270, 331-333`): `New(socketPath, MessageHandler)`, `SetSessionClosedHandler`. No on-authenticated hook exists yet — we add one.
- **Helper Rust** (`apps/helper/src-tauri/src/lib.rs`): `helper_token_from_config` (lines 79-89) reads token from secrets.yaml→agent.yaml; `load_agent_config_full` builds `AgentConfigFull{api_url, token, agent_id, mtls_*}`; `HttpClientState{client, config}` cached in `static HTTP_STATE: OnceLock<Mutex<Option<HttpClientState>>>`; `helper_fetch` reads `state.config.token` and sets `Authorization: Bearer`. Cargo deps include `tokio={features=["sync"]}`, `serde`, `serde_yaml`, `reqwest`, `chrono`.

## File structure

**Go (agent):**
- `agent/internal/ipc/message.go` — new role/binary-kind/message-type constants + `HelperTokenUpdate` struct.
- `agent/internal/sessionbroker/broker.go` — `assistHelperScopes`, role validation, scope assignment, `SessionAuthenticatedHandler` hook, trusted Helper binary path.
- `agent/internal/sessionbroker/broker_test.go` — broker tests.
- `agent/internal/heartbeat/heartbeat.go` — retained helper token, `sendHelperTokenUpdate*`, wire on-auth + rotation push.
- `agent/internal/heartbeat/heartbeat_test.go` (or a focused new `*_test.go`) — push tests.

**Rust (Helper) — new module `apps/helper/src-tauri/src/ipc/`:**
- `mod.rs` — module exports.
- `envelope.rs` — Envelope struct, length-prefix framing read/write, HMAC compute/verify, seq tracking.
- `transport.rs` — platform connect (named pipe / unix socket).
- `client.rs` — handshake + receive loop + reconnect; owns the token cell.
- `token.rs` — shared in-memory token cell (`HelperToken`).
- `apps/helper/src-tauri/src/lib.rs` — wire token cell into `helper_fetch`; start the IPC client; Phase-1 file fallback.
- `apps/helper/src-tauri/Cargo.toml` — add deps.

---

## Baseline (run once before Task 1)

- [ ] **Establish green baseline**

```bash
cd /Users/toddhebebrand/breeze/.claude/worktrees/helper-ipc-token-delivery/agent
go build ./... && go test -race ./internal/ipc/... ./internal/sessionbroker/... ./internal/heartbeat/...
cd ../apps/helper/src-tauri && cargo build
```
Expected: Go builds and the three packages’ tests pass; cargo builds. If anything fails, STOP and report (do not start on a red baseline).

---

# Part A — Go agent (Phase 1a)

### Task 1: IPC constants + `HelperTokenUpdate` message

**Files:**
- Modify: `agent/internal/ipc/message.go` (constants near `:113-115` and `:55`; struct near `:326`)
- Test: `agent/internal/ipc/message_test.go` (create if absent)

- [ ] **Step 1: Write the failing test**

In `agent/internal/ipc/message_test.go`:
```go
package ipc

import (
	"encoding/json"
	"testing"
)

func TestHelperAssistConstants(t *testing.T) {
	if HelperRoleAssist != "assist" {
		t.Fatalf("HelperRoleAssist = %q, want \"assist\"", HelperRoleAssist)
	}
	if HelperBinaryAssistHelper != "assist_helper" {
		t.Fatalf("HelperBinaryAssistHelper = %q, want \"assist_helper\"", HelperBinaryAssistHelper)
	}
	if TypeHelperTokenUpdate != "helper_token_update" {
		t.Fatalf("TypeHelperTokenUpdate = %q, want \"helper_token_update\"", TypeHelperTokenUpdate)
	}
}

func TestHelperTokenUpdateRoundTrip(t *testing.T) {
	in := HelperTokenUpdate{Token: "brz_abc", ExpiresAt: "2026-06-01T00:00:00Z"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out HelperTokenUpdate
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Fatalf("round-trip mismatch: %+v != %+v", out, in)
	}
	// ExpiresAt must be omitempty.
	b2, _ := json.Marshal(HelperTokenUpdate{Token: "brz_x"})
	if string(b2) != `{"token":"brz_x"}` {
		t.Fatalf("omitempty failed: %s", b2)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/ipc/ -run TestHelperAssist -v`
Expected: FAIL — `undefined: HelperRoleAssist` (etc.)

- [ ] **Step 3: Add the constants and struct**

In `agent/internal/ipc/message.go`, add `HelperRoleAssist` next to the existing role constants (`:113-115`):
```go
	HelperRoleSystem   = "system"
	HelperRoleUser     = "user"
	HelperRoleWatchdog = "watchdog"
	HelperRoleAssist   = "assist" // Breeze Assist Tauri helper; receives helper token only
```
Add the binary-kind constant next to the existing `HelperBinary*` constants (search for `HelperBinaryUserHelper`):
```go
	HelperBinaryAssistHelper = "assist_helper"
```
Add the message-type constant in the watchdog/token block (`:55`):
```go
	TypeTokenUpdate           = "token_update"        // agent token -> watchdog (existing)
	TypeHelperTokenUpdate     = "helper_token_update" // helper token -> assist helper
```
Add the payload struct near `TokenUpdate` (`:326`):
```go
// HelperTokenUpdate carries the helper-scoped API token to the Assist helper.
// Distinct from TokenUpdate (agent token -> watchdog) so the two tokens can
// never be cross-delivered.
type HelperTokenUpdate struct {
	Token     string `json:"token"`
	ExpiresAt string `json:"expiresAt,omitempty"` // RFC3339, optional
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test ./internal/ipc/ -run 'TestHelperAssist|TestHelperTokenUpdate' -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/ipc/message.go agent/internal/ipc/message_test.go
git commit -m "feat(agent/ipc): add assist role + helper_token_update message"
```

---

### Task 2: Broker accepts `assist` role with `assist`-only scope

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go` (scopes block `:209-213`; valid-role switch `:1278-1289`; role/identity validation `:1297-1357`; scope assignment `:1359-1375`)
- Test: `agent/internal/sessionbroker/broker_test.go`

- [ ] **Step 1: Write the failing tests**

Add to `agent/internal/sessionbroker/broker_test.go` (the package already has broker tests; reuse its style):
```go
func TestAssistScopesConstant(t *testing.T) {
	if len(assistHelperScopes) != 1 || assistHelperScopes[0] != "assist" {
		t.Fatalf("assistHelperScopes = %v, want [\"assist\"]", assistHelperScopes)
	}
	// Assist must NOT carry desktop/clipboard/run_as_user.
	for _, s := range assistHelperScopes {
		switch s {
		case "desktop", "clipboard", "run_as_user", "notify", "tray":
			t.Fatalf("assist scope must not include %q", s)
		}
	}
}

func TestScopesForRoleAssist(t *testing.T) {
	got := scopesForRole(ipc.HelperRoleAssist, ipc.HelperBinaryAssistHelper, "darwin", "/x")
	if len(got) != 1 || got[0] != "assist" {
		t.Fatalf("scopesForRole(assist) = %v, want [assist]", got)
	}
}
```

> Note: this task extracts the inline `switch helperRole` (`broker.go:1359-1375`) into a testable `scopesForRole(role, binaryKind, goos, peerPath string) []string` helper, and adds the assist case. The desktop-on-darwin special case stays inside the helper.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/sessionbroker/ -run 'TestAssistScopes|TestScopesForRoleAssist' -v`
Expected: FAIL — `undefined: assistHelperScopes` / `undefined: scopesForRole`

- [ ] **Step 3: Implement**

In `broker.go`, add the scope set near `:209-213`:
```go
	systemHelperScopes   = []string{"notify", "tray", "clipboard", "desktop"}
	userHelperScopes     = []string{"notify", "clipboard", "run_as_user"}
	watchdogHelperScopes = []string{"watchdog"}
	assistHelperScopes   = []string{"assist"}
```
Add `HelperRoleAssist` to the valid-role switch (`:1279`):
```go
	case ipc.HelperRoleSystem, ipc.HelperRoleUser, ipc.HelperRoleWatchdog, ipc.HelperRoleAssist, backupipc.HelperRoleBackup:
```
Add role/identity validation. In the Windows block (after the user-role check, ~`:1319`):
```go
		if helperRole == ipc.HelperRoleAssist && creds.SID == systemSID {
			log.Warn("role/identity mismatch: SYSTEM process claiming assist role",
				"sid", creds.SID, "pid", creds.PID)
			_ = conn.SendTyped(env.ID, ipc.TypeAuthResponse, ipc.AuthResponse{
				Accepted:  false,
				Reason:    "assist role requires non-SYSTEM identity",
				Permanent: true,
			})
			conn.Close()
			return
		}
```
(No unix identity restriction beyond the existing watchdog/system root checks — the assist helper runs as the logged-in user, mirroring user-role.)

Extract and extend the scope assignment. Replace the inline `switch helperRole { ... }` at `:1359-1375` with:
```go
	scopes := scopesForRole(helperRole, authReq.BinaryKind, runtime.GOOS, creds.BinaryPath)
```
And add the helper method (place near the scope vars or at file end):
```go
// scopesForRole maps a validated helper role to its allowed scopes.
func (b *Broker) scopesForRole(role, binaryKind, goos, peerPath string) []string {
	switch role {
	case ipc.HelperRoleUser:
		if goos == "darwin" &&
			binaryKind == ipc.HelperBinaryDesktopHelper &&
			b.isDesktopHelperPeerPath(peerPath) {
			return []string{"desktop"}
		}
		return userHelperScopes
	case backupipc.HelperRoleBackup:
		return backupHelperScopes
	case ipc.HelperRoleWatchdog:
		return watchdogHelperScopes
	case ipc.HelperRoleAssist:
		return assistHelperScopes
	case ipc.HelperRoleSystem:
		return systemHelperScopes
	}
	return nil
}
```
Adjust the test in Step 1 to call `(&Broker{}).scopesForRole(...)` if `scopesForRole` is a method (the desktop branch needs `b.isDesktopHelperPeerPath`, so it must be a method; update the test to construct a `&Broker{}` and call the method, or test via a zero-value broker — `isDesktopHelperPeerPath` on a zero broker must be safe; if it isn't, keep `scopesForRole` taking the path and only call `isDesktopHelperPeerPath` for the darwin desktop case which the assist test doesn't hit).

> Implementation note for the worker: verify `isDesktopHelperPeerPath` is safe on a zero-value `*Broker` (the assist/user non-darwin tests don't reach it). If not, the test should use a properly constructed broker via the package's existing test helper.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run 'TestAssistScopes|TestScopesForRoleAssist' -v`
Expected: PASS

- [ ] **Step 5: Run the full package to catch the refactor**

Run: `cd agent && go test -race ./internal/sessionbroker/`
Expected: PASS (the extracted helper must preserve existing behavior)

- [ ] **Step 6: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_test.go
git commit -m "feat(agent/broker): admit assist role with assist-only scope + non-SYSTEM identity check"
```

---

### Task 3: Allowlist the Breeze Helper binary hash

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go` (trusted-path computation near `:1648-1696`, `allowedHelperPaths`, `RefreshAllowedHashes`)
- Test: `agent/internal/sessionbroker/broker_test.go`

- [ ] **Step 1: Identify the trusted-path function**

Run: `cd agent && grep -n "breeze-watchdog\|allowedHelperPaths\|trustedHelperPaths\|RefreshAllowedHashes\|helper.DefaultBinaryPath" internal/sessionbroker/broker.go`
Expected: a function that assembles candidate helper binary paths (watchdog + userhelper, derived from the agent exe dir). Read it.

- [ ] **Step 2: Write the failing test**

Add to `broker_test.go`:
```go
func TestTrustedHelperPathsIncludeAssistHelper(t *testing.T) {
	paths := trustedHelperBinaryPaths("/opt/breeze/breeze-agent") // adjust to actual fn name/signature
	found := false
	for _, p := range paths {
		base := filepath.Base(p)
		if base == "breeze-helper" || base == "breeze-helper.exe" {
			found = true
		}
	}
	if !found {
		t.Fatalf("trusted helper paths %v missing breeze-helper", paths)
	}
}
```
(Rename to match the real function discovered in Step 1; if the function is unexported and computes from `os.Executable()`, refactor it to take the agent-dir as a parameter so it's testable, and have the production caller pass `filepath.Dir(exe)`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd agent && go test ./internal/sessionbroker/ -run TestTrustedHelperPathsIncludeAssistHelper -v`
Expected: FAIL — assist helper not in trusted paths.

- [ ] **Step 4: Implement**

Add the Helper binary to the trusted-path list (mirror the existing watchdog entries discovered in Step 1). On Windows the Helper installs as `breeze-helper.exe`; on macOS the executable lives inside the `.app` bundle. Add a resolver:
```go
// assistHelperBinaryPaths returns candidate install paths for the Breeze Assist
// helper, derived from the agent install dir. Used so RefreshAllowedHashes
// allowlists the genuine breeze-helper binary's SHA-256.
func assistHelperBinaryPaths(agentDir string) []string {
	switch runtime.GOOS {
	case "windows":
		return []string{filepath.Join(agentDir, "breeze-helper.exe")}
	case "darwin":
		// Helper ships as a .app; executable is inside Contents/MacOS.
		return []string{
			"/Applications/Breeze Helper.app/Contents/MacOS/breeze-helper",
			filepath.Join(agentDir, "breeze-helper"),
		}
	default:
		return []string{filepath.Join(agentDir, "breeze-helper")}
	}
}
```
Wire these into the trusted-path assembly used by `RefreshAllowedHashes` (the function from Step 1). Non-existent paths must be skipped silently (the existing hash loader already tolerates missing files — verify it `continue`s on `os.Open` error rather than failing the whole refresh).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestTrustedHelperPathsIncludeAssistHelper -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_test.go
git commit -m "feat(agent/broker): allowlist breeze-helper binary hash for assist IPC"
```

---

### Task 4: `SessionAuthenticatedHandler` hook on the broker

**Files:**
- Modify: `agent/internal/sessionbroker/broker.go` (types near `:216-221`; field near `:264`; setter near `:331`; invoke after registration near `:1426-1450`)
- Test: `agent/internal/sessionbroker/broker_test.go`

- [ ] **Step 1: Write the failing test**

```go
func TestSetSessionAuthenticatedHandler(t *testing.T) {
	b := New("/tmp/does-not-matter.sock", func(*Session, *ipc.Envelope) {})
	var got *Session
	b.SetSessionAuthenticatedHandler(func(s *Session) { got = s })
	sess := &Session{} // minimal
	b.fireSessionAuthenticated(sess)
	if got != sess {
		t.Fatalf("handler not invoked with the session")
	}
	// Nil handler must be a no-op (no panic).
	b2 := New("/tmp/x.sock", func(*Session, *ipc.Envelope) {})
	b2.fireSessionAuthenticated(&Session{})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/sessionbroker/ -run TestSetSessionAuthenticatedHandler -v`
Expected: FAIL — undefined `SetSessionAuthenticatedHandler` / `fireSessionAuthenticated`

- [ ] **Step 3: Implement**

Add the type near `:220`:
```go
// SessionAuthenticatedHandler is called after a helper session has been
// successfully authenticated and registered.
type SessionAuthenticatedHandler func(session *Session)
```
Add the field to `Broker struct` near `:265`:
```go
	onSessionAuthed SessionAuthenticatedHandler
```
Add the setter near `:331`:
```go
func (b *Broker) SetSessionAuthenticatedHandler(handler SessionAuthenticatedHandler) {
	b.mu.Lock()
	b.onSessionAuthed = handler
	b.mu.Unlock()
}

// fireSessionAuthenticated invokes the on-authenticated handler if set.
func (b *Broker) fireSessionAuthenticated(session *Session) {
	b.mu.RLock()
	handler := b.onSessionAuthed
	b.mu.RUnlock()
	if handler != nil {
		handler(session)
	}
}
```
Invoke it after the session is fully registered (after the successful `tryAdmitLocked` append and unlock, where `registerOnClosed` is handled around `:1447`). Place the call OUTSIDE the broker mutex to avoid re-entrancy, and run it in a goroutine so a slow handler can't block the accept loop:
```go
	go b.fireSessionAuthenticated(session)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/sessionbroker/ -run TestSetSessionAuthenticatedHandler -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add agent/internal/sessionbroker/broker.go agent/internal/sessionbroker/broker_test.go
git commit -m "feat(agent/broker): add SessionAuthenticatedHandler hook"
```

---

### Task 5: Heartbeat pushes the helper token on connect + rotation

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go` (broker wiring `:408-409`; rotation `:2410-2433`; new methods near `:2462`)
- Test: `agent/internal/heartbeat/heartbeat_token_test.go` (create)

- [ ] **Step 1: Write the failing test**

The push methods are thin wrappers over `Session.SendNotify`. Test the routing decision (assist scope → push; other scope → skip) via a small extracted pure helper so we don't need a live socket:
```go
package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestShouldPushHelperToken(t *testing.T) {
	if !shouldPushHelperToken([]string{"assist"}) {
		t.Fatal("assist scope should receive helper token")
	}
	if shouldPushHelperToken([]string{"watchdog"}) {
		t.Fatal("watchdog scope must NOT receive helper token")
	}
	if shouldPushHelperToken([]string{"notify", "clipboard", "run_as_user"}) {
		t.Fatal("user scope must NOT receive helper token")
	}
	if shouldPushHelperToken(nil) {
		t.Fatal("no scopes must NOT receive helper token")
	}
	_ = ipc.TypeHelperTokenUpdate // ensure import used
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run TestShouldPushHelperToken -v`
Expected: FAIL — `undefined: shouldPushHelperToken`

- [ ] **Step 3: Implement the helper + push methods**

Add a retained helper-token field. Find the `Heartbeat struct` and add:
```go
	helperToken   string
	helperTokenMu sync.RWMutex
```
Add a setter used at startup and on rotation:
```go
func (h *Heartbeat) setHelperToken(token string) {
	h.helperTokenMu.Lock()
	h.helperToken = token
	h.helperTokenMu.Unlock()
}

func (h *Heartbeat) currentHelperToken() string {
	h.helperTokenMu.RLock()
	defer h.helperTokenMu.RUnlock()
	return h.helperToken
}
```
Populate it at startup where the heartbeat is constructed/started from config (search for where `h.config` is first available — set `h.setHelperToken(h.config.HelperAuthToken)` there). This guarantees the connect-time push has the token even though `config.HelperAuthToken` is cleared post-persist on rotation (`heartbeat.go:2423`).

Add the routing helper and push methods near `sendWatchdogTokenUpdate` (`:2462`):
```go
// shouldPushHelperToken reports whether a session with the given scopes should
// receive the helper token. Only assist-scope sessions qualify; this guards
// against ever sending the helper token to the watchdog or a user helper.
func shouldPushHelperToken(scopes []string) bool {
	for _, s := range scopes {
		if s == "assist" {
			return true
		}
	}
	return false
}

// handleHelperSessionAuthenticated is wired as the broker's
// SessionAuthenticatedHandler. It pushes the current helper token to a freshly
// authenticated assist session.
func (h *Heartbeat) handleHelperSessionAuthenticated(session *sessionbroker.Session) {
	if session == nil || !shouldPushHelperToken(session.Scopes()) {
		return
	}
	token := h.currentHelperToken()
	if token == "" {
		return
	}
	if err := session.SendNotify("", ipc.TypeHelperTokenUpdate, ipc.HelperTokenUpdate{Token: token}); err != nil {
		log.Warn("failed to push helper token to assist session", "error", err.Error())
	}
}

// sendHelperTokenUpdate pushes a (possibly rotated) helper token to all
// connected assist sessions.
func (h *Heartbeat) sendHelperTokenUpdate(newToken string) {
	if h.sessionBroker == nil || newToken == "" {
		return
	}
	for _, sess := range h.sessionBroker.SessionsWithScope("assist") {
		if err := sess.SendNotify("", ipc.TypeHelperTokenUpdate, ipc.HelperTokenUpdate{Token: newToken}); err != nil {
			log.Warn("failed to push rotated helper token", "error", err.Error())
		}
	}
}
```
(Confirm `Session.Scopes()` exists; if scopes are an exported field `session.Scopes`, use that. If neither, add a `func (s *Session) Scopes() []string { return s.scopes }` accessor in `broker.go`.)

Wire the on-auth handler next to the closed handler at `:408-409`:
```go
		h.sessionBroker = sessionbroker.New(socketPath, h.handleUserHelperMessage)
		h.sessionBroker.SetSessionClosedHandler(h.handleHelperSessionClosed)
		h.sessionBroker.SetSessionAuthenticatedHandler(h.handleHelperSessionAuthenticated)
```
Wire the rotation push. At `:2419-2433`, after `h.config.HelperAuthToken = rotateResp.HelperAuthToken` and before it's cleared, also retain + push:
```go
	h.config.HelperAuthToken = rotateResp.HelperAuthToken
	h.setHelperToken(rotateResp.HelperAuthToken) // retain for connect-time pushes
	// ... existing persist + clear ...
	h.sendWatchdogTokenUpdate(rotateResp.WatchdogAuthToken)
	h.sendHelperTokenUpdate(rotateResp.HelperAuthToken)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd agent && go test -race ./internal/heartbeat/ -run TestShouldPushHelperToken -v`
Expected: PASS

- [ ] **Step 5: Build the whole agent**

Run: `cd agent && go build ./... && go test -race ./internal/ipc/... ./internal/sessionbroker/... ./internal/heartbeat/...`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add agent/internal/heartbeat/heartbeat.go agent/internal/heartbeat/heartbeat_token_test.go agent/internal/sessionbroker/broker.go
git commit -m "feat(agent/heartbeat): push helper token to assist sessions on connect + rotation"
```

---

# Part B — Rust Helper IPC client (Phase 1b)

### Task 6: Add Rust dependencies

**Files:**
- Modify: `apps/helper/src-tauri/Cargo.toml`

- [ ] **Step 1: Add deps**

Under `[dependencies]`, extend `tokio` features and add crypto/encoding/identity deps:
```toml
tokio = { version = "1", features = ["sync", "net", "io-util", "time", "rt", "macros"] }
hmac = "0.12"
sha2 = "0.10"
hex = "0.4"
rand = "0.8"
```
Add Windows-only identity/pipe support:
```toml
[target.'cfg(windows)'.dependencies]
windows = { version = "0.58", features = [
  "Win32_Foundation",
  "Win32_Security",
  "Win32_System_Threading",
] }
```
(`tokio` already provides `tokio::net::windows::named_pipe` with the `net` feature on Windows, and `tokio::net::UnixStream` on unix.)

- [ ] **Step 2: Verify it builds**

Run: `cd apps/helper/src-tauri && cargo build`
Expected: builds (deps resolve).

- [ ] **Step 3: Commit**

```bash
git add apps/helper/src-tauri/Cargo.toml apps/helper/src-tauri/Cargo.lock
git commit -m "build(helper): add tokio net + hmac/sha2/hex deps for IPC client"
```

---

### Task 7: Envelope framing + HMAC (the wire protocol)

**Files:**
- Create: `apps/helper/src-tauri/src/ipc/mod.rs`
- Create: `apps/helper/src-tauri/src/ipc/envelope.rs`
- Modify: `apps/helper/src-tauri/src/lib.rs` (add `mod ipc;`)

- [ ] **Step 1: Write the failing test**

Create `apps/helper/src-tauri/src/ipc/envelope.rs` with the struct + a test module. The test pins the HMAC to a value computed by the Go implementation’s formula (`HMAC-SHA256(key, ID || decimal(Seq) || Type || Payload)`, zero-key = 32 zero bytes, nil payload = bytes `null`):
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_matches_go_formula_zero_key() {
        // Envelope{ID:"auth", Seq:1, Type:"auth_request", Payload: {"a":1}}
        let payload = serde_json::to_vec(&serde_json::json!({"a":1})).unwrap();
        let mac = compute_hmac(&[0u8; 32], "auth", 1, "auth_request", &payload);
        // Expected value produced by the Go reference (see plan Step 3 to regenerate).
        assert_eq!(mac, GO_FIXTURE_HMAC_AUTH);
    }

    #[test]
    fn nil_payload_hmacs_as_literal_null() {
        let with_null = compute_hmac(&[0u8; 32], "x", 2, "ping", b"null");
        let with_none = compute_hmac_opt(&[0u8; 32], "x", 2, "ping", None);
        assert_eq!(with_null, with_none);
    }

    #[test]
    fn frame_round_trip() {
        let env = Envelope {
            id: "id1".into(), seq: 0, typ: "ping".into(),
            payload: None, error: String::new(), hmac: String::new(),
        };
        let bytes = encode_frame(&[0u8;32], env.clone(), 5).unwrap();
        // [4-byte BE len][json]; len matches remainder.
        let len = u32::from_be_bytes(bytes[0..4].try_into().unwrap()) as usize;
        assert_eq!(len, bytes.len() - 4);
    }
}
```

Generate `GO_FIXTURE_HMAC_AUTH` once (Step 3) and paste it as a `const`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/helper/src-tauri && cargo test ipc::envelope`
Expected: FAIL — module/functions not defined.

- [ ] **Step 3: Generate the Go HMAC fixture, then implement**

Generate the reference value (one-off):
```bash
cd /Users/toddhebebrand/breeze/agent
cat > /tmp/hmacgen.go <<'EOF'
package main
import ("crypto/hmac";"crypto/sha256";"encoding/hex";"fmt")
func main(){
  key := make([]byte,32)
  mac := hmac.New(sha256.New, key)
  mac.Write([]byte("auth")); mac.Write([]byte("1")); mac.Write([]byte("auth_request")); mac.Write([]byte(`{"a":1}`))
  fmt.Println(hex.EncodeToString(mac.Sum(nil)))
}
EOF
go run /tmp/hmacgen.go   # paste output into GO_FIXTURE_HMAC_AUTH
```

Implement `envelope.rs`:
```rust
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub const MAX_MESSAGE_SIZE: usize = 16 * 1024 * 1024;
pub const PROTOCOL_VERSION: i32 = 1;

#[cfg(test)]
pub const GO_FIXTURE_HMAC_AUTH: &str = "PASTE_FROM_STEP_3";

#[derive(Clone, Serialize, Deserialize)]
pub struct Envelope {
    #[serde(rename = "ID")] pub id: String,
    #[serde(rename = "Seq")] pub seq: u64,
    #[serde(rename = "Type")] pub typ: String,
    #[serde(rename = "Payload", skip_serializing_if = "Option::is_none")]
    pub payload: Option<serde_json::value::RawValue_OR_Vec>, // see note
    #[serde(rename = "Error", default)] pub error: String,
    #[serde(rename = "HMAC", default)] pub hmac: String,
}
```
> **Payload encoding note:** Go marshals `Payload json.RawMessage` (raw JSON bytes) and HMACs those exact bytes. In Rust, model `payload` as `Option<Box<serde_json::value::RawValue>>` for *parsing* inbound, but for HMAC use the raw bytes. Simplest correct approach: keep an internal representation where outbound payloads are pre-serialized to `Vec<u8>` and inbound payloads are captured as raw bytes via `serde_json::value::RawValue`. The field names MUST serialize exactly as Go (`ID/Seq/Type/Payload/Error/HMAC` — Go uses exported field names, no json tags, so keys are the Go field names). Verify against a captured Go frame in Task 9 integration.

Implement HMAC + framing:
```rust
type HmacSha256 = Hmac<Sha256>;

pub fn compute_hmac(key: &[u8], id: &str, seq: u64, typ: &str, payload: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(key).expect("hmac key");
    mac.update(id.as_bytes());
    mac.update(seq.to_string().as_bytes());
    mac.update(typ.as_bytes());
    mac.update(payload);
    hex::encode(mac.finalize().into_bytes())
}

pub fn compute_hmac_opt(key: &[u8], id: &str, seq: u64, typ: &str, payload: Option<&[u8]>) -> String {
    compute_hmac(key, id, seq, typ, payload.unwrap_or(b"null"))
}
```
`encode_frame` assigns the seq, computes HMAC over the exact payload bytes, serializes the envelope, and prepends the 4-byte BE length. `decode_frame`/`read_frame` reads 4-byte len, bounds-checks `<= MAX_MESSAGE_SIZE` and `!= 0`, reads the body, parses the envelope, recomputes + constant-compares the HMAC, and enforces strictly-increasing recv seq. Provide `async fn read_frame<R: AsyncReadExt+Unpin>` and `async fn write_frame<W: AsyncWriteExt+Unpin>`.

Create `mod.rs`:
```rust
pub mod envelope;
pub mod transport;
pub mod client;
pub mod token;
```
(Comment out `transport/client/token` until their tasks land, or create empty stubs now.)

Add `mod ipc;` near the top of `lib.rs`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/helper/src-tauri && cargo test ipc::envelope`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/helper/src-tauri/src/ipc/ apps/helper/src-tauri/src/lib.rs
git commit -m "feat(helper/ipc): envelope framing + Go-compatible HMAC"
```

---

### Task 8: Shared in-memory token cell

**Files:**
- Create: `apps/helper/src-tauri/src/ipc/token.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn set_and_get() {
        let cell = HelperToken::new();
        assert_eq!(cell.get().await, None);
        cell.set("brz_a".into()).await;
        assert_eq!(cell.get().await.as_deref(), Some("brz_a"));
        cell.set("brz_b".into()).await;
        assert_eq!(cell.get().await.as_deref(), Some("brz_b"));
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/helper/src-tauri && cargo test ipc::token`
Expected: FAIL — undefined.

- [ ] **Step 3: Implement**

```rust
use std::sync::Arc;
use tokio::sync::RwLock;

/// In-memory, updatable helper token. Never persisted to disk.
#[derive(Clone, Default)]
pub struct HelperToken {
    inner: Arc<RwLock<Option<String>>>,
}

impl HelperToken {
    pub fn new() -> Self { Self::default() }
    pub async fn set(&self, token: String) {
        *self.inner.write().await = Some(token);
    }
    pub async fn get(&self) -> Option<String> {
        self.inner.read().await.clone()
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/helper/src-tauri && cargo test ipc::token`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/helper/src-tauri/src/ipc/token.rs
git commit -m "feat(helper/ipc): in-memory helper token cell"
```

---

### Task 9: Transport + identity (platform connect)

**Files:**
- Create: `apps/helper/src-tauri/src/ipc/transport.rs`

- [ ] **Step 1: Implement transport (no unit test — exercised by Task 10 integration)**

`transport.rs` exposes:
```rust
pub fn default_socket_path() -> String {
    #[cfg(windows)] { r"\\.\pipe\breeze-agent-ipc".to_string() }
    #[cfg(target_os = "macos")] { "/Library/Application Support/Breeze/agent.sock".to_string() }
    #[cfg(all(unix, not(target_os = "macos")))] { "/var/run/breeze/agent.sock".to_string() }
}

pub struct PeerIdentity { pub uid: u32, pub sid: String, pub username: String }

pub fn current_identity() -> Result<PeerIdentity, String> { /* see below */ }
```
- **unix:** `uid = unsafe { libc::getuid() }` (add `libc` dep) or read from `whoami`; `username = whoami::username()`; `sid = String::new()`.
- **windows:** username via `whoami::username()`; SID via the `windows` crate — `OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY)` → `GetTokenInformation(TokenUser)` → `ConvertSidToStringSidW`. Return the `S-1-5-...` string. The broker requires `auth_request.SID == kernel SID` on Windows (`broker.go:1145`), so this must be the process's real token SID.

Connect helpers:
```rust
#[cfg(windows)]
pub async fn connect(path: &str) -> std::io::Result<tokio::net::windows::named_pipe::NamedPipeClient> {
    tokio::net::windows::named_pipe::ClientOptions::new().open(path)
}
#[cfg(unix)]
pub async fn connect(path: &str) -> std::io::Result<tokio::net::UnixStream> {
    tokio::net::UnixStream::connect(path).await
}
```
Compute the self-hash (best-effort; not security-load-bearing — broker recomputes from kernel path) and report `pid = std::process::id()`.

- [ ] **Step 2: Verify it builds on this platform**

Run: `cd apps/helper/src-tauri && cargo build`
Expected: builds (macOS dev: unix path compiles; Windows path is `cfg`-gated).

- [ ] **Step 3: Commit**

```bash
git add apps/helper/src-tauri/src/ipc/transport.rs apps/helper/src-tauri/Cargo.toml
git commit -m "feat(helper/ipc): platform transport + peer identity"
```

---

### Task 10: Client handshake + receive loop + reconnect

**Files:**
- Create: `apps/helper/src-tauri/src/ipc/client.rs`

- [ ] **Step 1: Implement the client**

Model on `agent/internal/userhelper/client.go:178-290`. `client.rs` exposes:
```rust
pub async fn run(token: crate::ipc::token::HelperToken, stop: tokio::sync::watch::Receiver<bool>);
```
`run` loops with bounded exponential backoff (1s → 30s cap). Each iteration:
1. `connect(default_socket_path())`. On error: log, back off, retry.
2. Build `Envelope` for `auth_request` with `HelperTokenUpdate`-irrelevant `AuthRequest` payload:
   ```rust
   let id = current_identity()?;
   let auth = serde_json::json!({
     "protocolVersion": PROTOCOL_VERSION,
     "uid": id.uid, "sid": id.sid, "username": id.username,
     "sessionId": format!("assist-{}-{}", id.username, std::process::id()),
     "displayEnv": "", "pid": std::process::id(),
     "binaryHash": self_hash, "winSessionId": 0,
     "helperRole": "assist", "binaryKind": "assist_helper",
   });
   ```
   Write it as a frame with the **zero key**, seq starting at 1.
3. Read the response frame (zero key for HMAC verify of `auth_response`). If `Type == "pre_auth_reject"`: parse; if `permanent`, log a clear message and **stop** (don't retry — the binary isn't allowlisted); else back off. If `Type == "auth_response"` and `accepted == false`: same permanent/transient handling. If accepted: `hex::decode(sessionKey)` → switch the connection’s HMAC key to the session key for all subsequent frames.
4. Receive loop: for each inbound frame (verified with the session key), match `Type`:
   - `"helper_token_update"`: parse `{token}`, `token_cell.set(token).await`, log "helper token received via IPC" (NEVER log the token value).
   - `"ping"`: reply `pong` with same `ID`.
   - `"disconnect"`: break to reconnect.
   - else: ignore (assist helper handles nothing else).
   Use a read deadline / `tokio::select!` against `stop` so shutdown is prompt.
5. On any I/O error: log, break inner loop, back off, reconnect (resetting seq counters and key to zero key).

Constant-time token handling: hold the token only in `HelperToken`. Do not write it to any file or log.

- [ ] **Step 2: Build**

Run: `cd apps/helper/src-tauri && cargo build`
Expected: builds.

- [ ] **Step 3: Manual integration smoke (documented, run later on a real agent box)**

On a machine with the agent running (Windows VM or a mac with the daemon), launch the Helper and confirm the agent log shows an accepted `assist` session and the Helper log shows "helper token received via IPC". Capture one real Go→Rust frame and confirm envelope field names parse (validates the `ID/Seq/Type/Payload/Error/HMAC` key casing from Task 7). Record the result here.

- [ ] **Step 4: Commit**

```bash
git add apps/helper/src-tauri/src/ipc/client.rs
git commit -m "feat(helper/ipc): auth handshake, token receipt, reconnect loop"
```

---

### Task 11: Wire the token cell into `helper_fetch` (Phase 1: IPC-first, file fallback)

**Files:**
- Modify: `apps/helper/src-tauri/src/lib.rs` (`HttpClientState`, `ensure_http_state`, `helper_fetch` token read `:577-616`; app setup/run to spawn the IPC client)

- [ ] **Step 1: Add the token cell to shared state and spawn the client**

In `lib.rs`:
- Add a `static HELPER_TOKEN: OnceLock<crate::ipc::token::HelperToken>` and an accessor `fn helper_token() -> &'static HelperToken`.
- In the Tauri `setup` (where the app starts; search for `.setup(` / `tauri::Builder`), spawn the IPC client:
  ```rust
  let token = helper_token().clone();
  let (_tx, rx) = tokio::sync::watch::channel(false);
  tauri::async_runtime::spawn(crate::ipc::client::run(token, rx));
  ```
  (Persist `_tx` in app state if you want to signal shutdown; otherwise the task ends with the process.)

- [ ] **Step 2: Make `helper_fetch` prefer the IPC token, fall back to file (Phase 1)**

Replace the token read in `helper_fetch` (`:577-590` region) so it uses the in-memory IPC token when present, else the file-loaded `state.config.token`:
```rust
    let ipc_token = helper_token().get().await;
    let (client, file_token, api_url) = {
        let lock = get_http_state_lock();
        let guard = lock.lock().await;
        let state = guard.as_ref().ok_or_else(|| "HTTP state not initialized".to_string())?;
        (state.client.clone(), state.config.token.clone(), state.config.api_url.clone())
    };
    let token = ipc_token.unwrap_or(file_token); // Phase 1: file fallback
```
> **Phase 1 only.** Phase 2 (Task 14) removes `file_token`/the file read entirely.

> **Bootstrapping note:** `ensure_http_state()` still calls `load_agent_config_full()`, which today *requires* the token from the file (`lib.rs:127-130`). In Phase 1 the file still has the token, so this is fine. In Phase 2, `load_agent_config_full` must no longer require the token (it still needs `server_url`/`agent_id`/mTLS) — handled in Task 14.

- [ ] **Step 3: Build + existing tests**

Run: `cd apps/helper/src-tauri && cargo build && cargo test`
Expected: builds; existing tests (including the "never falls back to the full agent token" test around `lib.rs:997-1008`) still pass.

- [ ] **Step 4: Commit**

```bash
git add apps/helper/src-tauri/src/lib.rs
git commit -m "feat(helper): use IPC-delivered token in helper_fetch (Phase 1, file fallback retained)"
```

---

### Task 12: "Connecting to agent" UI state

**Files:**
- Modify: `apps/helper/src/stores/chatStore.ts` and/or `apps/helper/src/App.tsx`
- Modify: `apps/helper/src-tauri/src/lib.rs` (expose a `helper_token_ready` query command)

- [ ] **Step 1: Add a Tauri command reporting token readiness**

```rust
#[tauri::command]
async fn helper_token_ready() -> bool {
    helper_token().get().await.is_some()
}
```
Register it in the `generate_handler![]` list.

- [ ] **Step 2: Gate the chat UI on readiness**

In the frontend, before the first `helper_fetch`, poll `invoke('helper_token_ready')` (or attempt the call and treat the "still setting up" error as a connecting state). Show a lightweight "Connecting to the Breeze agent…" state until ready, then proceed. Keep this minimal — it mirrors the existing error-state handling already present for missing config.

- [ ] **Step 3: Build the frontend**

Run: `cd apps/helper && pnpm build` (or the repo’s helper build script)
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add apps/helper/src apps/helper/src-tauri/src/lib.rs
git commit -m "feat(helper/ui): show connecting state until IPC token arrives"
```

---

### Task 13: Phase-1 end-to-end verification on a real agent

**Files:** none (verification)

- [ ] **Step 1: Windows VM smoke (per windows_test_vm memory)**

Build the agent + Helper, install on the Windows test VM (`100.101.150.55`), and confirm:
- Agent log: assist session accepted (role=assist, scope=[assist]); a non-allowlisted binary connecting is rejected with `binary hash mismatch`.
- Helper log: "helper token received via IPC"; chat works.
- With the agent stopped, the Helper falls back to the file token (Phase 1) and still works; restart agent → IPC path resumes.
Record results here.

- [ ] **Step 2: macOS smoke**

Same on a mac with the daemon (unix socket path). Confirm assist session accepted and token received.

- [ ] **Step 3: Commit the verification record**

```bash
git add docs/superpowers/plans/2026-05-29-helper-ipc-token-delivery.md
git commit -m "docs: record Phase 1 e2e verification results"
```

---

# Part C — Phase 2 (separate, gated release — DO NOT ship with Phase 1)

> Ship only after adoption telemetry shows agents AND Helpers are upgraded. Tracked separately per the spec.

### Task 14: Stop writing the token to agent.yaml; remove file fallback

**Files:**
- Modify: `agent/internal/config/config.go` (`SaveTo` `:396-400`; `stripSecretsFromAgentConfig` `:484-503`; `isSecretConfigKey` `:565-571`)
- Test: `agent/internal/config/config_test.go`
- Modify: `apps/helper/src-tauri/src/lib.rs` (`helper_token_from_config`, `load_agent_config_full`, `helper_fetch`)

- [ ] **Step 1 (Go): failing test that agent.yaml has no helper token**

```go
func TestSaveToOmitsHelperTokenFromAgentYAML(t *testing.T) {
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "agent.yaml")
	cfg := &Config{ServerURL: "https://x", AgentID: "a", HelperAuthToken: "brz_helper", AuthToken: "brz_agent"}
	if err := SaveTo(cfg, cfgPath); err != nil { t.Fatal(err) }
	body, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(body), "brz_helper") || strings.Contains(string(body), "helper_auth_token") {
		t.Fatalf("agent.yaml must not contain the helper token:\n%s", body)
	}
	secrets, _ := os.ReadFile(filepath.Join(dir, "secrets.yaml"))
	if !strings.Contains(string(secrets), "brz_helper") {
		t.Fatalf("secrets.yaml must still contain the helper token")
	}
}
```

- [ ] **Step 2:** Run → FAIL (today the token is written to agent.yaml).

- [ ] **Step 3 (Go):** Remove the `viper.Set("helper_auth_token", ...)` block at `SaveTo:398-400`; add `helper_auth_token` to `stripSecretsFromAgentConfig` and `isSecretConfigKey`. Keep the `sv.Set("helper_auth_token", ...)` write to secrets.yaml (`:460-461`).

- [ ] **Step 4:** Run → PASS. Also `go test -race ./internal/config/...`.

- [ ] **Step 5 (Rust):** Remove the `agent.yaml` branch from `helper_token_from_config` (read from secrets.yaml only, or delete the fn); make `load_agent_config_full` no longer require a token (still require `server_url`/`agent_id`); remove the `file_token` fallback in `helper_fetch` (use `helper_token().get().await.ok_or("Connecting to the Breeze agent…")?`). Update the `:997-1008` test as needed.

- [ ] **Step 6:** `cargo build && cargo test`; agent `go build ./...`.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/config/ apps/helper/src-tauri/src/lib.rs
git commit -m "feat(security): stop persisting helper token to agent.yaml; IPC-only (Phase 2, closes HIGH-1)"
```

---

## Self-review notes (coverage vs. spec)

- Spec §1 (role/scope/message separation) → Tasks 1, 2, 5 (`shouldPushHelperToken` + scope gating + distinct message type).
- Spec §2 (binary trust) → Task 3.
- Spec §3 (Rust client) → Tasks 6–11.
- Spec §4 (two-phase rollout) → Phase 1 = Tasks 1–13 (agent still writes file; Helper IPC-first with fallback); Phase 2 = Task 14.
- Spec §5 (data flow) → Tasks 4 (connect push) + 5 (rotation push) + 10/11 (receipt + use).
- Spec "Error handling" → Task 10 (pre_auth_reject permanent/transient, HMAC drop+reconnect, 401→reconnect can be added in Task 11 if desired).
- Spec "Testing" → Go: Tasks 1,2,3,4,5,14; Rust: Tasks 7,8,11; e2e: Task 13.

**Known follow-ups (out of scope, noted in spec):** helper-token org-scope reduction and out-of-band approval for destructive Helper tools; Phase-2 adoption-telemetry threshold definition.
```
