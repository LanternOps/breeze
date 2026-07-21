# PAM: Wire ETW Detection → Dialog → Decision → Actuate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Issue:** LanternOps/breeze#1253 — `[Agent] PAM: wire ETW detection → dialog → decision → actuate (the etwlua trigger)`
**Deferred from:** #1152 (Tasks 4–5 of `docs/superpowers/plans/pam/2026-06-09-pam-dialog-user-helper.md`).
**Pairs with:** #1150 (dormant admin), #960 (actuator), #1163 (remote-approval / `actuate_elevation` command), #1254 (mobile bridge — separate issue).

**Goal:** When the ETW subscriber detects a UAC prompt, drive the already-built pieces (PAM dialog, decision composer, dormant-admin promote/demote, consent.exe actuator) into a single working local elevation flow: **detect → dialog → decide → actuate-or-deny**.

**Architecture:** `etwlua.handleEvent` already POSTs each detected prompt to the API, which synchronously runs the policy/rule decisioning and returns `{id, status}` (`status ∈ pending | auto_approved | denied | ignored`). Today the agent discards that body. We (1) parse it into an `ElevationOutcome`, (2) add a nil-safe `PamRunner` interface — the single, mockable edge from `etwlua` into the session broker + actuator — and (3) implement that runner on `*heartbeat.Heartbeat` (which already holds the broker, actuator, and dormant-admin manager). The runner maps the server status to `ComposePamDecision`'s verdict, shows the dialog, and on the resulting `PamAction` either actuates (promote → type creds onto consent.exe → demote) or dismisses consent.exe (new Escape path). The `await_remote` branch does nothing locally — the existing `actuate_elevation` server command (#1163) actuates when a technician approves.

**Tech Stack:** Go 1.x, `internal/etwlua` (detection), `internal/sessionbroker` (dialog round-trip + `ComposePamDecision`), `internal/heartbeat` (orchestrator + HTTP), `internal/pamactuator` (consent.exe SendInput), `internal/elevaccount` (`~breeze_elev` promote/demote), `internal/ipc` (message types + `RateLimiter`). Go standard `testing`, table-driven, `go test -race ./...`. Windows-only runtime; cross-platform code is unit-tested, the live path needs VM verification (CI gap #1000).

---

## EXISTS vs GREENFIELD

- **EXISTS (wire together, do not rebuild):**
  - `etwlua.handleEvent` dedupe + POST + offline queue (`internal/etwlua/etwlua.go:234`).
  - Server returns the decision: `POST /api/v1/agents/:id/elevation-requests` responds `{ "id": "...", "status": "pending"|"auto_approved"|"denied"|"ignored" }` (`apps/api/src/routes/agents/elevationRequests.ts`, response at line ~416 / ignored at ~264). **No server change required.**
  - Broker round-trip `Broker.RequestPamApproval(session, id, ipc.PamRequestDialog, timeout) (ipc.PamDialogResult, error)` — timeout/nil-session → `{Approved:false, DismissedByUser:true}` (`internal/sessionbroker/broker.go:1119`).
  - Session selection `Broker.FindCapableSession(capability, targetWinSession string) *Session` — `ipc.ScopePam` only matches user-role helpers (`broker.go:878`).
  - Pure decision `sessionbroker.ComposePamDecision(policyVerdict string, dialog ipc.PamDialogResult, remoteApproved *bool) PamAction` → `PamActionActuate | PamActionDeny | PamActionAwaitRemote` (`internal/sessionbroker/pam_decision.go:18`, tested in `pam_decision_test.go`). It compares `policyVerdict` against the literals `"end-user-allowed"` and `"require-approval"`.
  - Dormant admin `elevaccount.New() AccountManager` with `Promote(ctx) (Credential, error)` / `Demote(ctx) error` (`internal/elevaccount/elevaccount.go:45`, windows impl at `elevaccount_windows.go:109`).
  - Actuator `pamactuator.New() Actuator` with `Trigger(ctx, Request) Result` (`internal/pamactuator/actuator.go:82`, windows impl `actuator_windows.go:49`). `wininput.go` already defines `typeRune`, `pressVK`, `findConsentWindow`, `isWindowAlive`, and VK consts `vkTab=0x09`, `vkReturn=0x0D`.
  - Remote actuation handler `actuate_elevation` already exists (`internal/heartbeat/handlers_actuate.go:63`) and the `*Heartbeat` already owns `sessionBroker *sessionbroker.Broker` (`heartbeat.go:161`) plus the swappable test seams `newActuator = pamactuator.New` and `newElevationAccountManager = elevaccount.New`.
- **GREENFIELD (this plan builds):**
  1. Parsing the POST response into `etwlua.ElevationOutcome` (the agent currently throws the body away).
  2. The `etwlua.PamRunner` interface seam + threading it through `Start`/`handleEvent` (nil-safe).
  3. The orchestrator `(*Heartbeat).RunPamFlow` that maps status → verdict → dialog → `PamAction` → actuate/deny/await.
  4. The consent.exe **denial** path: `vkEscape` const + `Actuator.Dismiss(ctx) Result` (only the approve path exists today).
  5. Refactoring the actuate core out of `handleActuateElevation` into a shared `(*Heartbeat).actuateElevation` so the remote command and the local flow share one code path (DRY).

## Status → verdict mapping (the one design decision)

| Server `status` | Dialog shown? | `ComposePamDecision` verdict | Then |
|---|---|---|---|
| `ignored` | no | — | do nothing (filtered before the runner is called) |
| `denied` | no | — | `denyConsent` immediately (policy hard-deny) |
| `auto_approved` | yes (end-user consent gate) | `"end-user-allowed"` | approve→actuate, deny→denyConsent |
| `pending` | yes | `"require-approval"` | approve→`await_remote` (server actuates via `actuate_elevation`), deny→denyConsent |

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `agent/internal/etwlua/etwlua.go` | `ElevationOutcome` type; `HeartbeatPoster.SendElevationRequest` return change; `PamRunner` interface; thread `ctx`+`pam` through `Start`/`handleEvent` | Modify |
| `agent/internal/etwlua/queue.go` | `Drain` call site discards new return value | Modify (1 line) |
| `agent/internal/etwlua/etwlua_test.go` | Update `fakeHB`; add `fakePamRunner` + runner-invocation tests | Modify |
| `agent/internal/heartbeat/handlers_elevation.go` | Parse `{id,status}` → return `etwlua.ElevationOutcome` | Modify |
| `agent/internal/heartbeat/handlers_elevation_test.go` | Test response parsing | Create (or extend if present) |
| `agent/internal/heartbeat/pam_flow.go` | `RunPamFlow`, `buildPamRequestDialog`, `denyConsent`, `actuateElevation`, constants | Create |
| `agent/internal/heartbeat/pam_flow_test.go` | Table test for `RunPamFlow` status→action mapping | Create |
| `agent/internal/heartbeat/handlers_actuate.go` | `handleActuateElevation` delegates to shared `actuateElevation` | Modify |
| `agent/internal/pamactuator/actuator.go` | Add `Dismiss(ctx) Result` to the `Actuator` interface | Modify |
| `agent/internal/pamactuator/actuator_windows.go` | Implement `Dismiss` (open desktop → Escape consent.exe) | Modify |
| `agent/internal/pamactuator/actuator_other.go` | Stub `Dismiss` → `{Success:false, Reason:"unsupported_platform"}` | Modify |
| `agent/internal/pamactuator/wininput.go` | Add `vkEscape = 0x1B` | Modify |
| `agent/cmd/breeze-agent/etwlua_start_windows.go` | Pass `hb` as the `PamRunner` arg | Modify |

---

## Task 1 — Parse the server decision into `ElevationOutcome`

**Files:**
- Modify: `agent/internal/etwlua/etwlua.go` (add type + change `HeartbeatPoster`)
- Modify: `agent/internal/heartbeat/handlers_elevation.go:28-54`
- Modify: `agent/internal/etwlua/queue.go` (the one `hb.SendElevationRequest` call in `Drain`)
- Test: `agent/internal/heartbeat/handlers_elevation_test.go`

- [ ] **Step 1: Add the `ElevationOutcome` type and change the interface in `etwlua.go`**

Add near the `Event` type (after line ~121) in `agent/internal/etwlua/etwlua.go`:

```go
// ElevationOutcome is the server's synchronous ingest decision for a posted
// uac_intercept elevation request, parsed from the POST response body
// {"id":"<uuid>","status":"<status>"}. Status is one of "pending",
// "auto_approved", "denied", or "ignored". RequestID is empty when the
// server suppressed the request (status "ignored", id null).
type ElevationOutcome struct {
	RequestID string
	Status    string
}
```

Change the `HeartbeatPoster` interface method (currently `SendElevationRequest(req Event) error`):

```go
type HeartbeatPoster interface {
	// SendElevationRequest posts the detected prompt and returns the
	// server's ingest decision. A non-nil error means the post failed
	// (network/5xx) and the event should be queued for retry.
	SendElevationRequest(req Event) (ElevationOutcome, error)
	IsUACInterceptionEnabled() bool
}
```

- [ ] **Step 2: Write the failing parse test**

Create/extend `agent/internal/heartbeat/handlers_elevation_test.go`:

```go
package heartbeat

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/breeze-rmm/agent/internal/etwlua"
)

func TestSendElevationRequestParsesDecision(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"id":"req-123","status":"auto_approved"}`))
	}))
	defer srv.Close()

	h := newTestHeartbeat(t, srv.URL) // see note below
	out, err := h.SendElevationRequest(etwlua.Event{TargetExecutablePath: `C:\x.exe`, SubjectUsername: "alice"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if out.RequestID != "req-123" || out.Status != "auto_approved" {
		t.Fatalf("got %+v, want {req-123 auto_approved}", out)
	}
}

func TestSendElevationRequestErrorOnNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()

	h := newTestHeartbeat(t, srv.URL)
	if _, err := h.SendElevationRequest(etwlua.Event{}); err == nil {
		t.Fatal("expected error on 500")
	}
}
```

Note: reuse the existing heartbeat test constructor if one exists in this package (grep `func newTestHeartbeat` / how other `handlers_*_test.go` build a `*Heartbeat` with a `config.ServerURL`, `httpClient`, `retryCfg`). If none exists, build the minimal `*Heartbeat{config: ..., ...}` the same way the nearest existing handler test does. Do not invent new helper signatures.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run TestSendElevationRequest -v`
Expected: FAIL — `SendElevationRequest` still returns a single value / does not compile.

- [ ] **Step 4: Implement the parse in `handlers_elevation.go`**

Replace the body of `SendElevationRequest` (lines 28-54). New signature + parse the success body:

```go
func (h *Heartbeat) SendElevationRequest(req etwlua.Event) (etwlua.ElevationOutcome, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return etwlua.ElevationOutcome{}, fmt.Errorf("marshal elevation request: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/elevation-requests", h.config.ServerURL, h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		return etwlua.ElevationOutcome{}, fmt.Errorf("post elevation request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return etwlua.ElevationOutcome{}, fmt.Errorf("elevation-requests returned status %d: %s", resp.StatusCode, string(errBody))
	}

	// Parse the server's ingest decision. A malformed/empty body is not
	// fatal — the post succeeded; we just have no local flow to drive.
	var decoded struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
	_ = json.Unmarshal(respBody, &decoded)
	return etwlua.ElevationOutcome{RequestID: decoded.ID, Status: decoded.Status}, nil
}
```

- [ ] **Step 5: Fix the `Drain` call site in `queue.go`**

`Queue.Drain` re-posts queued events via `hb.SendElevationRequest`. Drained events are post-hoc (the consent.exe prompt is long gone) so the outcome is discarded. Find the call in `agent/internal/etwlua/queue.go` and change:

```go
// before:  if err := hb.SendElevationRequest(ev); err != nil {
// after:
if _, err := hb.SendElevationRequest(ev); err != nil {
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd agent && go test ./internal/heartbeat/ -run TestSendElevationRequest -v && go build ./...`
Expected: PASS, and the whole module still builds (the `etwlua` callers compile against the new signature only after Task 2 — if `go build ./...` flags `etwlua`/`cmd` here, that is expected; complete Task 2 before the final build). To keep this task self-contained, build just the two packages: `go build ./internal/heartbeat/ ./internal/etwlua/` — `etwlua` will fail to build until Step 7.

- [ ] **Step 7: Make `etwlua` compile against the new interface (minimal)**

In `etwlua.go` `handleEvent`, the existing call `if err := hb.SendElevationRequest(ev); err != nil {` must become `if _, err := hb.SendElevationRequest(ev); err != nil {` (Task 2 adds the real use of the outcome). This keeps the package compiling.

- [ ] **Step 8: Commit**

```bash
cd agent && git add internal/etwlua/etwlua.go internal/etwlua/queue.go internal/heartbeat/handlers_elevation.go internal/heartbeat/handlers_elevation_test.go
git commit -m "feat(agent/pam): parse server ingest decision into ElevationOutcome"
```

---

## Task 2 — `PamRunner` interface seam + thread through `Start`/`handleEvent`

**Files:**
- Modify: `agent/internal/etwlua/etwlua.go` (`PamRunner` type; `Start` + `handleEvent` signatures)
- Modify: `agent/internal/etwlua/etwlua_test.go` (update `fakeHB`; add `fakePamRunner`; update `Start`/`handleEvent` call sites)

- [ ] **Step 1: Add the `PamRunner` interface in `etwlua.go`**

After the `HeartbeatPoster` interface:

```go
// PamRunner drives the local elevation flow (dialog → decision →
// actuate/deny) for one detected UAC prompt, using the server's ingest
// decision. It is the single edge from etwlua into the session broker +
// actuator, kept behind an interface so etwlua stays unit-testable without
// a live broker or Windows. A nil PamRunner disables the flow (detection +
// post only) — used on non-Windows builds and when the broker is absent.
//
// Implementations must be non-blocking-forever: bound the dialog round-trip
// to consent.exe's lifetime. RunPamFlow is called synchronously from the
// event loop; UAC prompts are modal and serial, so one in-flight flow at a
// time is correct.
type PamRunner interface {
	RunPamFlow(ctx context.Context, ev Event, outcome ElevationOutcome)
}
```

Add the `context` import if not already present.

- [ ] **Step 2: Write failing tests in `etwlua_test.go`**

First update the existing `fakeHB` (lines ~16-48) so `SendElevationRequest` matches the new interface — return a configurable outcome:

```go
type fakeHB struct {
	mu        sync.Mutex
	posts     []etwlua.Event
	postErr   error
	outcome   etwlua.ElevationOutcome // returned on success
	enabled   bool
}

func (f *fakeHB) SendElevationRequest(ev etwlua.Event) (etwlua.ElevationOutcome, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.posts = append(f.posts, ev)
	if f.postErr != nil {
		return etwlua.ElevationOutcome{}, f.postErr
	}
	return f.outcome, nil
}

func (f *fakeHB) IsUACInterceptionEnabled() bool { return f.enabled }
```

(Preserve any existing fields/methods the current `fakeHB` has — only add `outcome` and change the `SendElevationRequest` return. Update every existing test that constructs `fakeHB{...}` to set `enabled: true` if it relied on the old default, and to call the new `handleEvent` signature from Step 4.)

Add a fake runner and tests:

```go
type fakePamRunner struct {
	mu    sync.Mutex
	calls []etwlua.ElevationOutcome
}

func (f *fakePamRunner) RunPamFlow(_ context.Context, _ etwlua.Event, out etwlua.ElevationOutcome) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, out)
}

func TestHandleEventInvokesPamRunnerOnSuccess(t *testing.T) {
	hb := &fakeHB{enabled: true, outcome: etwlua.ElevationOutcome{RequestID: "r1", Status: "auto_approved"}}
	pam := &fakePamRunner{}
	limiter := ipc.NewRateLimiter(1, time.Minute)
	etwlua.HandleEventForTest(context.Background(), etwlua.Event{TargetExecutablePath: "a", SubjectUsername: "u"}, limiter, hb, nil, pam)
	if len(pam.calls) != 1 || pam.calls[0].RequestID != "r1" || pam.calls[0].Status != "auto_approved" {
		t.Fatalf("runner calls = %+v, want one {r1 auto_approved}", pam.calls)
	}
}

func TestHandleEventSkipsPamRunnerWhenIgnored(t *testing.T) {
	hb := &fakeHB{enabled: true, outcome: etwlua.ElevationOutcome{RequestID: "", Status: "ignored"}}
	pam := &fakePamRunner{}
	etwlua.HandleEventForTest(context.Background(), etwlua.Event{}, ipc.NewRateLimiter(1, time.Minute), hb, nil, pam)
	if len(pam.calls) != 0 {
		t.Fatalf("runner should not fire for ignored, got %+v", pam.calls)
	}
}

func TestHandleEventSkipsPamRunnerWhenNil(t *testing.T) {
	hb := &fakeHB{enabled: true, outcome: etwlua.ElevationOutcome{RequestID: "r1", Status: "pending"}}
	// nil runner must not panic
	etwlua.HandleEventForTest(context.Background(), etwlua.Event{}, ipc.NewRateLimiter(1, time.Minute), hb, nil, nil)
}

func TestHandleEventDoesNotInvokeRunnerOnPostFailure(t *testing.T) {
	hb := &fakeHB{enabled: true, postErr: errors.New("boom")}
	pam := &fakePamRunner{}
	etwlua.HandleEventForTest(context.Background(), etwlua.Event{}, ipc.NewRateLimiter(1, time.Minute), hb, nil, pam)
	if len(pam.calls) != 0 {
		t.Fatalf("runner should not fire on post failure, got %+v", pam.calls)
	}
}
```

`handleEvent` is unexported; expose a thin test shim in `etwlua.go` (export-for-test pattern, same package would be simpler but the existing tests use `package etwlua_test` — keep that). Add to `etwlua.go`:

```go
// HandleEventForTest exposes handleEvent for black-box tests in this
// package. Not for production use.
func HandleEventForTest(ctx context.Context, ev Event, limiter *ipc.RateLimiter, hb HeartbeatPoster, q *Queue, pam PamRunner) {
	handleEvent(ctx, ev, limiter, hb, q, pam)
}
```

(If the existing tests are white-box `package etwlua`, call `handleEvent` directly instead and skip the shim.)

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd agent && go test ./internal/etwlua/ -run TestHandleEvent -v`
Expected: FAIL — `handleEvent`/`HandleEventForTest` don't take `ctx`/`pam` yet.

- [ ] **Step 4: Change `handleEvent` and `Start` signatures**

In `etwlua.go`, change `handleEvent` to accept `ctx` and `pam` and invoke the runner after a successful post:

```go
func handleEvent(ctx context.Context, ev Event, limiter *ipc.RateLimiter, hb HeartbeatPoster, q *Queue, pam PamRunner) {
	// ... unchanged: interception-disabled gate, re-enable log, dedupe ...

	outcome, err := hb.SendElevationRequest(ev)
	if err != nil {
		log.Warn("etwlua: post failed, queueing",
			"user", ev.SubjectUsername, "path", ev.TargetExecutablePath, "error", err.Error())
		if q != nil {
			if qerr := q.Enqueue(ev); qerr != nil {
				log.Error("etwlua: enqueue failed; event dropped", "error", qerr.Error())
			}
		}
		return
	}

	log.Debug("etwlua: event posted", "user", ev.SubjectUsername, "path", ev.TargetExecutablePath)

	// Drive the local elevation flow. The dedupe above already prevents
	// stacked dialogs for re-fired ETW events on one prompt.
	if pam != nil && outcome.RequestID != "" && outcome.Status != "ignored" {
		pam.RunPamFlow(ctx, ev, outcome)
	}

	if q != nil && hb.IsUACInterceptionEnabled() {
		if _, derr := q.Drain(hb); derr != nil {
			log.Debug("etwlua: opportunistic drain failed", "error", derr.Error())
		}
	}
}
```

Change `Start` to accept and pass `pam`:

```go
func Start(ctx context.Context, sub Subscriber, hb HeartbeatPoster, pam PamRunner) error {
	// ... unchanged setup ...
	for {
		select {
		case <-ctx.Done():
			// ...
		case ev, ok := <-sub.Events():
			// ... unchanged zero-time fill ...
			handleEvent(ctx, ev, limiter, hb, q, pam)
		case <-ticker.C:
			// ... unchanged ...
		}
	}
}
```

Update the existing `TestStartReturnsOnContextCancel` to pass `nil` for the new `pam` arg.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd agent && go test ./internal/etwlua/ -race -v`
Expected: PASS (all existing + 4 new tests).

- [ ] **Step 6: Commit**

```bash
cd agent && git add internal/etwlua/etwlua.go internal/etwlua/etwlua_test.go
git commit -m "feat(agent/pam): add nil-safe PamRunner seam to the etwlua hot path"
```

---

## Task 3 — Consent.exe denial path: `vkEscape` + `Actuator.Dismiss`

**Files:**
- Modify: `agent/internal/pamactuator/wininput.go` (add `vkEscape`)
- Modify: `agent/internal/pamactuator/actuator.go` (interface)
- Modify: `agent/internal/pamactuator/actuator_windows.go` (impl)
- Modify: `agent/internal/pamactuator/actuator_other.go` (stub)
- Test: `agent/internal/pamactuator/actuator_test.go` (cross-platform stub behavior)

- [ ] **Step 1: Add `vkEscape` in `wininput.go`**

In the const block (currently `vkTab = 0x09`, `vkReturn = 0x0D`):

```go
const (
	vkTab    = 0x09
	vkReturn = 0x0D
	vkEscape = 0x1B
)
```

- [ ] **Step 2: Write the failing stub test**

In `agent/internal/pamactuator/actuator_test.go` (this runs on the dev/CI host, which is non-Windows → exercises the `_other` stub):

```go
//go:build !windows

package pamactuator

import (
	"context"
	"testing"
)

func TestDismissUnsupportedOnNonWindows(t *testing.T) {
	res := New().Dismiss(context.Background())
	if res.Success {
		t.Fatal("Dismiss should not succeed on non-windows")
	}
	if res.Reason != "unsupported_platform" {
		t.Fatalf("reason = %q, want unsupported_platform", res.Reason)
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd agent && go test ./internal/pamactuator/ -run TestDismiss -v`
Expected: FAIL — `Dismiss` not defined on the `Actuator` interface.

- [ ] **Step 4: Add `Dismiss` to the interface in `actuator.go`**

```go
type Actuator interface {
	// Trigger types the dormant-admin credential onto the live consent.exe
	// prompt (approve path).
	Trigger(ctx context.Context, req Request) Result
	// Dismiss cancels the live consent.exe prompt by sending Escape on the
	// input desktop (deny path). Returns Reason "ok" on a confirmed close,
	// "no_consent_window" if none was found, or a desktop-attach failure
	// reason mirroring Trigger.
	Dismiss(ctx context.Context) Result
}
```

- [ ] **Step 5: Implement the non-Windows stub in `actuator_other.go`**

```go
func (a *otherActuator) Dismiss(_ context.Context) Result {
	return Result{Success: false, Reason: "unsupported_platform", DetailMessage: "consent dismissal only supported on Windows"}
}
```

(Match the receiver type name used by the existing `Trigger` stub in this file.)

- [ ] **Step 6: Implement `Dismiss` in `actuator_windows.go`**

Mirror `Trigger`'s desktop-attach scaffolding (lines ~49-95), then send Escape instead of typing creds:

```go
func (a *windowsActuator) Dismiss(ctx context.Context) Result {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hDesk, err := openInputDesktop()
	if err != nil {
		return Result{Success: false, Reason: "desktop_open_failed", DetailMessage: err.Error()}
	}
	defer closeDesktop(hDesk)

	if err := setThreadDesktop(hDesk); err != nil {
		return Result{Success: false, Reason: "set_thread_desktop_failed", DetailMessage: err.Error()}
	}

	hwnd, ok := waitForConsent(ctx) // reuse the existing poll helper
	if !ok {
		return Result{Success: false, Reason: "no_consent_window", DetailMessage: "consent.exe window not found"}
	}

	if err := pressVK(vkEscape); err != nil {
		return Result{Success: false, Reason: "send_input_failed", DetailMessage: err.Error()}
	}

	if !waitForConsentClose(ctx, hwnd) {
		return Result{Success: false, Reason: "consent_did_not_close", DetailMessage: "consent.exe still open after Escape"}
	}
	return Result{Success: true, Reason: "ok"}
}
```

Use the **exact** names of the existing private helpers in this file (`openInputDesktop`/`OpenInputDesktop`, `closeDesktop`, `setThreadDesktop`/`SetThreadDesktop`, `waitForConsent`, `waitForConsentClose`). Read the file first and match them — do not introduce new helper names. If `waitForConsent`/`waitForConsentClose` take different args (e.g. a timeout rather than ctx), match their real signatures.

- [ ] **Step 7: Run tests + Windows build**

Run: `cd agent && go test ./internal/pamactuator/ -v && GOOS=windows go build ./internal/pamactuator/`
Expected: PASS; Windows cross-compile succeeds.

- [ ] **Step 8: Commit**

```bash
cd agent && git add internal/pamactuator/
git commit -m "feat(agent/pam): add consent.exe Dismiss (Escape) deny path to actuator"
```

---

## Task 4 — Refactor the actuate core into a shared `(*Heartbeat).actuateElevation`

**Files:**
- Modify: `agent/internal/heartbeat/handlers_actuate.go` (extract helper; `handleActuateElevation` delegates)
- Test: existing `handlers_actuate` tests must stay green (no new test needed; this is a pure refactor verified by existing coverage)

- [ ] **Step 1: Confirm the existing tests pass (baseline)**

Run: `cd agent && go test ./internal/heartbeat/ -run Actuate -v`
Expected: PASS (record which tests run; they are the regression guard for this refactor).

- [ ] **Step 2: Extract the shared helper**

Add to `handlers_actuate.go`:

```go
// actuateElevation runs the dormant-admin promote → consent.exe type →
// guaranteed-demote pipeline and returns the actuator result. Shared by the
// remote actuate_elevation command handler and the local etwlua-driven flow.
func (h *Heartbeat) actuateElevation(ctx context.Context, requestID string, timeoutMs int) pamactuator.Result {
	manager := newElevationAccountManager()
	cred, err := manager.Promote(ctx)
	if err != nil {
		return pamactuator.Result{
			Success:       false,
			Reason:        promoteFailureReason(err),
			DetailMessage: err.Error(),
		}
	}
	defer func() {
		demoteCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if derr := manager.Demote(demoteCtx); derr != nil {
			log.Warn("actuate_elevation: demote failed", "elevationRequestId", requestID, "error", derr.Error())
		}
	}()
	defer zeroCredential(&cred)

	return newActuator().Trigger(ctx, pamactuator.Request{
		ElevationRequestID: requestID,
		Username:           cred.Username,
		Password:           cred.Password,
		TimeoutMs:          timeoutMs,
	})
}
```

- [ ] **Step 3: Rewrite `handleActuateElevation` to delegate**

Replace the promote/defer-demote/trigger body (lines ~80-118) with a call to the helper, preserving the existing context-bounding and result mapping:

```go
func handleActuateElevation(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	payload, err := parseActuatePayload(cmd.Payload)
	if err != nil {
		return tools.NewErrorResult(err, time.Since(start).Milliseconds())
	}

	timeout := time.Duration(payload.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*timeout)
	defer cancel()

	res := h.actuateElevation(ctx, payload.ElevationRequestID, payload.TimeoutMs)

	out := actuateResult{
		ElevationRequestID: payload.ElevationRequestID,
		Success:            res.Success,
		Reason:             res.Reason,
		Message:            res.DetailMessage,
	}
	return tools.NewSuccessResult(out, time.Since(start).Milliseconds())
}
```

Note: the prior handler returned the promote-failure as a `NewSuccessResult` (completed-with-failure). The helper now folds promote failure into `res` (Success:false, Reason from `promoteFailureReason`), and the handler wraps `res` in `NewSuccessResult` — so the server still always sees a JSON body. Behavior preserved. (`handleActuateElevation` ignores its `*Heartbeat` param today via `_`; switch it to `h` so it can call the method.)

- [ ] **Step 4: Run the regression tests**

Run: `cd agent && go test ./internal/heartbeat/ -run Actuate -race -v`
Expected: PASS — same tests as Step 1, unchanged behavior.

- [ ] **Step 5: Commit**

```bash
cd agent && git add internal/heartbeat/handlers_actuate.go
git commit -m "refactor(agent/pam): share actuate core between remote command and local flow"
```

---

## Task 5 — The orchestrator `(*Heartbeat).RunPamFlow`

**Files:**
- Create: `agent/internal/heartbeat/pam_flow.go`
- Create: `agent/internal/heartbeat/pam_flow_test.go`
- Modify: `agent/internal/heartbeat/heartbeat.go` (add two swappable test-seam fields to the struct)

- [ ] **Step 1: Add swappable dialog seams to the `Heartbeat` struct**

In `heartbeat.go`, beside `helperFinder` (line 165), add two nil-able fields (lazy defaults are applied in `RunPamFlow`, so no init-block change is required):

```go
	helperFinder     func(targetSession string) *sessionbroker.Session
	// pamFindSession / pamRequestDialog default to the real broker methods
	// in RunPamFlow when nil; overridden in pam_flow_test.go.
	pamFindSession   func(capability, targetWinSession string) *sessionbroker.Session
	pamRequestDialog func(session *sessionbroker.Session, id string, req ipc.PamRequestDialog, timeout time.Duration) (ipc.PamDialogResult, error)
```

- [ ] **Step 2: Write the failing table test in `pam_flow_test.go`**

```go
package heartbeat

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/elevaccount"
	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// fakeActuator records which path fired.
type fakeActuator struct{ triggered, dismissed bool }

func (f *fakeActuator) Trigger(_ context.Context, _ pamactuator.Request) pamactuator.Result {
	f.triggered = true
	return pamactuator.Result{Success: true, Reason: "ok"}
}
func (f *fakeActuator) Dismiss(_ context.Context) pamactuator.Result {
	f.dismissed = true
	return pamactuator.Result{Success: true, Reason: "ok"}
}

type fakeAccount struct{ promoted, demoted bool }

func (f *fakeAccount) EnsureProvisioned() error { return nil }
func (f *fakeAccount) Promote(_ context.Context) (elevaccount.Credential, error) {
	f.promoted = true
	return elevaccount.Credential{Username: "~breeze_elev", Password: "pw"}, nil
}
func (f *fakeAccount) Demote(_ context.Context) error { f.demoted = true; return nil }

func TestRunPamFlow(t *testing.T) {
	approve := ipc.PamDialogResult{Approved: true}
	deny := ipc.PamDialogResult{Approved: false, DismissedByUser: true}

	cases := []struct {
		name           string
		status         string
		dialog         ipc.PamDialogResult
		noSession      bool
		wantTriggered  bool
		wantDismissed  bool
	}{
		{"policy denied → dismiss, no dialog", "denied", approve, false, false, true},
		{"auto_approved + approve → actuate", "auto_approved", approve, false, true, false},
		{"auto_approved + user deny → dismiss", "auto_approved", deny, false, false, true},
		{"pending + approve → await (nothing)", "pending", approve, false, false, false},
		{"pending + user deny → dismiss", "pending", deny, false, false, true},
		{"no capable session → nothing", "auto_approved", approve, true, false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			act := &fakeActuator{}
			acct := &fakeAccount{}
			restoreAct := swapActuatorForTest(func() pamactuator.Actuator { return act })
			defer restoreAct()
			restoreAcct := swapAccountForTest(func() elevaccount.AccountManager { return acct })
			defer restoreAcct()

			h := &Heartbeat{
				pamFindSession: func(string, string) *sessionbroker.Session {
					if tc.noSession {
						return nil
					}
					return &sessionbroker.Session{}
				},
				pamRequestDialog: func(*sessionbroker.Session, string, ipc.PamRequestDialog, time.Duration) (ipc.PamDialogResult, error) {
					return tc.dialog, nil
				},
			}

			h.RunPamFlow(context.Background(), etwlua.Event{TargetExecutablePath: `C:\x.exe`}, etwlua.ElevationOutcome{RequestID: "r1", Status: tc.status})

			if act.triggered != tc.wantTriggered {
				t.Errorf("triggered = %v, want %v", act.triggered, tc.wantTriggered)
			}
			if act.dismissed != tc.wantDismissed {
				t.Errorf("dismissed = %v, want %v", act.dismissed, tc.wantDismissed)
			}
			if tc.wantTriggered && (!acct.promoted || !acct.demoted) {
				t.Errorf("actuate must promote(%v) and demote(%v)", acct.promoted, acct.demoted)
			}
		})
	}
}
```

This test references `swapActuatorForTest` / `swapAccountForTest`. The mapping mentioned `swapActuatorForTest` already exists for `newActuator`; if `swapAccountForTest` does not exist, add the trivial swap helpers next to the `newActuator`/`newElevationAccountManager` vars:

```go
func swapActuatorForTest(fn func() pamactuator.Actuator) func() {
	prev := newActuator
	newActuator = fn
	return func() { newActuator = prev }
}
func swapAccountForTest(fn func() elevaccount.AccountManager) func() {
	prev := newElevationAccountManager
	newElevationAccountManager = fn
	return func() { newElevationAccountManager = prev }
}
```

(If `swapActuatorForTest` already exists, reuse it and only add `swapAccountForTest`.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd agent && go test ./internal/heartbeat/ -run TestRunPamFlow -v`
Expected: FAIL — `RunPamFlow` not defined.

- [ ] **Step 4: Implement `pam_flow.go`**

```go
package heartbeat

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	// These literals must match sessionbroker.ComposePamDecision's expected
	// policyVerdict values (pam_decision.go). Do not change without changing both.
	pamVerdictEndUserAllowed  = "end-user-allowed"
	pamVerdictRequireApproval = "require-approval"

	// pamDialogTimeout bounds the broker round-trip to comfortably under
	// consent.exe's idle lifetime (~120s default). Timeout → deny+dismiss.
	pamDialogTimeout = 90 * time.Second

	// defaultActuateTimeoutMs is the per-actuation consent.exe wait (mirrors
	// the remote handler's 8s default).
	defaultActuateTimeoutMs = 8000
)

// RunPamFlow implements etwlua.PamRunner. Given the server's ingest decision
// for a detected UAC prompt, it shows the user-desktop PAM dialog (when the
// status warrants it), composes the decision, and either actuates locally
// (end-user-allowed) or dismisses consent.exe (deny). The require-approval
// path resolves remotely: the server issues an actuate_elevation command
// (handlers_actuate.go) once a technician approves.
func (h *Heartbeat) RunPamFlow(ctx context.Context, ev etwlua.Event, outcome etwlua.ElevationOutcome) {
	switch outcome.Status {
	case "denied":
		// Policy hard-deny — no dialog; cancel the prompt immediately.
		h.denyConsent(ctx, outcome.RequestID, "policy_denied")
		return
	case "auto_approved", "pending":
		// fall through to the dialog gate
	default:
		log.Debug("pam: no local flow for status", "status", outcome.Status, "elevationRequestId", outcome.RequestID)
		return
	}

	find := h.pamFindSession
	if find == nil {
		find = h.sessionBroker.FindCapableSession
	}
	session := find(ipc.ScopePam, "")
	if session == nil {
		log.Warn("pam: no capable user-helper session; cannot show dialog, consent.exe will time out",
			"elevationRequestId", outcome.RequestID)
		return
	}

	ask := h.pamRequestDialog
	if ask == nil {
		ask = h.sessionBroker.RequestPamApproval
	}
	dialog, err := ask(session, outcome.RequestID, buildPamRequestDialog(ev), pamDialogTimeout)
	if err != nil {
		// RequestPamApproval already returns deny+dismiss on error, but be defensive.
		log.Warn("pam: dialog round-trip error; treating as deny", "elevationRequestId", outcome.RequestID, "error", err.Error())
		dialog = ipc.PamDialogResult{Approved: false, DismissedByUser: true}
	}

	verdict := pamVerdictEndUserAllowed
	if outcome.Status == "pending" {
		verdict = pamVerdictRequireApproval
	}

	switch sessionbroker.ComposePamDecision(verdict, dialog, nil) {
	case sessionbroker.PamActionActuate:
		res := h.actuateElevation(ctx, outcome.RequestID, defaultActuateTimeoutMs)
		log.Info("pam: local actuation complete",
			"elevationRequestId", outcome.RequestID, "success", res.Success, "reason", res.Reason)
	case sessionbroker.PamActionDeny:
		h.denyConsent(ctx, outcome.RequestID, dialog.Reason)
	case sessionbroker.PamActionAwaitRemote:
		log.Info("pam: awaiting remote technician approval; server will issue actuate_elevation",
			"elevationRequestId", outcome.RequestID)
	}
}

// denyConsent cancels the live consent.exe prompt and logs the denial.
// Server-side audit of the local decision is a follow-up (no agent→server
// outcome endpoint exists yet; the remote/mobile mirror is #1254).
func (h *Heartbeat) denyConsent(ctx context.Context, requestID, reason string) {
	res := newActuator().Dismiss(ctx)
	log.Info("pam: denied elevation, dismissed consent prompt",
		"elevationRequestId", requestID, "reason", reason,
		"dismiss_success", res.Success, "dismiss_reason", res.Reason)
}

// buildPamRequestDialog maps a detected ETW event onto the dialog payload.
// Reason/IntentSummary are left empty (AI intent summary is Phase 2).
func buildPamRequestDialog(ev etwlua.Event) ipc.PamRequestDialog {
	return ipc.PamRequestDialog{
		ExePath:     ev.TargetExecutablePath,
		Signer:      ev.TargetExecutableSigner,
		Hash:        ev.TargetExecutableHash,
		SubjectUser: ev.SubjectUsername,
		CommandLine: ev.CommandLine,
	}
}
```

Before writing, **read `internal/ipc/message.go`** to confirm the exact `PamRequestDialog` field names (`ExePath`, `Signer`, `Hash`, `SubjectUser`, `CommandLine`, `Reason`, `IntentSummary`) and `PamDialogResult` (`Approved`, `Reason`, `DismissedByUser`), and confirm `ipc.ScopePam` is the const name. Adjust field names to match reality if they differ.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd agent && go test ./internal/heartbeat/ -run TestRunPamFlow -race -v`
Expected: PASS (all 6 table cases).

- [ ] **Step 6: Full package test + Windows build**

Run: `cd agent && go test ./internal/heartbeat/ -race && GOOS=windows go build ./...`
Expected: PASS; Windows cross-compile succeeds.

- [ ] **Step 7: Commit**

```bash
cd agent && git add internal/heartbeat/pam_flow.go internal/heartbeat/pam_flow_test.go internal/heartbeat/heartbeat.go
git commit -m "feat(agent/pam): RunPamFlow orchestrator — dialog → decision → actuate/deny"
```

---

## Task 6 — Wire the runner at agent startup

**Files:**
- Modify: `agent/cmd/breeze-agent/etwlua_start_windows.go:28-50`

- [ ] **Step 1: Pass `hb` as the `PamRunner`**

`*heartbeat.Heartbeat` now satisfies both `etwlua.HeartbeatPoster` and `etwlua.PamRunner`. Update the `Start` call in `startETWLua`:

```go
	go func() {
		defer close(done)
		if err := etwlua.Start(ctx, sub, hb, hb); err != nil { // hb is both poster and runner
			log.Warn("etwlua Start returned error", "error", err.Error())
		}
	}()
```

- [ ] **Step 2: Verify the non-Windows path still compiles**

If a non-Windows `startETWLua` stub or any other `etwlua.Start` caller exists, ensure it passes a `PamRunner` (or `nil`). Grep:

Run: `cd agent && grep -rn "etwlua.Start(" cmd/ internal/`
For each call site, ensure arity matches the new 4-arg signature (pass `nil` where there is no runner).

- [ ] **Step 3: Build both targets**

Run: `cd agent && go build ./... && GOOS=windows go build ./...`
Expected: both succeed.

- [ ] **Step 4: Commit**

```bash
cd agent && git add cmd/breeze-agent/etwlua_start_windows.go
git commit -m "feat(agent/pam): wire RunPamFlow into etwlua startup"
```

---

## Task 7 — Full suite + cross-compile gate

- [ ] **Step 1: Race the touched packages**

Run: `cd agent && go test -race ./internal/etwlua/ ./internal/heartbeat/ ./internal/pamactuator/ ./internal/sessionbroker/`
Expected: PASS.

- [ ] **Step 2: Windows cross-compile (the runtime target)**

Run: `cd agent && GOOS=windows GOARCH=amd64 go build ./...`
Expected: success — this is the only compile-time check CI gives us for the Windows path (runtime gap is #1000).

- [ ] **Step 3: `go vet`**

Run: `cd agent && go vet ./internal/etwlua/ ./internal/heartbeat/ ./internal/pamactuator/`
Expected: clean.

- [ ] **Step 4: Commit any fixups**

```bash
cd agent && git add -A && git commit -m "test(agent/pam): green race + windows cross-compile for etwlua wiring" || echo "nothing to commit"
```

---

## Manual VM verification (Windows — gated, not CI; tracks #1000)

Run on a throwaway Windows VM with the agent installed as a SYSTEM service and a user logged into the interactive console (so a `pam`-scoped user helper is connected). For each, watch agent diagnostic logs (`component=pam` / `etwlua`).

- [ ] **Auto-approved path:** Configure a PAM rule/software-policy that auto-approves a chosen signed exe. Trigger its UAC prompt. Expect: Breeze dialog appears on the user desktop within ~1s → click Approve → `~breeze_elev` is promoted → creds typed onto consent.exe → consent closes (app elevates) → `~breeze_elev` demoted. Confirm the account is disabled again afterward (`net user ~breeze_elev`).
- [ ] **End-user deny:** Same rule; click Deny on the Breeze dialog. Expect: consent.exe is dismissed via Escape (prompt closes, app does not elevate); log shows `dismiss_success=true`.
- [ ] **Policy hard-deny:** Configure a blocklist rule for an exe. Trigger it. Expect: **no** Breeze dialog; consent.exe dismissed immediately; log `reason=policy_denied`.
- [ ] **Require-approval / await_remote:** Configure a rule with no auto-decision (→ `pending`). Trigger it, approve the Breeze dialog. Expect: log `awaiting remote technician approval`; consent.exe stays up; approve from the web/mobile surface (#1159) → server sends `actuate_elevation` → promote/type/demote completes. (This exercises the seam with #1254's server-side mobile bridge once that lands.)
- [ ] **Dedupe:** Trigger the same exe twice within 30s. Expect: a single dialog (re-fired ETW events deduped), no stacked dialogs.
- [ ] **No helper connected:** Lock the workstation / no console user. Trigger a prompt. Expect: log `no capable user-helper session`; agent does not crash; consent.exe times out on its own.

---

## Risks / watch-items

- **Blocking the ETW loop:** `RunPamFlow` is called synchronously from `handleEvent`. UAC is modal and serial, and the dialog round-trip is bounded by `pamDialogTimeout` (90s) and the actuator's own deadline, so the loop cannot pin forever. If real-world UAC bursts prove this too coarse, move the call to a single-flight goroutine — but do **not** allow concurrent flows (one consent.exe at a time).
- **consent.exe lifetime vs await_remote:** the default UAC idle timeout is ~120s. The `pending` path depends on a technician approving within that window; otherwise consent.exe self-dismisses and the later `actuate_elevation` finds no window (`no_consent_window`). This is inherent, not a bug — note it in docs (#1161).
- **Verdict literal coupling:** `pamVerdictEndUserAllowed`/`pamVerdictRequireApproval` must stay byte-identical to `ComposePamDecision`'s expected strings. A unit test indirectly guards this (a mismatch makes `auto_approved + approve` fail to actuate); keep the table test.
- **`ipc.PamRequestDialog`/`PamDialogResult` field names** — verify against `ipc/message.go` before writing Task 5; the names above come from the #1152 plan, not a fresh read.
- **No agent→server outcome audit** for the local decision yet. The dormant-admin promote/demote already audit-log agent-side; mirroring the *decision* to the server row is deferred (pairs with #1254). Don't invent an endpoint here.
- **Windows-only runtime, CI blind** (#1000): everything cross-platform is unit-tested; the live path is only proven by the VM checklist above.

---

## Self-review checklist

- [ ] Dialog renders on the user's interactive desktop via the `pam`-scoped user helper (`FindCapableSession(ipc.ScopePam, "")`), never SYSTEM/secure desktop.
- [ ] `denied` status skips the dialog; `ignored` never reaches the runner (filtered in `handleEvent`).
- [ ] `auto_approved`→`end-user-allowed`, `pending`→`require-approval`; verdict literals match `ComposePamDecision`.
- [ ] `await_remote` does nothing locally — the existing `actuate_elevation` command is the remote actuation path; no new server command invented.
- [ ] `etwlua`→broker edge is behind the `PamRunner` interface; `etwlua` tests use `fakePamRunner`, no live broker.
- [ ] RateLimiter dedupe (unchanged, 30s) prevents stacked dialogs per prompt.
- [ ] Actuate core is shared between the remote command and local flow (`actuateElevation`); demotion is still guaranteed via `defer`.
- [ ] No server-side change (the POST already returns `{id,status}`).
- [ ] `go test -race` green on all four packages; `GOOS=windows go build ./...` succeeds.
