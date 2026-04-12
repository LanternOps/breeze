# Agent Auth-Dead Backoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop deauthorized agents from hammering the API with doomed HTTP requests by introducing a shared auth-failure monitor that gates heartbeat and log shipper calls.

**Architecture:** A new `authstate.Monitor` package holds an atomic dead flag and consecutive-401 counter. Heartbeat and log shipper check `ShouldSkip()` (one atomic read) before making HTTP calls, and feed back 401/success results. Exponential backoff 1s→30s cap with jitter.

**Tech Stack:** Go standard library only — `sync/atomic`, `sync.Mutex`, `time`, `log/slog`

**Spec:** `docs/superpowers/specs/2026-04-12-agent-auth-dead-backoff-design.md`

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `agent/internal/authstate/monitor.go` | Create | Auth-dead state, counter, backoff logic |
| `agent/internal/authstate/monitor_test.go` | Create | Unit tests for Monitor |
| `agent/internal/heartbeat/heartbeat.go` | Modify | Add `authMon` field, check before send, record results |
| `agent/internal/logging/shipper.go` | Modify | Add `authMon` field, check before ship, record results |
| `agent/internal/logging/logging.go` | Modify | Thread `AuthMonitor` through `InitShipper` |
| `agent/cmd/breeze-agent/main.go` | Modify | Create Monitor, wire into heartbeat + shipper |

---

### Task 1: Create authstate.Monitor with tests

**Files:**
- Create: `agent/internal/authstate/monitor.go`
- Create: `agent/internal/authstate/monitor_test.go`

- [ ] **Step 1: Write the failing tests**

Create `agent/internal/authstate/monitor_test.go`:

```go
package authstate

import (
	"sync"
	"testing"
	"time"
)

func TestMonitor_NotDeadInitially(t *testing.T) {
	m := NewMonitor(3)
	if m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=false on fresh monitor")
	}
}

func TestMonitor_NotDeadBeforeThreshold(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=false after 2 failures (threshold=3)")
	}
}

func TestMonitor_DeadAtThreshold(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if !m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=true after 3 failures")
	}
}

func TestMonitor_SuccessClearsDead(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if !m.ShouldSkip() {
		t.Fatal("expected dead after 3 failures")
	}
	m.RecordSuccess()
	if m.ShouldSkip() {
		t.Fatal("expected ShouldSkip()=false after RecordSuccess()")
	}
}

func TestMonitor_SuccessResetsCounter(t *testing.T) {
	m := NewMonitor(3)
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	m.RecordSuccess() // reset
	m.RecordAuthFailure()
	m.RecordAuthFailure()
	if m.ShouldSkip() {
		t.Fatal("expected not dead — counter was reset by success")
	}
}

func TestMonitor_BackoffProgression(t *testing.T) {
	m := NewMonitor(1) // threshold=1 so first failure trips it

	m.RecordAuthFailure()
	d1 := m.BackoffDuration()
	if d1 < 800*time.Millisecond || d1 > 1200*time.Millisecond {
		t.Fatalf("expected first backoff ~1s, got %v", d1)
	}

	m.RecordAuthFailure()
	d2 := m.BackoffDuration()
	if d2 < 1600*time.Millisecond || d2 > 2400*time.Millisecond {
		t.Fatalf("expected second backoff ~2s, got %v", d2)
	}
}

func TestMonitor_BackoffCapsAt30s(t *testing.T) {
	m := NewMonitor(1)
	for i := 0; i < 20; i++ {
		m.RecordAuthFailure()
	}
	d := m.BackoffDuration()
	if d > 36*time.Second { // 30s + 20% jitter
		t.Fatalf("expected backoff capped near 30s, got %v", d)
	}
}

func TestMonitor_SuccessResetsBackoff(t *testing.T) {
	m := NewMonitor(1)
	for i := 0; i < 10; i++ {
		m.RecordAuthFailure()
	}
	m.RecordSuccess()
	m.RecordAuthFailure() // re-trip
	d := m.BackoffDuration()
	if d > 1500*time.Millisecond {
		t.Fatalf("expected backoff reset to ~1s after success, got %v", d)
	}
}

func TestMonitor_ConcurrentAccess(t *testing.T) {
	m := NewMonitor(3)
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(3)
		go func() {
			defer wg.Done()
			m.RecordAuthFailure()
		}()
		go func() {
			defer wg.Done()
			m.ShouldSkip()
		}()
		go func() {
			defer wg.Done()
			m.RecordSuccess()
		}()
	}
	wg.Wait()
	// No race detector failures = pass
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/authstate/...`
Expected: compilation error — package does not exist yet

- [ ] **Step 3: Implement Monitor**

Create `agent/internal/authstate/monitor.go`:

```go
package authstate

import (
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"
)

const (
	initialBackoff = 1 * time.Second
	maxBackoff     = 30 * time.Second
	backoffFactor  = 2.0
	jitterFrac     = 0.2
)

// Monitor tracks consecutive HTTP 401 responses across all agent HTTP
// callers. When the failure count reaches the threshold, ShouldSkip()
// returns true and callers should skip their HTTP work.
type Monitor struct {
	dead        atomic.Bool
	consecutive atomic.Int32
	threshold   int32

	mu      sync.Mutex
	backoff time.Duration

	// Log once per state transition, not per tick.
	enteredDead atomic.Bool
}

// NewMonitor creates an auth monitor that trips after `threshold`
// consecutive 401 responses.
func NewMonitor(threshold int32) *Monitor {
	return &Monitor{
		threshold: threshold,
		backoff:   initialBackoff,
	}
}

// RecordAuthFailure records a 401 response. If the consecutive count
// reaches the threshold, the monitor enters auth-dead state.
func (m *Monitor) RecordAuthFailure() {
	n := m.consecutive.Add(1)
	if n >= m.threshold {
		if m.dead.CompareAndSwap(false, true) {
			m.enteredDead.Store(true)
			slog.Warn("auth-dead: consecutive 401s reached threshold, backing off",
				"consecutive", n, "threshold", m.threshold)
		}
		// Advance backoff on each additional failure while dead.
		m.mu.Lock()
		m.backoff = time.Duration(float64(m.backoff) * backoffFactor)
		if m.backoff > maxBackoff {
			m.backoff = maxBackoff
		}
		m.mu.Unlock()
	}
}

// RecordSuccess clears the auth-dead state and resets the counter
// and backoff.
func (m *Monitor) RecordSuccess() {
	m.consecutive.Store(0)
	wasDead := m.dead.Swap(false)
	if wasDead {
		slog.Info("auth recovered, resuming normal cadence")
	}
	m.mu.Lock()
	m.backoff = initialBackoff
	m.mu.Unlock()
	m.enteredDead.Store(false)
}

// ShouldSkip returns true if the agent is in auth-dead state.
// This is a single atomic read — safe to call on every tick.
func (m *Monitor) ShouldSkip() bool {
	return m.dead.Load()
}

// BackoffDuration returns the current backoff delay with jitter.
func (m *Monitor) BackoffDuration() time.Duration {
	m.mu.Lock()
	base := m.backoff
	m.mu.Unlock()

	jitter := float64(base) * jitterFrac * (2*rand.Float64() - 1)
	d := time.Duration(float64(base) + jitter)
	if d < 0 {
		return 0
	}
	return d
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race -v ./internal/authstate/...`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/authstate/monitor.go agent/internal/authstate/monitor_test.go
git commit -m "feat(agent): add authstate.Monitor for 401 backoff (#401)"
```

---

### Task 2: Integrate Monitor into Heartbeat

**Files:**
- Modify: `agent/internal/heartbeat/heartbeat.go`

- [ ] **Step 1: Add authMon field to Heartbeat struct**

In `heartbeat.go`, add the `authMon` field to the `Heartbeat` struct (after line 172, the `retryCfg` field):

```go
// Add import at top of file:
"github.com/breeze-rmm/agent/internal/authstate"

// Add field to Heartbeat struct (after retryCfg on line 172):
authMon *authstate.Monitor
```

- [ ] **Step 2: Add SetAuthMonitor method**

Add after `SetWebSocketClient` (line 431):

```go
// SetAuthMonitor sets the shared auth-failure monitor.
func (h *Heartbeat) SetAuthMonitor(m *authstate.Monitor) {
	h.authMon = m
}
```

- [ ] **Step 3: Gate the ticker loop on auth-dead**

In the ticker loop at line 690-691, add the auth-dead check before `sendHeartbeatWithWatchdog()`:

Replace (line 690-691):
```go
		case <-ticker.C:
			h.sendHeartbeatWithWatchdog()
```

With:
```go
		case <-ticker.C:
			if h.authMon != nil && h.authMon.ShouldSkip() {
				log.Debug("skipping heartbeat tick, auth-dead",
					"backoff", h.authMon.BackoffDuration())
				continue
			}
			h.sendHeartbeatWithWatchdog()
```

- [ ] **Step 4: Record auth result in sendHeartbeat**

In `sendHeartbeat()`, after the `httputil.Do` call (lines 2056-2068), add auth state recording.

Replace (lines 2064-2068):
```go
	if resp.StatusCode != http.StatusOK {
		log.Warn("heartbeat returned non-OK status", "status", resp.StatusCode)
		h.healthMon.Update("heartbeat", health.Degraded, fmt.Sprintf("status %d", resp.StatusCode))
		return
	}
```

With:
```go
	if resp.StatusCode == http.StatusUnauthorized {
		log.Warn("heartbeat returned 401")
		h.healthMon.Update("heartbeat", health.Degraded, "unauthorized")
		if h.authMon != nil {
			h.authMon.RecordAuthFailure()
		}
		return
	}

	if resp.StatusCode != http.StatusOK {
		log.Warn("heartbeat returned non-OK status", "status", resp.StatusCode)
		h.healthMon.Update("heartbeat", health.Degraded, fmt.Sprintf("status %d", resp.StatusCode))
		return
	}
```

Then after the existing `h.healthMon.Update("heartbeat", health.Healthy, "")` on line 2070, add:

```go
	if h.authMon != nil {
		h.authMon.RecordSuccess()
	}
```

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./...`
Expected: clean build

- [ ] **Step 6: Run existing heartbeat tests**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./internal/heartbeat/...`
Expected: all existing tests still pass (authMon is nil-safe — all checks guard with `h.authMon != nil`)

- [ ] **Step 7: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/heartbeat/heartbeat.go
git commit -m "feat(agent): integrate authstate.Monitor into heartbeat (#401)"
```

---

### Task 3: Integrate Monitor into Log Shipper

**Files:**
- Modify: `agent/internal/logging/shipper.go`
- Modify: `agent/internal/logging/logging.go`

- [ ] **Step 1: Add AuthMonitor interface to shipper.go**

The `logging` package cannot import `authstate` (it would create a circular dependency since `authstate` uses `log/slog` which logging configures). Define a local interface instead. Add at the top of `shipper.go` after the `TokenRevealer` interface (after line 23):

```go
// AuthSkipper is implemented by authstate.Monitor. Using an interface
// here avoids a circular import (authstate imports log/slog).
type AuthSkipper interface {
	ShouldSkip() bool
	RecordAuthFailure()
	RecordSuccess()
}
```

- [ ] **Step 2: Add authMon field to Shipper struct and config**

Add to `Shipper` struct (after `droppedCount` on line 54):

```go
	authMon AuthSkipper
```

Add to `ShipperConfig` struct (after `MinLevel` on line 64):

```go
	AuthMonitor AuthSkipper
```

In `NewShipper` (line 73), set it in the returned struct:

```go
	authMon: cfg.AuthMonitor,
```

- [ ] **Step 3: Gate shipBatch on auth-dead and record results**

In `shipBatch()`, add the auth-dead check at the top of the method (after line 177):

```go
func (s *Shipper) shipBatch(entries []LogEntry) {
	if s.authMon != nil && s.authMon.ShouldSkip() {
		// Re-buffer entries — don't drop them. Put them back on the channel
		// if there's room, otherwise drop with count.
		for _, e := range entries {
			select {
			case s.buffer <- e:
			default:
				s.droppedCount.Add(1)
			}
		}
		return
	}
```

In the 4xx error handling block (lines 252-261), add auth failure recording for 401 specifically:

Replace (lines 252-261):
```go
		if resp.StatusCode >= 400 {
			// Client error (4xx): do not retry
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			cancel()
			fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d for %d entries: %s\n",
				resp.StatusCode, len(entries), string(body))
			s.droppedCount.Add(int64(len(entries)))
			return
		}
```

With:
```go
		if resp.StatusCode >= 400 {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
			resp.Body.Close()
			cancel()
			if resp.StatusCode == http.StatusUnauthorized && s.authMon != nil {
				s.authMon.RecordAuthFailure()
			}
			fmt.Fprintf(os.Stderr, "[log-shipper] server returned %d for %d entries: %s\n",
				resp.StatusCode, len(entries), string(body))
			s.droppedCount.Add(int64(len(entries)))
			return
		}
```

After the success block (line 266-267, after `resp.Body.Close()`), add:

```go
		if s.authMon != nil {
			s.authMon.RecordSuccess()
		}
```

- [ ] **Step 4: Thread AuthMonitor through InitShipper**

In `logging.go`, update `InitShipper` (line 142) — the `ShipperConfig` already has the new `AuthMonitor` field from step 2, so callers just need to pass it. No code change needed in `logging.go` itself since `InitShipper` forwards the whole config to `NewShipper`.

- [ ] **Step 5: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./...`
Expected: clean build

- [ ] **Step 6: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/internal/logging/shipper.go agent/internal/logging/logging.go
git commit -m "feat(agent): integrate authstate.Monitor into log shipper (#401)"
```

---

### Task 4: Wire Monitor in main.go

**Files:**
- Modify: `agent/cmd/breeze-agent/main.go`

- [ ] **Step 1: Create Monitor and pass to log shipper**

In `main.go`, add the import:

```go
"github.com/breeze-rmm/agent/internal/authstate"
```

Before the `logging.InitShipper` call (~line 258), create the monitor:

```go
	authMon := authstate.NewMonitor(3)
```

Add `AuthMonitor` to the `ShipperConfig` in the `InitShipper` call (line 259-266):

```go
		logging.InitShipper(logging.ShipperConfig{
			ServerURL:    cfg.ServerURL,
			AgentID:      cfg.AgentID,
			AuthToken:    secureToken,
			AgentVersion: version,
			HTTPClient:   nil,
			MinLevel:     cfg.LogShippingLevel,
			AuthMonitor:  authMon,
		})
```

- [ ] **Step 2: Pass Monitor to heartbeat**

After `hb.SetWebSocketClient(wsClient)` (line 373), add:

```go
	hb.SetAuthMonitor(authMon)
```

- [ ] **Step 3: Verify compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && go build ./...`
Expected: clean build

- [ ] **Step 4: Run all agent tests**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race ./...`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
cd /Users/toddhebebrand/breeze
git add agent/cmd/breeze-agent/main.go
git commit -m "feat(agent): wire authstate.Monitor into main startup (#401)"
```

---

### Task 5: Final verification

- [ ] **Step 1: Run full agent test suite with race detection**

Run: `cd /Users/toddhebebrand/breeze/agent && go test -race -count=1 ./...`
Expected: all tests pass, no race conditions

- [ ] **Step 2: Verify cross-compilation**

Run: `cd /Users/toddhebebrand/breeze/agent && GOOS=windows GOARCH=amd64 go build ./... && GOOS=linux GOARCH=amd64 go build ./... && GOOS=darwin GOARCH=arm64 go build ./...`
Expected: clean builds for all platforms

- [ ] **Step 3: Comment on GitHub issue with fix details**

```bash
gh issue comment 401 --repo toddhebebrand/breeze --body "$(cat <<'EOF'
Root cause confirmed and fixed: heartbeat and log shipper never checked for persistent 401 responses — they logged the error and waited for the next tick, generating ~6 requests/minute/agent indefinitely.

**Fix:** New `authstate.Monitor` package tracks consecutive 401s across all HTTP callers. After 3 consecutive 401s, `ShouldSkip()` returns true and callers skip their HTTP work. Exponential backoff 1s→30s cap. Clears automatically on first successful response.

- `agent/internal/authstate/monitor.go` — shared monitor with atomic dead flag
- `agent/internal/heartbeat/heartbeat.go` — checks `ShouldSkip()` before each tick, records 401/success
- `agent/internal/logging/shipper.go` — checks `ShouldSkip()` before each ship, records 401/success
- `agent/cmd/breeze-agent/main.go` — creates monitor, wires into both callers

WebSocket client was already correct (exponential backoff on any connection failure) — no changes needed there.
EOF
)"
```
