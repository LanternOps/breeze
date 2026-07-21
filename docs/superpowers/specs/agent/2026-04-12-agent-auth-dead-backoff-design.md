# Agent Auth-Dead Backoff (#401)

## Problem

When an agent's token is invalidated (device deleted, DB wiped, manual removal), the agent continues making HTTP requests at normal cadence forever. Each returns 401, but the agent never backs off.

A deauthorized agent generates ~6 endpoints × 1/60s = ~6 requests/minute indefinitely. Across a fleet during a mass deauth event (token rotation bug, DB restore, bulk delete), this becomes a self-inflicted load spike.

The WebSocket reconnect loop already backs off correctly (1s → 60s exponential). The problem is the HTTP side: heartbeat and log shipper tickers fire regardless of auth state.

## Design

### New package: `agent/internal/authstate`

A shared auth-failure monitor. Single file, ~80 lines. No goroutines, no channels, no timers — just atomic state that callers check on their existing tick schedules.

```go
type Monitor struct {
    dead         atomic.Bool
    consecutive  atomic.Int32
    threshold    int32          // default 3
    backoff      backoffState   // tracks current delay, 1s→30s cap
    mu           sync.Mutex     // protects backoff state transitions
}
```

**Public API:**

| Method | Purpose |
|--------|---------|
| `NewMonitor(threshold int32) *Monitor` | Constructor, threshold=3 |
| `RecordAuthFailure()` | Increment counter; trip dead if >= threshold; log once on transition |
| `RecordSuccess()` | Clear counter + dead flag; reset backoff; log once on recovery |
| `ShouldSkip() bool` | Atomic read of dead flag — the cheap gate callers use |
| `BackoffDuration() time.Duration` | Current backoff delay (callers sleep this before next attempt) |

**Backoff progression:** 1s → 2s → 4s → 8s → 16s → 30s (cap). Factor 2.0, ±20% jitter.

**Logging:** One `slog.Warn` on entering auth-dead ("auth-dead: 3 consecutive 401s, backing off"), one `slog.Info` on recovery ("auth recovered, resuming normal cadence"). No per-tick logging while dead.

### Caller integration

**Heartbeat** (`agent/internal/heartbeat/heartbeat.go`):

In the ticker loop (~line 691), before calling `sendHeartbeatWithWatchdog()`:
1. Check `authMon.ShouldSkip()` — if true, sleep `authMon.BackoffDuration()` and skip the tick
2. After `sendHeartbeat()` returns, inspect status code:
   - 401 → `authMon.RecordAuthFailure()`
   - 200 → `authMon.RecordSuccess()`

This gates all heartbeat-driven work: heartbeat itself, sessions, security status, eventlogs, posture. One check covers them all since they share the same ticker.

**Log shipper** (`agent/internal/logging/shipper.go`):

In the ship loop (~line 140), before attempting to ship:
1. Check `authMon.ShouldSkip()` — if true, skip (logs stay buffered for next attempt)
2. After ship response, inspect status code:
   - 401 → `authMon.RecordAuthFailure()`
   - Success → `authMon.RecordSuccess()`

Logs are not dropped while auth-dead — they accumulate in the buffer and ship once auth recovers.

**WebSocket** — no changes. Already backs off correctly on any connection failure.

### Wiring

In `main.go`, create one `authstate.Monitor` and pass it to heartbeat and log shipper constructors. Same pattern as `secureToken` — shared reference initialized at startup, no globals.

```go
authMon := authstate.NewMonitor(3)
// pass to heartbeat constructor
// pass to log shipper
```

### What doesn't change

- `httputil/retry.go` — 401 stays non-retryable, returns immediately
- `websocket/client.go` — already correct
- No new goroutines, channels, or background timers
- Existing ticker intervals unchanged — callers just short-circuit before the HTTP call

## Affected files

| File | Change |
|------|--------|
| `agent/internal/authstate/monitor.go` | **New** — Monitor implementation |
| `agent/internal/authstate/monitor_test.go` | **New** — unit tests |
| `agent/internal/heartbeat/heartbeat.go` | Add `authMon` field, check in ticker loop, record results |
| `agent/internal/logging/shipper.go` | Add `authMon` field, check in ship loop, record results |
| `agent/cmd/breeze-agent/main.go` | Create Monitor, wire into heartbeat + shipper |

## Testing

**Unit tests (`authstate/monitor_test.go`):**
- 2 failures don't trip dead; 3rd does
- `ShouldSkip()` returns true only when dead
- `RecordSuccess()` clears dead state and resets counter
- Backoff progression caps at 30s
- Concurrent access safety (goroutine test with `-race`)

**Unit tests for callers:**
- Heartbeat skips send when `ShouldSkip()` returns true
- Log shipper skips ship when `ShouldSkip()` returns true
- Both record 401 and 200 correctly

## Edge cases

- **Token rotation during normal operation:** A single 401 during rotation doesn't trip auth-dead (threshold=3). The rotation handler updates the token and next heartbeat succeeds.
- **Partial recovery:** If heartbeat gets 200 but log shipper gets 401 (shouldn't happen, same token), `RecordSuccess()` from heartbeat clears the state for both.
- **Agent restart:** Auth-dead state is in-memory only. Restart resets to clean state, which is correct — the agent should try fresh on startup.
