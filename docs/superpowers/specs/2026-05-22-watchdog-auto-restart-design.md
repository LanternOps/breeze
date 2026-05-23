# Watchdog auto-restart on prolonged heartbeat silence

**Date:** 2026-05-22
**Status:** Design — approved, awaiting spec review
**Issues addressed:** #799 (Layer B — watchdog self-heal on silent main agent)
**Related:** #800 (Layer C — server-side asymmetry detection, separate), #816 (in-place upgrade helper-binary, already fixed)
**Branch:** `feat/watchdog-auto-restart-799`

## Problem

When the main agent process stays alive but its heartbeat HTTP loop wedges — the case observed 2026-05-21 on ~10 endpoints silent for 40 minutes to 2+ days — the device flips to `status='offline'` server-side and stays there until a human reboots. The watchdog already exists, already monitors process liveness and IPC pong, already has a heartbeat-staleness check, and already has a RECOVERING state with `restartAgentService()` escalation. **The wiring is there but it has a hole that turns "auto-restart" into "auto-restart in an undetectable loop".**

### The flap-loop hole

In `agent/cmd/breeze-watchdog/main.go`, the end-of-tick RECOVERING branch reads:

```go
ok, err := recovery.Attempt(pid)
if ok {
    journal.Log(LevelInfo, "recovery.success", nil)
    wd.HandleEvent(EventAgentRecovered)   // ← optimistic
}
```

`ok=true` only means `restartAgentService()` returned success — the SCM call succeeded, not that the agent's heartbeat has resumed. `EventAgentRecovered` transitions back to MONITORING, where line 416 calls `recovery.Reset()`, **wiping the attempt counter**. If the underlying wedge wasn't actually fixed (e.g. the agent comes back up and gets wedged in the same way), the next heartbeat-stale tick goes RECOVERING again with a fresh counter. The 10-min cooldown × 3-attempts flap detection never engages. The watchdog could restart the agent 100 times per day, each cycle looking like a clean success in the journal, and **nothing surfaces to the server** because the watchdog only POSTs heartbeats during FAILOVER.

### Acceptance gaps (per the issue's checklist)

| Acceptance criterion | Current state |
|---|---|
| `watchdog.maxHeartbeatStalenessSec` config (default 180s = 3× 60s interval) | Exists as `WatchdogConfig.HeartbeatStaleThreshold`, default `3m`. Different name only. |
| Watchdog records last main-agent successful heartbeat timestamp | ✅ `agent.state` file + `LastHeartbeat` field; watchdog re-reads on each heartbeat tick (`main.go:343-347`). |
| Restart attempts logged | ✅ Journal logs every attempt and exhaustion. |
| Restart attempts surfaced via watchdog heartbeat payload as `mainAgentRestartCount24h` | ❌ Counter is per-10-min-window, resets per cycle; failover heartbeat body lacks the field entirely (`failover.go:68-77`). |
| Flap-detection escalation (e.g. 5 restarts / 24h → alert) | ❌ No 24h counter; nothing to alert on. |
| Graceful → forceful escalation order | ⚠ Partially: attempt 1 = SCM restart (graceful), attempt 2 = SIGKILL + start (forceful), attempt 3+ = start only. No IPC `restart_main_agent` message — see decision below. |
| Integration test (stub agent goes silent → watchdog restarts within 2 intervals) | ❌ Only state-machine unit tests today. |

## Goals / Non-goals

**Goals**

- Close the flap-loop hole: a restart that didn't actually fix anything must not look like success.
- Add a 24h restart counter that survives per-cycle resets, and expose it.
- Escalate to FAILOVER on 5+ restarts/24h so the server gets a real signal (otherwise the loop stays invisible).
- Add an in-process integration test that drives the wedge → restart → recover scenarios deterministically.
- Surface `maxHeartbeatStalenessSec` as a documented config alias.

**Non-goals (YAGNI)**

- IPC `restart_main_agent` message. Attempt 1 is already `restartAgentService()` — a SCM-mediated graceful restart. Adding an IPC-mediated graceful step is strictly more code with no failure mode it catches that SCM restart doesn't.
- Server-side asymmetry detection / `main_agent_silent_since` device column / "agent silent" UI state. That is #800 (Layer C), separate spec.
- Persisting `restartHistory` across host reboots. A reboot is itself a recovery; restarting the count after a reboot is desirable.
- Changing the heartbeat HTTP send path or anything in the main agent. The whole point of Layer B is that the main agent is unreliable; we fix this in the watchdog.
- Dynamic config reload. New knobs take effect on watchdog restart, same as every other watchdog knob today.

## Architecture

Three small, additive changes to the existing watchdog state machine. No new state machine states; no new event names except where existing semantics are stretched.

### 1. Restart verification gate ("did the heartbeat actually resume?")

Currently in `agent/cmd/breeze-watchdog/main.go:366-387`:

```go
case watchdog.StateRecovering:
    if recovery.CanAttempt() {
        ok, err := recovery.Attempt(pid)
        if ok {
            wd.HandleEvent(EventAgentRecovered)   // optimistic
        }
    } else {
        wd.HandleEvent(EventRecoveryExhausted)
    }
```

After change:

```go
case watchdog.StateRecovering:
    if pendingVerify != nil {
        // A previous attempt is being verified — don't attempt again.
        verifyRestartOutcome(pendingVerify, agentState, wd, recovery, journal, wdCfg)
        break
    }
    if recovery.Count24h() >= wdCfg.MaxRestartsPer24h {
        journal.Log(LevelError, "recovery.flap_detected", map[string]any{
            "count_24h": recovery.Count24h(),
        })
        wd.HandleEvent(EventRecoveryExhausted)   // → FAILOVER, see §3
        break
    }
    if !recovery.CanAttempt() {
        wd.HandleEvent(EventRecoveryExhausted)
        break
    }
    ok, err := recovery.Attempt(pid)   // increments per-window counter + appends to history
    if ok {
        pendingVerify = &verifyState{startedAt: time.Now()}
        journal.Log(LevelInfo, "recovery.attempt", map[string]any{
            "attempt":    recovery.Attempts(),
            "count_24h":  recovery.Count24h(),
            "verifying":  true,
        })
    } else {
        journal.Log(LevelError, "recovery.failed", map[string]any{"error": errStr(err)})
        // Stay in RECOVERING; next tick re-checks CanAttempt.
    }
```

`verifyRestartOutcome` logic:

- If `agentState.LastHeartbeat.After(pendingVerify.startedAt.Add(wdCfg.RestartVerificationGrace))` → real success.
  - `pendingVerify = nil`; `journal.Log(LevelInfo, "recovery.verified", {elapsed_ms})`; `wd.HandleEvent(EventAgentRecovered)`. The existing MONITORING branch then calls `recovery.Reset()` for the per-window counter, but **does not clear `restartHistory`** (see §2).
- Else if `time.Since(pendingVerify.startedAt) > wdCfg.RestartVerificationTimeout` → verification failed; this attempt did **not** recover the agent.
  - `pendingVerify = nil`; `journal.Log(LevelWarn, "recovery.verify_timeout", {elapsed_ms})`. Stay in RECOVERING; next tick will hit the flap check then attempt again (or escalate).
- Else → still verifying; do nothing this tick.

Defaults: `RestartVerificationGrace = 30s`, `RestartVerificationTimeout = 120s` (= 2× default heartbeat interval). The grace exists so we don't read the *pre*-restart `LastHeartbeat` and think the agent recovered when it didn't even shut down yet.

### 2. 24h rolling restart history

Extend `agent/internal/watchdog/recovery.go`:

```go
type RecoveryManager struct {
    // existing fields…
    restartHistory []time.Time
    historyPath    string         // optional; "" disables persistence
}

func (r *RecoveryManager) Attempt(pid int) (bool, error) {
    r.attempts++
    r.lastAttempt = time.Now()
    r.restartHistory = append(r.restartHistory, r.lastAttempt)
    r.purgeOldHistory()
    r.persistHistory()             // best-effort, error logged not returned
    // …existing switch over r.attempts…
}

func (r *RecoveryManager) Count24h() int {
    r.purgeOldHistory()
    return len(r.restartHistory)
}

func (r *RecoveryManager) LastRestartAt() time.Time { /* zero if empty */ }

func (r *RecoveryManager) purgeOldHistory() {
    cutoff := time.Now().Add(-24 * time.Hour)
    // in-place drop entries < cutoff; bounded slice (cap at 50 to bound disk size)
}
```

Persistence:

- File: `<log_dir>/watchdog-restart-history.json` (same dir as health journal).
- Schema: `{"restarts": ["RFC3339", ...]}`.
- Loaded once at `NewRecoveryManager`. Corrupt or missing file → start empty + journal warn.
- Best-effort write; failure logged not propagated.
- Not cleared on `Reset()` (per-window reset) and not cleared on verified recovery. The only purge mechanism is the 24h time window — entries fall off naturally as they age out. Practical effect: a host that flapped 4 times yesterday then runs clean for 23h still shows `count_24h=4` for that period, which is correct and is what gives the on-call signal its meaning.

### 3. Flap escalation → FAILOVER

When `Count24h() >= MaxRestartsPer24h` (default 5), emit `EventRecoveryExhausted`. Existing transition `RECOVERING → FAILOVER` already handles this — no new state needed. Once in FAILOVER:

- The existing `case StateFailover` branch in `main.go:389-405` creates a `FailoverClient` and POSTs heartbeats every `FailoverPollInterval` (30s default).
- Heartbeat body now includes the new fields (§4). Server sees `flapDetected: true` and the on-call channel gets the signal.
- Recovery attempts stop in FAILOVER (no end-of-tick recovery branch fires there).
- Exit on `EventAgentRecovered` (e.g. server sends a `restart_agent` failover command that succeeds, or agent's IPC reconnects spontaneously) → back to MONITORING; existing `recovery.Reset()` runs; history is intentionally retained.

### 4. Extended failover heartbeat payload

`agent/internal/watchdog/failover.go`, `SendHeartbeat`:

```go
body := map[string]any{
    "role":           "watchdog",
    "watchdogState":  currentState,
    "status":         "ok",
    "agentVersion":   watchdogVersion,
    "journalExcerpt": journalEntries,
    "timestamp":      time.Now().UTC().Format(time.RFC3339),
    // NEW:
    "mainAgentRestartCount24h": recovery.Count24h(),
    "mainAgentLastRestartAt":   tsOrEmpty(recovery.LastRestartAt()),
    "flapDetected":             recovery.Count24h() >= maxRestartsPer24h,
}
```

`SendHeartbeat` currently doesn't have the `recovery` reference — it'll take a small signature change (pass `recovery *RecoveryManager` in, or pass an extracted `RestartStats` struct to keep the type-boundary clean). Recommend `RestartStats` to keep `failover.go` from depending on `RecoveryManager` internals.

### 5. API side (minimal, non-blocking)

`apps/api/src/routes/agents/heartbeat.ts`, watchdog branch: accept the three new fields. **Don't persist to a DB column yet** — that's #800. Do log into `agent_logs` so the data is queryable:

```ts
if (role === 'watchdog') {
  if (body.flapDetected || (body.mainAgentRestartCount24h ?? 0) > 0) {
    await logAgentDiagnostic({
      deviceId, level: 'warn', component: 'watchdog',
      message: 'main agent restart activity reported',
      fields: { count24h, lastRestartAt, flapDetected, watchdogState },
    });
  }
  // existing pass-through behavior unchanged
}
```

Unknown extra fields in the request body must continue to be accepted silently (defensive against version skew; Layer A precedent set by #774-adjacent work). Zod schema: add the three fields as optional, never reject.

### 6. Config (additive, backward-compatible)

`agent/internal/config/config.go`, `WatchdogConfig`:

```go
type WatchdogConfig struct {
    // …existing…
    HeartbeatStaleThreshold      time.Duration `mapstructure:"heartbeat_stale_threshold"`
    // new:
    RestartVerificationGrace     time.Duration `mapstructure:"restart_verification_grace"`     // default 30s
    RestartVerificationTimeout   time.Duration `mapstructure:"restart_verification_timeout"`   // default 120s
    MaxRestartsPer24h            int           `mapstructure:"max_restarts_per_24h"`            // default 5
}
```

Viper alias so the issue's documented name works:

```go
v.RegisterAlias("watchdog.max_heartbeat_staleness_sec", "watchdog.heartbeat_stale_threshold")
```

(Verify: if viper's alias mechanism doesn't handle Duration parsing for an aliased numeric field, fall back to reading both keys explicitly in `Load()` and converting seconds → duration.)

Dev mode (`runWatchdog` `if devMode { … }` block) shrinks the new knobs proportionally: grace=5s, timeout=20s, threshold unchanged (already 30s in dev).

## Test plan

### Unit tests

`agent/internal/watchdog/recovery_test.go` (new):

- `TestCount24hEmpty` — fresh manager returns 0.
- `TestCount24hWithinWindow` — append 3 entries, all within 24h → 3.
- `TestCount24hPurgesOld` — append entries at `now-25h`, `now-12h`, `now` → returns 2.
- `TestCount24hBounded` — append 60 entries; slice cap at 50; oldest dropped.
- `TestHistoryRoundTrip` — write to temp file, new manager loads same count.
- `TestHistoryCorruptFile` — write garbage; new manager starts empty without panic.

`agent/internal/watchdog/watchdog_test.go` (extend):

- `TestFlapEscalationTransitionsToFailover` — synthesize 5 history entries; assert RECOVERING + Count24h ≥ threshold + dispatch path → FAILOVER. (State machine test — does not exercise the main loop.)

### Integration test

`agent/internal/watchdog/integration_test.go` (new). In-process, no real process or service controller — uses fakes via interfaces. Existing code already abstracts `ProcessChecker` and `IPCProber`; add a `serviceController` interface around `restartAgentService` / `startAgentService` / `forceKillProcess` so the integration test can inject a fake. (Today these are package-level functions; refactor to a small interface — `RecoveryManager` takes one in its constructor. This is a minor but real change, called out for the implementation plan.)

Scenarios (one Go test each, driven by a synthetic clock):

- **`Test_HeartbeatStale_TriggersRestartWithinTwoIntervals`** (acceptance criterion from the issue): fake state file holds `LastHeartbeat = now-5m`, process alive, IPC pong OK. Drive the loop. Expected: within `2 * HeartbeatStaleThreshold` of test start, fake `restartAgentService()` is called exactly once; verification gate engages; when fake state file is updated with fresh `LastHeartbeat`, watchdog re-enters MONITORING.

- **`Test_OptimisticRestart_DoesNotResetCounter`**: restart returns ok=true, but fake state file's `LastHeartbeat` is NOT advanced. Expected: after `RestartVerificationTimeout`, watchdog logs `recovery.verify_timeout`, stays in RECOVERING, attempts again on next staleness check. After 5 cycles, watchdog transitions to FAILOVER and the fake failover-heartbeat receiver observes `flapDetected: true`, `mainAgentRestartCount24h: 5`.

- **`Test_RealRecovery_ClearsPerWindowCounter_NotHistory`**: 2 restart cycles, each verified-recovered. Expected: per-window `recovery.Attempts()` resets to 0 between cycles (so we don't accidentally hit `MaxRecoveryAttempts` in normal operation); `Count24h()` reads 2.

- **`Test_FailoverHeartbeatIncludesNewFields`**: drive to FAILOVER via 5-flap path; capture HTTP request body; assert all three new fields present with expected values.

Synthetic clock: use a small `clock.Clock` interface (e.g. `Now()`, `Since(t)`) injected into `RecoveryManager` and the verification gate. `time.Now()` callers replaced where they affect the test. The main loop's `time.Tick`-driven structure is preserved by allowing the test to advance with `<-time.After(...)` against compressed intervals (set Process=10ms, Heartbeat=50ms, etc.).

### Test running

`cd agent && go test -race ./internal/watchdog/...` — must pass on Linux, macOS, Windows runners in CI. The integration test uses only the platform-agnostic `RecoveryManager`/state-file paths; OS-specific `restartAgentService` is behind the new `serviceController` interface and is not exercised.

## Risk surface

- **History file corruption** — handled: corrupt-or-missing → start empty, journal warn. Worst case: under-reports for one watchdog lifetime.
- **Clock-only 24h window** — no NTP dependency; survives DST changes (`time.Time` arithmetic is monotonic-aware). Edge case: large system clock jump backward could cause `Count24h` to under-purge briefly; acceptable.
- **Service-controller interface change** is mechanical but it touches platform-specific code (`recovery_windows.go`, `recovery_darwin.go`, `recovery_linux.go`). Implementation plan must include a compile + race-test pass on each platform — the CI matrix already covers this.
- **Viper alias gotcha** — verified pattern; fall back to manual key-read if duration coercion misbehaves.
- **Backward compat** — every new field has a default; existing deployments behave unchanged until they hit the 5-restart threshold (at which point they correctly escalate to FAILOVER, which is the intended improvement).

## Files affected (estimate)

```
agent/internal/watchdog/recovery.go              ~+90 LOC (history, Count24h, persistence, serviceController iface)
agent/internal/watchdog/recovery_windows.go       small (wrap funcs in iface impl)
agent/internal/watchdog/recovery_darwin.go        small
agent/internal/watchdog/recovery_linux.go         small
agent/internal/watchdog/recovery_test.go         NEW ~150 LOC
agent/internal/watchdog/integration_test.go      NEW ~250 LOC (4 scenarios + fakes)
agent/internal/watchdog/watchdog_test.go          ~+30 LOC (flap-escalation test)
agent/internal/watchdog/failover.go               ~+15 LOC (extra fields, RestartStats param)
agent/cmd/breeze-watchdog/main.go                 ~+50 LOC (verification gate, flap check)
agent/internal/config/config.go                   ~+15 LOC (3 fields + alias)
apps/api/src/routes/agents/heartbeat.ts           ~+20 LOC (accept fields, diag log)
apps/api/src/routes/agents/heartbeat.test.ts      ~+30 LOC (watchdog payload + flap signal)
```

Estimated total: ~650 LOC across ~12 files. Ships as a single PR.

## Out of scope, captured for follow-up

- **#800 Layer C**: server-side asymmetry detector, `main_agent_silent_since` device column, "agent silent (watchdog OK)" amber UI state, auto-send `restart_agent` failover command after 5m in that state. The Layer-B heartbeat fields shipped here are the data Layer C needs; capturing this dependency so the #800 spec can lean on it.
- **IPC `restart_main_agent` message**: deliberately skipped per analysis above. If a future failure mode appears where SCM restart hangs but the agent can still process IPC, revisit.
- **Cross-host-reboot persistence of `restartHistory`**: not needed; a reboot is itself recovery, and the file lives in `log_dir` which typically persists anyway — incidental, not relied on.
