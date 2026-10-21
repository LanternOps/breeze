---
title: "Scaling W09 (W1d): agent jittered reconnect, drain handling, loop-level Retry-After, jittered startup"
date: 2026-10-12
tracking_issue: LanternOps/breeze#8139
wave_issue: LanternOps/breeze#8148
depends_on: W08 (#8147, merged as #8456) for the server contract; W06 (#8145, merged as #8587) for the simulator storm suite (Task 12)
amended: 2026-10-20 — rebased on #9145 (reconnect_backoff.go), #9146 (httputil withServerAnswer + watchdog liveness), #9245 (stop-after-dial); see "Amendment 2026-10-20"
rigor: HIGH (program plan row W09) — ships in the Go agent to customer machines and follows the agent release rollout
---

# Scaling W09 — Agent Reconnect, Drain and Loop-Level Retry-After Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent fleet stops being the amplifier in an API overload or restart. After an established WebSocket drops, agents spread their redials instead of all redialling at once. When the server announces a drain, agents spread their reconnects over the window it names. When the server answers `503` with `Retry-After`, the agent waits that long before it calls that route again, on the next cycle too, not only inside the current request. Requests that fire together at agent startup are spread out. Every one of these behaviours falls back to today's behaviour against an API that sends no `drain` and no `Retry-After`.

**Architecture:** Four changes in the agent, each behind a pure, table-tested function, plus one shared clock seam per package so every timing test runs on a fake clock:
1. **Reconnect policy** (`internal/websocket/reconnect_policy.go`, pure). It maps the way the last connection ended (dial refused with or without `Retry-After`, a remote close of a stable or short-lived socket, a local `ForceReconnect`, a close after a `drain` hint, process start) and the backoff state to the next delay. `reconnectLoop` calls it and waits on the clock seam. The policy is exported inside the module so the simulator uses the same function instead of a hand-kept mirror.
2. **Drain hint** (`internal/websocket/drain.go`). `readPump` parses `{"type":"drain","reconnectWithinMs":N}` before the id-less skip. The hint belongs to the current socket. The agent never closes the socket itself; when the server closes it, the policy waits uniform `[0, N]`.
3. **Loop-level `Retry-After`** (`internal/httputil` + `internal/heartbeat/loop_deferral.go`). `httputil.Do` stops sleeping into the caller's context deadline: when the server's `Retry-After` will not fit, it returns at once with a typed error that carries an absolute, jittered `RetryAt`. A per-route deferral store in the heartbeat records it, and every periodic sender checks the store **before it collects** anything. UniFi and the log shipper, which do not use `httputil.Do`, get the same treatment in their own loops. Heartbeats and command results are never deferred.
4. **Startup spread** (`internal/heartbeat/startup_stagger.go`, `internal/monitoring`, the WS client start). The first WS dial, the first monitoring run and the startup inventory bundle each get a bounded random delay. The existing deterministic ±10 % helpers stay as they are.

**Tech Stack:** Go (`agent/go.mod`: `go 1.26.9`), gorilla/websocket, `math/rand/v2`, the agent's `internal/httputil`, `internal/heartbeat`, `internal/websocket`, `internal/logging`, `internal/unifi`, `internal/monitoring`; the agent simulator (`agent/tools/agentsim`) and W06's `load-tests/agentsim/storm.sh` for the lab run.

**Spec:** `docs/superpowers/specs/platform-ci/2026-10-07-horizontal-api-scaling-design.md`, row **W1d** (§6), the §1 failure spiral, §7 "Rollout and rollback" and §8 risk (2). Program index: `docs/superpowers/plans/platform-ci/2026-10-07-scaling-program-w0-w1.md`, row **W09**. Server contract: `docs/superpowers/plans/platform-ci/2026-10-08-scaling-w08-api-admission-control.md` (merged as #8456). Wave issue #8148, feature #8139.

> **Amendment 2026-10-20: read this section first.** Three agent PRs merged after this plan was written: #9145 (`7073c29716`, `agent/internal/websocket/reconnect_backoff.go`), #9146 (`5a0c717f05`, `httputil.withServerAnswer` and the watchdog's overload liveness), and #9245 (`3ea9716fba`, the `stopped()` check after `connect()`). Together they deliver part of Tasks 2 and 3 and make findings F1, F2, F5, F6 and F8 stale. The amendment below takes precedence over the original text wherever the two disagree. The original sections stay below it as the design record. A task the amendment marks **keep** runs as originally written, with the edits listed for it. A task marked **rewrite** runs from the amendment's text only. A task marked **drop** does not run. The implementation is still **one PR** with `Closes #8148`.

## Amendment 2026-10-20

### A0. Owner decisions (Todd, 2026-10-16 on #8148; binding, not reopened here)

| # | Decision | Effect on this plan |
|---|---|---|
| D1 | The first-reconnect window is **30 s**, set by a config key that accepts 0–300 | Rewritten Task 2 and Task 10. Value semantics are in A2 |
| D2 | Watchdog overload liveness is **out of scope**. It is #8934 and shipped as #9146 | Watchdog files are on the must-not-ship list. The heartbeat must keep the #9146 liveness path working (Task 5, Task 7) |
| D3 | Canary: an internal org pinned for **24 h** in the sleeping region, if a pin can point ahead of `is_latest`. Otherwise per-device upgrades on a few internal devices. R-1 checks this on a lab stack first | Rollout R-1, unchanged |
| D4 | The `drain` **sender** stays with W5c, unless G1 shows that `rolling-deploy` needs it | Must-not-ship list. Follow-up 1 is unchanged |

These close "Owner decisions surfaced by this plan" items 1–4 below.

### A1. As built on `origin/main` `bc0ff29519` (2026-10-20)

Every symbol below was checked with file:line at `bc0ff29519` by a read-only sweep, and the websocket and httputil rows were read again by hand. **[V]** means read in code.

**WebSocket client** (`agent/internal/websocket/client.go` is now 1,431 lines; `reconnect_backoff.go` is 202)

| Plan claim | Now | Verdict |
|---|---|---|
| F1: an accepted socket is redialled at once, and backoff grows only on a dial error | `reconnectLoop` (`client.go:473-526`) waits before **every** redial. `reconnectBackoff.afterDisconnect` (`reconnect_backoff.go:166-189`) waits as follows. Server normal close (1000/1001/4040): U(1 s, 5 s). Abnormal close, including 1006 and 4008: max(U(1 s, 5 s), step ±30 %). A socket that lived ≤ 30 s escalates the step ×2 up to 60 s. The step resets after a socket that lived more than 30 s. Every wait has a floor of `minReconnectDelay` = 250 ms (`:28`). Constants are at `:20-48`; `classifyDisconnect` is at `:84-100` [V] | **STALE.** The tight loop is fixed. Spec item (1) is only **partly** met: after a stable socket the wait is U(1 s, 5 s), not D1's 30 s window. For 10k agents that is about 2,500 redials/s for 4 s, against about 345/s over 29 s with D1 |
| F2: `connect()` discards the handshake response | `connect` keeps `resp` from `dialer.DialContext` (`client.go:430`). A non-101 answer becomes `*upgradeRefusedError` (`:432-436`; type at `reconnect_backoff.go:106-130`). `RetryAfter` is parsed only for 429 and 503 (`:126-128`) [V] | **STALE.** Delivered by #9145 |
| F3: Hono forwards a digits-only `Retry-After` | `patches/@hono__node-ws@1.3.1.patch:16-20, 37-41` [V] | Still true |
| F4: `readPump` skips id-less unknown types | The skip is now at `client.go:624`. `desktop_ice_candidate` (#9182) is handled just before it, at `:617-620`. Nothing parses `drain` [V] | Still true; lines moved. Task 4 adds `drain` after `:620` |
| F5: `ForceReconnect` must stay immediate (D3) | `ForceReconnect` (`client.go:388-395`) sets `localClose` (`atomic.Bool`, `:171`) only while a socket is held. The loop then waits U(250 ms, 1 s) (`reconnect_backoff.go:172-173`). The callers are `heartbeat.go:6247, 6518, 6798` [V] | **CHANGED.** "Immediate" was superseded on purpose by #9145. The 0.25–1 s jitter stands (A3) |
| F6: Dial takes no context | `connect` uses `DialContext`, cancelled when `done` closes (`client.go:418-430`). #9245 added `if c.stopped() { c.closeCurrentConn(true); return }` after a successful dial (`:490-493`) [V] | **STALE.** Delivered by #9145 and #9245 |
| F7: `SendResult` buffers while disconnected; `OnResultHandedOff` fires anyway | `processCommand` `client.go:893-924`; `SendResult` `:933-1000` (enqueue `:989`). Non-command callers are `heartbeat/handlers_tunnel.go:139`, `heartbeat/desktop_clipboard_summary.go:159` and `heartbeat.go:2043`. The hooks are wired at `heartbeat.go:1438, 1441`. Outbox flush on connect is at `heartbeat.go:1433, 1614-1619` [V] | Still true; lines moved. Task 6 keeps its design |
| F8: no time or randomness seam | `newReconnectBackoff(rnd)` takes an injectable rand (`reconnect_backoff.go:139`; the tests use `fixedRand`). The loop passes `nil` (`client.go:474`) and uses `time.Now` (`:496`), `time.Since` (`:504`) and `time.NewTimer` (`:516`). Loop tests run on real time (`reconnect_backoff_test.go:326-480`) [V] | **PARTLY STALE.** Task 1 shrinks |
| F9: startup bundle and first-beat jitter | First-beat jitter is at `heartbeat.go:2192-2198`, the update marker at `:2180` (`checkUpdateMarker` `:2058-2073`), and the bundle at `:2223-2226`. The gates are stamped at `:2247, 2248, 2253` and the reliability post at `:2256`. The WS client dials at once on `Start` (`agentapp/main.go:1043` → `client.go:294` → `:473`) [V] | Still true; lines moved |

**HTTP retry** (`agent/internal/httputil`)

| Plan claim | Now | Verdict |
|---|---|---|
| F10: `Do` honours `Retry-After` with 0–30 % jitter, clamped to 300 s after jitter | Unchanged: `retry.go:66-144`, and `applyPositiveJitter` clamps to `retryAfterMaxCap` (`retry.go:189-198`; `retryafter.go:12` = 300 s) [V] | Still true |
| F11: the `Retry-After` value is lost when it outlives the context, and nobody inspects `RetryableStatusError` | `Do` still sleeps into the deadline (`retry.go:98-102`). It now returns `withServerAnswer(ctx.Err(), lastAnswer)` (`:100, :145`; func `:162-171`), so the chain holds both `context.DeadlineExceeded` and `*RetryableStatusError{StatusCode, URL}`. There is still **no delay or absolute time**. `heartbeat/server_unavailable_liveness.go:40-46` (`serverOverloadAnswer`, `errors.As`) is the first caller outside the package; it feeds the watchdog marker at `heartbeat.go:5319-5320` [V] | **CHANGED.** Task 5 is rewritten to extend this chain and keep the #9146 liveness contract |
| F12: `retry_jitter_test.go` asserts the 300 s clamp | `TestApplyPositiveJitterClampsToRetryAfterMaxCap` (`retry_jitter_test.go:67-74`) [V] | Still true. It now **stays unchanged**, because 300 s stands (A2) |
| Second 300 s cap | `websocket/reconnect_backoff.go:47` `retryAfterCeiling = 300 s` ("matching httputil") [V] | New. It stays at 300 s |
| `httputil.Do` callers (Task 5 and Task 7 audit) | Monitoring results `heartbeat.go:2557`; `sendInventoryData` `:2642`; process sample `:2836`; **peripherals `:2866`**; boot performance `:4457`; reliability `:4506`; heartbeat `:5313`; command result `:7096`. Also **`message_events.go:101`**, **`chat_events.go:214`**, `pam_reconciliation.go:163`, `handlers_elevation.go:44`, `discovery/adjacency_transport.go:265`, `tools/agentsim/sim/agent.go:136` [V] | The three **bold** callers are new to the audit |

**Periodic senders, UniFi, log shipper, monitoring, config**

| Plan claim | Now | Verdict |
|---|---|---|
| F13 `sendInventoryData` and its callers | Func `heartbeat.go:2612` (ctx `:2639`, Do `:2642`). Callers are `:2902, 2987, 3000, 3010, 3041, 3076, 3787, 3926, 3937, 4323, 4337, 4346, 4398, 4407, 4433`, `hardware_health.go:157`, `time_sync.go:100` and `workloads.go:300` [V] | Still true; lines moved |
| F14 event logs collect, then ignore the send error | `heartbeat.go:4326-4338` [V] | Still true |
| F15 recovery keys pop and re-park | Pop at `:4354-4357`, re-park at `:4359-4366` [V] | Still true |
| F16, F17 | Monitoring `:2557` (15 s ctx). Heartbeat `doHeartbeatPost` `:5296`: ctx `:5310`, Do `:5313`. `LastHeartbeat` is written only on 200 (`:5358, :5364`). `HeartbeatStaleThreshold` is 3 min (`config.go:416`) [V] | Still true. **New:** #9146 records `ServerUnavailableAt` on a heartbeat 429/502/503/504 (`heartbeat.go:5319-5320`), and the watchdog treats it as liveness (`watchdog/checks.go:455, 476`) |
| Precedent for a carried `notBefore` | `heartbeat/network_context.go:56, 140, 216-217` (`retryNotBefore` from a body `RetryAfterSeconds`) [V] | New. Task 7 follows its shape |
| F18 UniFi | Telemetry `unifi/collector.go:224-235` (raw `deps.HTTP.Do` `:229`); loop `:362-419`; `fetchConfigs` `:422-446` (Do `:431`); `fetchSchedule` `collector_schedule.go:49-61` [V] | Still true |
| F19 log shipper | `shipRetryCount` `shipper.go:458`; loop `:579`; uncancellable `time.Sleep` `:582, :586`; parse `:621`; cap `logging/retryafter.go:12` [V] | Still true |
| F20 monitoring | Ticker `monitor.go:105`; immediate check `:134`; tick `:141` [V] | Still true |
| D10 keys | Neither key exists. Defaults are in `Default()` (`config.go:379`) and validation in `config/validate.go:63`. `websocket.Config` (`client.go:56-61`) has only `ServerURL`, `AgentID`, `AuthToken` and `TLSConfig`; it is built at `agentapp/main.go:1035-1043` [V] | Still to do |

**Server contract and simulator**

| Plan claim | Now | Verdict |
|---|---|---|
| S4: nothing sends `drain` | No `type: 'drain'` and no `reconnectWithinMs` in `apps/api/src` [V] | Still true |
| `Retry-After` values on agent routes | `services/admission/agentRouteClasses.ts:101-114`: bulk 120–180, standard 60–90, `/logs` 2–4, `unifi-collectors` 30–45, WS 5–120. The WS answer is `lo = ceil(backlog/rate)` clamped, with `hi = min(120, ceil(1.3·lo))` (`admissionRuntime.ts:204-214`). DB saturation is 30–45 (`middleware/dbSaturationResponse.ts:36-39`), the org rate limit 60 (`agentAuth.ts:944`), the global rate limit 60 by default (`globalRateLimit.ts:171, 227`), inventory 5 (`routes/agents/inventory.ts:152`). The one larger value is mTLS renewal's success window, up to 3,600 s (`routes/agents/mtls.ts:64, 759-762`). It goes to a raw-HTTP client that never reads the header (`agent/pkg/api/client.go:676`) [V] | Input to A2. **The largest that any `httputil.Do` or WS caller reads is 180 s** |
| W06 (#8587) | Merged. `agent/tools/agentsim` imports `agent/internal/websocket` (`sim/ws.go:15`; same module). `sim/ws.go:18-32` mirrors the **pre-#9145** backoff constants, and `:85` says "an established socket that drops is redialled at once". `--legacy-retry-fraction` exists (`main.go:59`, `sim/config.go:291`). `load-tests/agentsim/storms/` holds `storm-suite.json` and six scenarios. There is no `drain-sockets` and no `--pre-w09-fraction` [V] | Task 12's gate is met. The simulator is **stale against #9145**, which Task 12 fixes |
| Docs targets | `upgrades.mdx:77` still says "reconnect automatically". `next-release-draft.md` exists [V] | Task 11 unchanged |

**"Today fails" claims in the original Task 2 and Task 3.** `TestShortLivedSocketsBackOff`, `TestNoHintServerKeepsBackoffShape`, `TestRefusedDialHonoursRetryAfter`, `TestRefusedDialNon503`, `TestDialAfterStopIsDiscarded` and `TestStopDuringFirstReconnectWait` (as a Stop guarantee) would all **pass today**. The #9145/#9245 tests that already pin each behaviour are named in A4. `TestStableRemoteDropWaitsFirstWindow` still fails today, because main waits 3 s at rand 0.5 rather than the 15.5 s it expects. `TestForceReconnectIsImmediate` fails **by design**: main waits 0.25–1 s, and A3 keeps that.

### A2. The two numbers: the first window (D1), and why 300 s stands

**First window.** The default is W = `ws_first_reconnect_window_seconds` = 30 s. D1 allows 0–300; values above 300 are clamped with a Warn. After a **stable** socket (lived > 30 s) closed by the server, normally or abnormally, the wait is U(1 s, max(W, 5 s)). Normal and abnormal closes share the window because an unannounced API kill shows up as 1006, an abnormal close; spec item (1) is about exactly that. The upper bound never drops below 5 s, so **W ≤ 5 reproduces #9145 exactly**: U(1 s, 5 s). That is what the escape hatch means now. "Immediate" no longer exists on main to be restored, and #9145 made it a bug. The step bookkeeping does not change: a stable close resets the step, and an abnormal one then advances it once, as `TestReconnectBackoff_HealthyConnectionResetsStep` pins. Short-lived sockets keep #9145's escalation, untouched by W.

**300 s vs 390 s.** The plan's D1/D5 chose a 390 s post-jitter ceiling because clamping after jitter collapses agents onto the clamp. The collapse is real but conditional:

- `applyPositiveJitter` returns RA × (1 + 0.3·U) clamped to 300 s. The clamp engages only when RA × 1.3 > 300, that is **RA > 230.8 s**. For a parsed RA of exactly 300 s, every agent lands at exactly 300 s, a full re-synchronisation. For RA between 230.8 s and 300 s, the fraction that lands on the clamp is 1 − (300/RA − 1)/0.3.
- The largest `Retry-After` that any `httputil.Do` or WS caller can read today is **180 s** (bulk; see A1, Server contract). mTLS renewal can send up to 3,600 s, but its raw-HTTP client discards the header, so it never reaches this jitter. The jittered maximum is 180 × 1.3 = **234 s < 300 s**, so the clamp never engages. 300 and 390 give **identical waits for every answer the server can give today**.
- Spread of a 10k shed burst on a bulk route: the server draws RA uniformly from 120–180 (61 integer values), and the agent multiplies by 1 + 0.3·U. Arrivals land in [120 s, 234 s]. The densest stretch is 156–180 s at about 10,000 / 82 s ≈ 120/s, with no spike.
- WS: W08 admits 10 upgrades/s per instance with a burst of 20, so a single instance needs (10,000 − 20)/10 ≈ **998 instance-seconds** to admit 10k agents, whatever window the agent uses. The server already paces the herd with RA = ceil(backlog/rate), bounded 5–120 s, plus a ×1.3 range. The agent's +0–30 % only smooths each refusal cohort. The ceiling never enters this calculation, because the WS maximum after jitter is 156 s.
- Moving to 390 s would change three constants (`httputil/retryafter.go:12`, `websocket/reconnect_backoff.go:47`, `logging/retryafter.go:12`) and one shipped test. It would lengthen the worst-case silence of a route by 30 %, and it would help only a server that sends a flat RA of 231 s or more. No server code does that.

**Decision: 300 s stands.** The guard belongs where the risk is. Follow-up 6 (new) is an API unit test asserting that every admission, overload and rate-limit `Retry-After` range that an agent's `httputil.Do` or WS dial reads has an upper bound × 1.3 ≤ 300, so a future range cannot drift into the collapse zone unnoticed. It is not part of this PR (no API change in W09).

### A3. Reconciled reconnect policy (replaces "Reconnect policy table")

"Step" is `reconnectBackoff.step`. "jitter(step)" is step ±30 %. U(a, b) is uniform. W is the first window and N is a live drain hint (A4, Task 4). Every wait has a floor of `minReconnectDelay` (250 ms).

| Last event | On main (#9145) | W09 | Step after |
|---|---|---|---|
| Process start (first dial) | 0 | U(0, 10 s), also after a self-update | 1 s (unchanged) |
| Dial failed, no `Retry-After` | jitter(step) | unchanged | ×2, max 60 s |
| Upgrade refused 429/503 with RA | max(jitter(step), min(RA × (1 + 0.3·U), 300 s)) | unchanged | ×2 |
| Local close (`ForceReconnect`; no close frame received) | U(250 ms, 1 s) | unchanged | reset to 1 s if the socket lived > 30 s, else unchanged (as #9145) |
| Remote close, lived > 30 s, no live drain hint | normal: U(1 s, 5 s); abnormal: max(U(1 s, 5 s), jitter(1 s)) | normal: U(1 s, max(W, 5 s)); abnormal: max(U(1 s, max(W, 5 s)), jitter(1 s)) | reset to 1 s; an abnormal close then advances once (unchanged) |
| Remote close, lived > 30 s, live drain hint N | n/a | U(0, max(N, 5 s)). Windows below 5 s are widened to 5 s; this joins the wire contract (A3 note) | as the row above |
| Remote close, lived ≤ 30 s | max(U(1 s, 5 s), jitter(step)) | max(#9145 wait, U(0, max(N, 5 s)) if a live hint) | ×2 (unchanged) |
| `Stop()` | the loop exits; the dial is cancelled; a socket installed after `Stop` is closed (#9245) | unchanged | — |

Two choices in this table differ from the original plan.

**`localClose` stays; connection generations are dropped** (the original D3 mechanism). The original plan wanted generations to stop a stale local mark from exempting a later remote drop. On main that cannot happen, for three reasons. `ForceReconnect` marks the drop only while a socket is held (`client.go:388-395`). The loop `Swap(false)`s the mark exactly once per connection end (`:510`). A received close frame outranks the mark (`classifyDisconnect`, `reconnect_backoff.go:84-100`, pinned by `TestClassifyDisconnect` "server close frame outranks a racing local mark"). One race remains: `ForceReconnect` landing between `readPump` returning on a 1006 and `closeCurrentConn`. The plan's `readFailedGen` would narrow that race, since it rejects a mark after a read failure, but it would not close it: the mark and the read failure can still cross inside `readPump`. We accept the residual on purpose. Its cost is one agent, already disconnected by the server, redialling within 1 s instead of within the first window, and the trigger is a local credential rotation, which is not fleet-synchronised with a server drop. The drain hint needs no generation either: `readPump` runs synchronously on the reconnect-loop goroutine (`client.go:500`), so the hint can be a loop-owned field that is cleared at every connection end.

**Drain windows below 5 s are widened to 5 s.** A server that sends N < 5 s (or 0) to a whole fleet would otherwise get it back within N. Widening keeps #9145's 1–5 s spread as the floor of any server-initiated reconnect. Add this sentence to D4's wire shape for W5c: "the agent spreads over max(reconnectWithinMs, 5000) ms". Codex flagged that the original promise was U(0, N); see A13.

**`ForceReconnect` waits 0.25–1 s, not 0** (Review Focus 3). #9145 chose this on purpose: an mTLS renewal or token rotation pushed to many agents should not redial them in the same millisecond. It costs at most 1 s per rotation.

### A4. Task disposition

| Task | Disposition | Why |
|---|---|---|
| 1 Clock and rand seams | **Keep, smaller** | The rand seam exists (`newReconnectBackoff(rnd)`). Only the clock seam and the loop's use of `wsRand` are left (A5) |
| 2 Reconnect policy | **Rewrite** | Extend `reconnectBackoff` with the D1 window and the start jitter. No new `ReconnectPolicy` type. Keep the original's install-after-`Stop` guarantee, which #9245 only half delivers (A6) |
| 3 Refused WS upgrade `Retry-After` | **Drop** | Delivered by #9145. `TestConnect_UpgradeRefusalCarriesStatusAndRetryAfter` (`reconnect_backoff_test.go:233`), `TestReconnectBackoff_DialFailureHonoursRetryAfter` (`:177`), `TestReconnectLoop_HonoursRetryAfterOnRefusedUpgrade` (`:354`) and `TestReconnectLoop_StopInterruptsRetryAfterWait` (`:415`) pin it. 401/403 are not honoured (`reconnect_backoff.go:126`), and HTTP-dates parse through `httputil.ParseRetryAfter`. The 390 s bound is not adopted (A2). The one interaction test left, `TestRefusalAfterDrainUsesRetryAfter`, moves to Task 4 |
| 4 `drain` message | **Rewrite (plumbing only)** | Parsing and the 10k spread test are unchanged. The hint is a loop-owned field, not a generation-tagged one. Expected waits are recomputed for A3 (A7) |
| 5 `httputil.Do` keeps the server's delay | **Rewrite** | Build on `withServerAnswer`, keep 300 s, and keep #9146's liveness contract (A8) |
| 6 Results while disconnected go to the outbox | **Keep** | F7 still holds. Use the new lines: `processCommand` `client.go:893-924`, the `SendResult` callers in A1 |
| 7 Per-route loop deferral | **Keep, with edits** (A9) | New `Do` callers to classify. Follow `network_context.go`'s `retryNotBefore`. The heartbeat guard also asserts the #9146 marker |
| 8 UniFi | **Keep, with edits** | Lines as in A1. "390 s" becomes 300 s; the bound is `httputil.applyPositiveJitter`'s |
| 9 Log shipper | **Keep, with edits** | Lines as in A1. "390 s ceiling" becomes 300 s. The test that the two parsers agree also asserts the two caps are equal |
| 10 Startup spread and config | **Keep, with edits** (A10) | The WS start jitter moves to Task 2. Key value `0` means #9145's 1–5 s, not "immediate" |
| 11 Docs | **Keep, with edits** | Wording: "spread over up to 30 s (was 1–5 s)", and key `0` restores the 1–5 s spread |
| 12 Simulator | **Rewrite** | W06 is merged, so the gate is met. The sim's mirror is stale against #9145. It needs an exported pacer, because `reconnectBackoff` is unexported (A11) |
| 13 Full verification | **Keep** | `./tools/agentsim/...` is now always in scope |

### A5. Task 1 (keep, smaller): clock seam for the loop

Run the original Task 1 as written, with these edits:

- `wsRand` is passed into the existing seam: `backoff := newReconnectBackoff(wsRand)` at `client.go:474`. `reconnectBackoff` itself stays as it is.
- `reconnectLoop` reads `wsClock.Now()` where it now calls `time.Now()` (`:496`) and `time.Since` (`:504`). It waits on `wsClock.After(sleep)` instead of `time.NewTimer` (`:516-523`), selecting on `c.done` as it does today.
- Step 3 must also keep the existing real-clock loop tests in `reconnect_backoff_test.go:326-480` green. They do not install the fake, so they run on `realClock`.

### A6. Task 2 (rewrite): the D1 first window and the start jitter in `reconnectBackoff`

**Files:** modify `agent/internal/websocket/reconnect_backoff.go`, `client.go` (`Config`, `New`, `reconnectLoop`) and `reconnect_backoff_test.go`. Create `agent/internal/websocket/client_reconnect_window_test.go` (fake clock) and modify `helpers_test.go`.

**Interfaces (produced):**
- `const defaultFirstReconnectWindow = 30 * time.Second`, `maxFirstReconnectWindow = 300 * time.Second`, `defaultStartDialWindow = 10 * time.Second` in `reconnect_backoff.go`.
- `reconnectBackoff.firstWindow time.Duration`. `newReconnectBackoff(rnd)` sets it to `defaultFirstReconnectWindow`, so every existing test call keeps compiling.
- `func (b *reconnectBackoff) atStart(window time.Duration) time.Duration` returns U(0, window), and 0 when window ≤ 0. It does not change the step.
- `websocket.Config.FirstReconnectWindow *time.Duration`: nil means the default; a value is clamped to [0, 300 s]. Task 10 sets it from the config key.
- `Client.firstWindow`, `Client.startWindow time.Duration` (unexported). `New` sets them from `Config` and `defaultStartDialWindow`. `newTestClient` (`helpers_test.go`) sets `startWindow = 0` after `New`, so no existing real-clock test gains a start wait.

- [ ] **Step 1: Red, pure** (`reconnect_backoff_test.go`):
  - `TestReconnectBackoff_StableRemoteCloseSpreadsOverFirstWindow`. For codes 1000, 1001, 4040, 1006, 4008 and 4001, `lasted` 31 s and 1 h, and every `randSamples` value, the delay is in [1 s, 30 s]. At r = 0.5 the normal-close delay is exactly 15.5 s. **Fails today** with 3 s.
  - `TestReconnectBackoff_FirstWindowAtOrBelow5sIsPreW09`. With `firstWindow` 0 and 5 s, a stable normal close at r = 0.5 waits 3 s, and the delay is in [1 s, 5 s] for every sample. A regression guard, green today.
  - `TestReconnectBackoff_ShortLivedCloseIgnoresFirstWindow`. With `firstWindow` 30 s, ten closes with `lasted` 1 s and r = 0.5 give the same sequence as `firstWindow` 0: 3, 3, 4, 8, 16, 32, 60, 60, 60, 60 s (normal close; the max of U(1, 5) = 3 s and the step). A guard.
  - `TestReconnectBackoff_AtStart`. `atStart(10 s)` at r = 0.5 is 5 s; `atStart(0)` is 0; the step is unchanged. Fails to build today.
  - On-purpose change: `TestReconnectBackoff_NormalCloseAfterHealthyConnection` (`:108`) upper bound `serverCloseSpreadMax` becomes `defaultFirstReconnectWindow`. Say so in the commit.

  Run `cd agent && go test -race -run 'TestReconnectBackoff_' ./internal/websocket/`. Expect a build failure, then the first test failing.

- [ ] **Step 2: Red, real client on the fake clock** (`client_reconnect_window_test.go`; uses Task 1's `installFakeWSClock`, `installWSRand(t, 0.5)` and the `startClient` helper). Each test waits on a test hook `c.testHooks.connected`, a channel fed after `connect` installs the socket, before it advances the clock.
  - `TestStableRemoteDropWaitsFirstWindow`. The server accepts. The test advances 31 s, then the server closes with 1001. Assert one registered waiter of 15.5 s and no second dial until the clock passes it, then exactly one dial. **Fails today**: the waiter is 3 s.
  - `TestStableAbnormalDropWaitsFirstWindow`. As above, but the server drops the TCP connection with no close frame (1006). Same 15.5 s.
  - `TestFirstReconnectWindowZeroIsPreW09`. `Config.FirstReconnectWindow = ptr(0)`; the stable drop waits 3 s.
  - `TestWSStartDialJittered`. The client is built with `startWindow` 10 s. `Start()` registers a 5 s waiter before the first dial, and the server sees no dial until the clock passes it.
  - `TestStopDuringStartWait` and `TestStopDuringFirstReconnectWait`. `Stop()` during either wait makes `Start` return within the hang guard, with no further dial.
  - `TestDialAfterStopIsDiscarded` (kept from the original). A test hook `c.testHooks.beforeInstall`, called between a successful dial and the install, blocks. The test calls `Stop()` and then releases the hook. Assert that `c.IsConnected()` never reports true afterwards and that the server sees the socket closed. **Fails today:** `connect` installs unconditionally (`client.go:440-442`), and #9245's check at `:490-493` closes the socket only after it was installed, so `IsConnected()` can read true after `Stop` returned.

  Run `go test -race -run 'TestStable|TestFirstReconnectWindow|TestWSStartDial|TestStopDuring' ./internal/websocket/`. Expect FAIL on the waiter values.

- [ ] **Step 3: Implement.** In `afterDisconnect`, for a non-local kind with `lasted > stableConnectionThreshold`, the spread is `b.uniform(serverCloseSpreadMin, max(b.firstWindow, serverCloseSpreadMax))` instead of the fixed 1–5 s; the abnormal branch keeps `max(spread, b.jitteredStep())` and `advance()`. The short-lived branches are unchanged. In `reconnectLoop`, set `backoff.firstWindow = c.firstWindow`, and before the first `connect()` wait `backoff.atStart(c.startWindow)` on `wsClock.After`, selecting on `c.done`. Log `log.Info("initial connect delayed", "delay", d)` when d > 0. In `connect`, install the socket under `connMu` only after re-checking `c.stopped()` in the same critical section. If the client has stopped, close the new socket and return `context.Canceled`. Keep #9245's loop check as the second line of defence. The existing `connection failed … retryIn` and `disconnected kind … retryIn` lines (`client.go:484, 512`) are the observable G2 reads; keep their keys.
- [ ] **Step 4:** Steps 1 and 2 green. `go test -race ./internal/websocket/...` green, including every #9145/#9245 test, unchanged except the bound edit in Step 1.
- [ ] **Step 5: Commit:** `feat(agent): spread the first reconnect after a stable socket over 30 s and jitter the first dial (W09, #8148)`

**Dropped from the original Task 2, with the tests that already pin each on main:**

| Original test | Covered by |
|---|---|
| `TestShortLivedSocketsBackOff` | `TestReconnectBackoff_NormalCloseFlappingEscalates` (`:122`), `_AbnormalCloseAtLeastAsHardAsDialFailure` (`:82`) |
| `TestForceReconnectIsImmediate` | Superseded: `TestReconnectBackoff_LocalCloseIsShortAndJittered` (`:164`) pins 0.25–1 s (A3) |
| `TestStaleForceReconnectDoesNotExemptNextDrop` | `TestForceReconnect_MarksDropAsLocal` (`:382`), whose first half covers no mark without a socket; the per-connection `Swap` at `client.go:510` |
| `TestForceReconnectAfterRemoteDeathIsRemote` | The close-frame case is in `TestClassifyDisconnect` "server close frame outranks a racing local mark"; the 1006 race is accepted (A3) |
| `TestLivedExactly30sIsShortLived` | `TestReconnectBackoff_HealthyConnectionResetsStep` "exactly the threshold is not healthy" |
| `TestNoHintServerKeepsBackoffShape` | `TestReconnectBackoff_DialFailureWithoutRetryAfterUsesJitteredStep` (`:206`) |
| `TestReconnectPolicyTable`, `…BackoffCapsAt60s`, `…NeverNegative` | Step 1 above, plus `TestReconnectBackoff_NeverBelowFloor` (`:216`) and `_AbnormalCloseAtLeastAsHardAsDialFailure` (the cap) |

### A7. Task 4 (rewrite, plumbing only): the `drain` message

The original Task 4 stands for `TestDrainHintValidation` (Step 1, unchanged), `TestDrainSpread10kAgents` (Step 2; only the call changes, see below), the wire shape (D4) and the two regression guards. The edits:

**Interfaces (produced):** `drain.go` has `parseDrainHint(raw []byte) (time.Duration, bool)` and `type drainHint struct{ within time.Duration; expires time.Time; set bool }`. `Client.drain drainHint` is owned by the reconnect-loop goroutine; `readPump` runs on it (`client.go:500`), so no lock is needed. `func (b *reconnectBackoff) afterDrainedDisconnect(kind disconnectKind, lasted, within time.Duration) time.Duration` implements the A3 drain rows; a local kind ignores `within`. The existing `afterDisconnect(kind, lasted)` keeps its signature, so the #9145 tests stay untouched.

- `TestDrainSpread10kAgents` calls `b.afterDrainedDisconnect(disconnectServerNormal, time.Hour, 120*time.Second)` on one `newReconnectBackoff(r.Float64)` with the PCG seed `(8148, 9)`. The buckets and the ±10 % band are unchanged. The 250 ms floor only affects draws below 0.25 s, which stay in bucket 0.
- Expected waits with r = 0.5. `TestDrainDelayStartsAtClose` stays 60 s; the socket has lived 60 s, so it is stable. `TestDrainThenImmediateClose` stays 30 s at r = 0.25, and the socket must have lived > 30 s first, so the test advances 31 s before the hint. `TestDrainExpires` changes to **15.5 s** (the first window). `TestDuplicateDrainFirstWins` stays 60 s, after advancing 31 s. `TestDrainHintClearedOnNewSocket` changes to **15.5 s**. `TestDrainZeroDoesNotDefeatBackoff` becomes **3, 3, 4, 8, 16 s**: each wait is max(#9145 short-lived, U(0, 5 s) = 2.5 s). `TestRefusalAfterDrainUsesRetryAfter`, carried over from Task 3, is **69 s**: max(jitter(1 s), 60 × 1.15).
- Added: `TestDrainShortWindowKeepsSpread`. On a stable socket, drain 0 waits U(0, 5 s), so 2.5 s at r = 0.5, and the 250 ms floor at r = 0. This guards against a server's N = 0 synchronising the fleet.
- Implementation: `readPump` handles `msg.Type == "drain"` right after the `desktop_ice_candidate` branch (`client.go:617-620`), **before** the id-less skip (`:624`). If `!c.drain.set`, it stores `within` with `expires = wsClock.Now() + within + 30 s`, and logs Info `drain hint received` with `withinMs` and `reason` (truncated to 64 bytes). In `reconnectLoop`, after the pumps exit, it reads and clears `c.drain`. A set, unexpired hint goes through `afterDrainedDisconnect`; otherwise `afterDisconnect`. It also clears `c.drain` before each `connect()`.
- Drop the original Step 4's `gen` tagging. `TestDrainAfterCloseDetectedIsIgnored` stays: a hint parsed after the loop consumed the close, which only a test can force via the hook, must not affect the next wait.

### A8. Task 5 (rewrite): `RetryAt` on the existing `withServerAnswer` chain

**Files:** create `agent/internal/httputil/clock.go` and `retry_loop_test.go`. Modify `retry.go` and `retry_server_answer_test.go`. Add a test to `agent/internal/heartbeat/server_unavailable_liveness_test.go` (test only).

**Interfaces (produced):** `RetryableStatusError.RetryAt time.Time` (zero when the answer had no hint); `func RetryAtFrom(err error) (time.Time, bool)` (`errors.As`); `func SetLoopRetryAfter(enabled bool)` (an `atomic.Bool`, default true); seams `nowFn`, `afterFn`, `randFloat` in `clock.go`. `applyPositiveJitter` and `applyJitter` draw from `randFloat` instead of the `math/rand/v2` global (`retry.go:193, 205`). **The caps do not change:** `retryAfterMaxCap` stays 300 s and `retry_jitter_test.go` is not edited.

- [ ] **Step 1: Red.** The original Task 5 Step 1 tests stand, except `TestRetryAtBounds`, which now expects RA 300 s at rnd 0.999 to give `RetryAt ≤ now + 300 s`, and an HTTP-date 1 h ahead to give `now + 300 s`. Add:
  - `TestDoEarlyReturnKeepsOverloadAnswer`. In the early-return case, `errors.As(err, &rse)` holds with `StatusCode` 503 and a non-zero `RetryAt`, and `Do` returned before the context's deadline. It does **not** assert `context.DeadlineExceeded`: the context has not expired, and no non-test caller branches on it (audit below).
  - On-purpose change: `TestDoKeepsServerAnswerWhenContextExpiresDuringRetryAfter` (`retry_server_answer_test.go:18`) gains `SetLoopRetryAfter(false)` with a `t.Cleanup` restore. It now pins the D10 off-switch path, which still sleeps into the deadline and still returns `DeadlineExceeded` plus the answer. The other two #9146 tests there stay unchanged.
  - `TestHeartbeatOverloadAnswerWithRetryAtStillRecordsLiveness` (heartbeat package). An `httputil.Do` error carrying `RetryAt`, with no context error in the chain, still makes `serverOverloadAnswer` return `(503, true)`. This is a guard: it passes as soon as the field exists, and it protects D2/#9146.
- [ ] **Step 2: Implement.** At the retryable answer (`retry.go:137-143`), when `ra > 0`, compute `wait := applyPositiveJitter(ra, cfg.JitterFrac)` once, set `lastAnswer = &RetryableStatusError{StatusCode, URL, RetryAt: nowFn().Add(wait)}`, and use that `wait` as the next sleep instead of jittering again at `:82`. If `loopRetryAfter` is set, and either this was the last attempt or the context has a deadline with `time.Until(deadline) < wait`, return `nil, lastAnswer` at once and log Debug `retry-after exceeds caller deadline; returning RetryAt`. Otherwise sleep on `afterFn(wait)` as today. `withServerAnswer` is unchanged; it now carries `RetryAt` because it wraps the same `lastAnswer`.
- [ ] **Step 3: Caller audit.** Use the 12 non-test `Do` callers in A1. For each, confirm that it does not branch on `context.DeadlineExceeded` from `Do`. Checked while planning: the only `DeadlineExceeded` checks near these callers test `ctx.Err()` (e.g. `heartbeat/watchdog_register.go:60`), never `Do`'s error. List them in the PR. `go test -race ./internal/httputil/... ./internal/discovery/...`, and `-run 'ServerUnavailable|Overload' ./internal/heartbeat/`, are green.
- [ ] **Step 4: Commit:** `feat(agent): carry the server's Retry-After as RetryAt and stop sleeping into the caller's deadline (W09, #8148)`

### A9. Task 7 edits (keep)

- Line references: use A1 (F13–F17).
- The audit table gains `peripherals` (`heartbeat.go:2866`), `message_events.go:101` and `chat_events.go:214`. Classify each against `agentRouteClasses.ts`. A route W08 classes `bulk` or `standard` is gated. An interactive or end-user route that W08 never sheds is exempt, with the reason recorded. The PR states which.
- `loopDeferral` follows the shape of `network_context.go`'s `retryNotBefore` (`:56, 140, 216-217`): an absolute not-before time, compared with an injected `now`. Do not invent a second idiom.
- `TestHeartbeatIgnoresLoopDeferral` also asserts that the heartbeat's 503 + `Retry-After: 300` still reaches `noteServerUnavailableLiveness` (#9146). A deferred heartbeat would stop refreshing `ServerUnavailableAt`, and the watchdog would fall back to its stale-restart path after 3 minutes.
- `TestHeartbeatIgnoresLoopDeferral` pre-seeds 300 s ahead (not 390 s).
- `TestEveryAgentRouteCallIsGatedOrExempt` exempt list: heartbeat (`:5313`), command result (`:7096`), elevation, PAM reconciliation, plus whichever of message and chat events the audit marks exempt.

### A10. Task 10 edits (keep)

- WS start jitter and `Config.FirstReconnectWindow` are Task 2's. Task 10 only maps the config key to `websocket.Config.FirstReconnectWindow` at `agentapp/main.go:1035-1043`. `TestFirstReconnectWindowZeroVsUnset` moves to Task 2 as `TestFirstReconnectWindowZeroIsPreW09`.
- `TestConfigReconnectKeys`: defaults 30 and true. `0` is accepted and means #9145's 1–5 s spread. 301 is clamped to 300 with a Warn; a negative value takes the default with a Warn. Put the defaults in `Default()` (`config.go:379`) and the bounds in `Validate()` (`config/validate.go:63`).
- Heartbeat lines: bundle `heartbeat.go:2223-2226`, gate stamps `:2247, 2248, 2253`, reliability post `:2256` (left unstaggered). Monitoring: `monitor.go:105, 134`.
- Global Constraints, Design D10 and Task 11 wording: "`0` restores today's immediate redial" becomes "**`0`–`5` restores the 1–5 s spread shipped in #9145**".

### A11. Task 12 (rewrite): the simulator uses the shipped pacing

**Gate:** met (#8587 merged). **Files:** create `agent/internal/websocket/reconnect_pacer.go` and its test. Modify `agent/tools/agentsim/sim/ws.go`, `sim/agent.go`, `sim/storm.go`, `sim/config.go` and `agent/tools/agentsim/main.go`, with their tests. Create `load-tests/agentsim/storms/drain-120.json`. Append `## Reconnect and drain (W09)` to `load-tests/agentsim/README.md`. **`storm-suite.json` is not edited.**

**Interfaces (produced, exported for `agentsim` only; the `internal/` path keeps them inside the module):**

```go
type ReconnectPacer struct{ b *reconnectBackoff }
func NewReconnectPacer(rnd func() float64, firstWindow time.Duration) *ReconnectPacer
func (p *ReconnectPacer) AtStart(window time.Duration) time.Duration
func (p *ReconnectPacer) AfterDialFailure(status int, retryAfter time.Duration) time.Duration
func (p *ReconnectPacer) AfterDisconnect(closeCode int, local bool, lasted, drainWithin time.Duration) time.Duration // drainWithin < 0: no hint
```

`AfterDisconnect` maps `closeCode` through `classifyDisconnect`. `AfterDialFailure` builds an `upgradeRefusedError` when `status` is 429 or 503.

- [ ] **Step 1: Red.**
  - `TestReconnectPacerMatchesClientPolicy` (websocket). For a table of events, the pacer's waits equal `reconnectBackoff`'s for the same rand.
  - `TestSimRunUsesAgentReconnectPolicy` (`ws_test.go`). A sim session whose socket drops after 31 s of sim time waits the pacer's first-window delay. Delete the mirror constants `wsInitialBackoff`, `wsMaxBackoff`, `wsBackoffFactor`, `wsJitterFrac` and `wsStableAfter` (`sim/ws.go:26-30`) and the `:85` comment; keep `wsWriteWait`, `wsPongWait`, `wsHandshake` and `wsMaxMessage`.
  - `TestDrainSocketsActionSpreadsReconnects` and `TestScenarioFilesLoad` are as in the original.
  - `TestPreW09CohortUsesShippedPacing`. With `--pre-w09-fraction 0.5`, half the sessions use `NewReconnectPacer(rnd, 0)` and ignore drain. That is the #9145 agent the release replaces: a 1–5 s spread, not "immediate". Their reconnects after `api-kill` land in [1 s, 5 s].
- [ ] **Steps 2–4:** as in the original Task 12, with the cohort definition above. The report field `AgentReport.PreW09` (`omitempty`) is unchanged. In the README, state that agents older than #9145 (immediate redial) are not modelled. Their share of the fleet shrinks with every promote, and W08's admission covers them (spec: "Old agents still rely on W1c").

### A12. Review Focus and Global Constraints edits

- RF2 (tight loop): delivered by #9145. It remains a regression guard through the tests named in A6.
- RF3 (local reconnects): replace "must redial with no added delay" with "must redial within 1 s". `TestReconnectBackoff_LocalCloseIsShortAndJittered` pins it.
- RF4 (Stop): delivered by #9145 and #9245. The Task 2 Stop tests cover only the two new waits (start, first window).
- RF6 (hostile hints): "jittered result to 390 s" becomes "**300 s**".
- Merge Danger, "a route silenced for up to 390 s per server answer": change to **300 s**.
- Acceptance, "Unannounced API kill: no reconnect spike above the W1c admission rate": this is about **accepts**, not attempts (Codex, A13). W08's bucket bounds accepted upgrades, and only in `enforce` mode. A `Retry-After` cannot pace an attempt made before the agent received one. With D1, first-window attempts after a kill run at about agents/29 s: about 14/s at G1's 400 agents, well inside G1's (rate + burst) × 1.5 = 45/s bound; about 345/s at 10k, all refused before upgrade beyond the bucket. Later attempts are paced by the server's `Retry-After`. G1 is unchanged. The 10k attempt rate is **recorded** under G3, not claimed.
- Follow-up 2 (watchdog overload liveness) is **done**: #9146 (`heartbeat.go:5319-5320`, `watchdog/checks.go:455, 476`). Do not file it.
- Global Constraints, line "Two agent config keys…": the semantics of `0` are as in A10.

### A13. Advisor quorum (2026-10-20)

Codex (`gpt-6-astra`, reasoning `xhigh`, read-only sandbox) reviewed the A3 table, `localClose` vs generations, 300 vs 390, the A8 early return, and what else had gone stale. Its verdict was **"DISAGREE on item 1"** (the policy table). Every point is resolved on the merits below. None needs Todd.

| Item | Codex | Resolution |
|---|---|---|
| 1a. W ≤ 5 reproduces #9145 | Only if the abnormal close keeps max(…, jitter(1 s)) and the advance to 2 s, and only if a stable local close resets the step to 1 s; the draft said "unchanged" | **Adopted.** A3's abnormal row keeps both, and the local row now says "reset if lived > 30 s". `TestReconnectBackoff_HealthyConnectionResetsStep` already pins both |
| 1b. Drain max(N, 5 s) | It permits waits longer than a valid hint below 5 s, while the plan promised U(0, N). The 250 ms floor leaves the 10 s buckets unchanged | **Kept the 5 s minimum and documented it** in the wire contract (A3 note). Reason: a fleet-wide N < 5 s would otherwise undo #9145's spread, and W5c will send minutes, not seconds |
| 1c. Shared window for normal and abnormal closes | Agree. But the acceptance claim about attempt rate does not follow: admission limits accepts, and only in `enforce` mode | **Adopted.** The acceptance wording is corrected in A12. G1 is unchanged |
| 2. `localClose` | Agree, but "identical under generations" overstated it; `readFailedGen` narrows the race | **Adopted.** A3 now says "narrows, not closes" and accepts the residual on purpose |
| 3. 300 s stands | Agree, with narrower reasoning: mTLS renewal advertises up to 3,600 s, on a raw-HTTP path that discards the header | **Adopted.** A1, A2 and follow-up 6 are scoped to admission, overload and rate-limit answers that `Do` or the WS dial reads |
| 4. Early return without `DeadlineExceeded` | Agree; no non-test caller depends on it. Keep `withServerAnswer` for real expiry and later transport failures | **Already the design** (A8 Step 2) |
| 5a. Simulator cohort | The immediate-redial "pre-W09" cohort now represents pre-#9145 agents | **Adopted.** The cohort is the #9145 pacer. Pre-#9145 agents are documented as not modelled (A11) |
| 5b. #9245 | Its post-connect check does not give the original's atomic install-vs-`Stop` guarantee (`client.go:440`) | **Adopted.** `TestDialAfterStopIsDiscarded` and the locked re-check go back into Task 2 (A6) |
| 5c. Watchdog follow-up | Done by #9146 | **Adopted** (A12) |

### A14. Gates and must-not-ship (unchanged)

- **G1–G4 are unchanged** in substance. G1 can now run, because Task 12 is unblocked. G2's log reads are the existing lines `disconnected kind=… retryIn=…` and `connection failed … retryIn=…` (`client.go:484, 512`), plus the new `initial connect delayed`; the original's `reconnect scheduled cause=…` was never added. G2 (d) reads "`ws_first_reconnect_window_seconds: 0` shows the 1–5 s spread".
- **Must not ship in the W09 PR:** a `drain` sender (W5c, D4); a server-hinted reconnect window (follow-up 4); any watchdog edit (`cmd/breeze-watchdog`, `internal/watchdog`; D2); edits to `load-tests/agentsim/storms/storm-suite.json` (W06's); logic in `heartbeat.go` beyond call-site lines; infrastructure names (hosts, IPs, regions) anywhere.
- **One implementation PR**, body `Closes #8148`, title as in **PR** below.

### A15. Open decisions for Todd

None. Todd's four decisions of 2026-10-16 (A0) cover every owner-level choice. The quorum's disagreements were resolved on the merits (A13). The choices this amendment makes are recorded with their reasons: 300 s stands; `localClose` stays; key value `0` means 1–5 s; drain windows are widened to at least 5 s.

### A16. Follow-up added by this amendment

6. API guard test: every agent-route `Retry-After` upper bound × 1.3 ≤ 300 s (A2), in `apps/api/src/services/admission/agentRouteClasses.test.ts`. Also refresh the stale shipper line references in the `agentRouteClasses.ts:107` comment once Task 9 lands. This is a separate small API PR.

### A17. Self-review of the amendment

- **Every stale claim has evidence.** A1 gives file:line and a verdict for F1–F20, S4, the server ranges, the simulator and the docs, plus every original "today fails" claim. A6 maps each dropped test to the test that pins it on main.
- **Type consistency.** `reconnectBackoff.firstWindow` and `atStart` (Task 2) feed `afterDrainedDisconnect` and `drainHint` (Task 4). Those feed the `ReconnectPacer` facade (Task 12). `RetryableStatusError.RetryAt`, `RetryAtFrom` and `SetLoopRetryAfter` (Task 5) feed `loopDeferral` (Task 7), UniFi (Task 8) and the shipper (Task 9). `Config.FirstReconnectWindow` (Task 2) is fed by the config key (Task 10).
- **Numbers.** The window is 30 s, with 0–5 equal to #9145, the range 0–300, and a 300 s clamp. The start window is 10 s. The drain cap is 600 s and the hint lifetime N + 30 s. The `Retry-After` ceiling is 300 s everywhere; the original text's remaining 390 s mentions are all overridden by A2/A4/A12. Expected waits at r = 0.5: first window 15.5 s, #9145 spread 3 s, drain 120 s → 60 s, drain 0 → 2.5 s.
- **Scope.** Docs only in this PR. The implementation stays one PR. There is no API change, and follow-up 6 is a separate PR.

---

## Global Constraints

- Spec W1d, verbatim: "Agent: (1) add jitter to the **first** reconnect after an established socket drops; today it is immediate. (2) Honour an application-level `drain` message `{reconnectWithinMs}` sent before the close; a close code alone cannot carry a delay. Spread the reconnect uniformly over that window. (3) Honour `Retry-After` **at the loop level**, deferring the next cycle rather than only the retry. (4) Jitter startup and periodic requests. *This ships to customer machines, so full rigor applies.* Old agents still rely on W1c." Acceptance, verbatim: "10k simulated agents told 'reconnect within 120 s' arrive spread over 120 s ±10 %. An unannounced API kill produces no reconnect spike above the W1c admission rate."
- **Rigor: high.** The change ships in the agent binary to customer machines, and rollback is not a revert (see Rollout: agents never downgrade). Every task is red-first under `-race`; one independent review round on the implementation PR; the lab gates and the canary in **Rollout** are Todd's.
- **No API change in this wave.** Nothing on the server sends `drain` today (verified: no `type: 'drain'` in `apps/api/src`). W09 owns the wire contract (Design D4) and the agent side; the sender is W5c's. Pre-W09 agents skip an id-less unknown frame (`client.go` `readPump`, the `msg.ID == ""` branch), so the contract is safe to send to the whole fleet the day W5c lands. If a server-side change becomes necessary during implementation, it is a separate tiny PR, not part of this one.
- **Never shed or defer heartbeats.** The watchdog restarts the agent when `LastHeartbeat` (written only on HTTP 200) is older than 3 minutes (`config.go` `HeartbeatStaleThreshold`; W08 plan, "Agent side" table). Heartbeat cadence must never be later than today's under any server answer (Design D6, Task 7 test).
- **Command results are never deferred.** `POST /commands/:id/result` and the WS result path are exempt from every deferral in this plan.
- **Old servers.** An API without `drain` and without `Retry-After` must see exactly today's request pattern, except the bounded startup and first-reconnect jitter. Each task names its "no hint" test.
- **No hidden data loss.** A deferred send behaves like a failed send for the caller, **and** it is checked before any collector that advances a cursor or pops a pending queue (event logs, recovery keys, patch claims). Task 7 audits every `sendInventoryData` caller and records the classification in the PR.
- **No new files over ~500 lines; nothing new in `heartbeat.go`** beyond call-site lines (it is 8,165 lines). New logic lives in new files.
- **Fake clocks for every timing test. No `time.Sleep` in a new test.** Follow the `idleAfterFunc` / `installFakeIdleClock` pattern (`internal/backup/storagesession/provider.go:739`, `idle_fakeclock_test.go:34`): a package-level seam, swapped by a test helper that restores it in `t.Cleanup`. A test that swaps a package global must not call `t.Parallel()`. Randomness is injected the same way (`func() float64`), so spread tests are deterministic.
- **Go tests:** `cd agent && go test -race ./internal/<pkg>/...` for a package, `-run '<regex>'` for one test while red/green. Before the PR: `cd agent && go test -race ./...` and `go vet ./...`, plus the cross-compiles in Task 13. The host may be loaded: run packages one at a time with `-timeout 10m` rather than one big run.
- **Config escape hatch, not a feature flag.** Two agent config keys (Design D10) let an operator restore today's behaviour on a device without a new release. Defaults are the new behaviour. No server-side setting.
- **No internal infrastructure details** (hosts, IPs, regions, droplet names) in the plan, code, tests, PR or docs. Region names in Rollout are "the sleeping region" and "the other region".
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` (or the executing model). The implementation PR body includes `Closes #8148` and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

## Review Focus

1. **A path that makes the watchdog restart agents.** Expected: heartbeats bypass the deferral store entirely; a heartbeat `503` with `Retry-After: 300` leaves the next beat at the normal tick. Test: Task 7 `TestHeartbeatIgnoresLoopDeferral`.
2. **A tight reconnect loop.** Today an accepted socket that closes at once is redialled at once, forever (`client.go:428-484`: backoff only grows on a dial error). Expected: a socket that lived under 30 s is followed by the jittered, growing backoff, whatever the close reason, including a `drain` with `reconnectWithinMs: 0`. Test: Task 2 `TestShortLivedSocketsBackOff`, Task 4 `TestDrainZeroDoesNotDefeatBackoff`.
3. **Local reconnects that became slow.** `ForceReconnect()` (mTLS renewal ×2, helper-token rotation: `heartbeat.go:5843, 6114, 6394`) must redial with no added delay. Expected: the "local" reason is tied to the connection generation it closed, so it can never exempt a later remote drop. Test: Task 2 `TestForceReconnectIsImmediate`, `TestStaleForceReconnectDoesNotExemptNextDrop`.
4. **Stop during a long wait.** Expected: `Stop()` ends any reconnect wait at once, and no dial that started before `Stop` can install a connection after it. Test: Task 2 `TestStopDuringFirstReconnectWait`, `TestDialAfterStopIsDiscarded`.
5. **A `drain` that collapses into a burst.** If agents picked their reconnect time at receipt, a server that closes 60 s into a 120 s window would see half the fleet redial together. Expected: the uniform wait starts at the server's close. Test: Task 4 `TestDrainDelayStartsAtClose`.
6. **Hostile or broken hints.** Expected: `reconnectWithinMs` must be a present, non-negative integer; larger than 600,000 is clamped; anything else is ignored and the normal policy applies. `Retry-After` is clamped to 300 s before jitter, and the jittered result to 390 s. Test: Task 4 `TestDrainHintValidation`, Task 3 `TestRefusedDialRetryAfterBounds`, Task 5 `TestRetryAtBounds`.
7. **Silent loss from deferral.** Expected: a cursor-advancing or queue-popping collector is skipped **before** it collects when its route is deferred. Test: Task 7 `TestDeferredEventLogsDoNotCollect`, `TestDeferredRecoveryKeysStayParked`.
8. **Command results lost during a longer offline window.** With jittered reconnects a socket can stay down for up to 30 s (or the drain window). A result accepted into the in-memory `resultChan` while disconnected has already cleared the durable command journal (`OnResultHandedOff`), so a hard kill in that window loses it. Expected: while no socket is held, command results go straight to the durable outbox. Test: Task 6.

---

## Verified findings that shape this plan (as of 2026-10-12 — current evidence in Amendment A1)

Labels: **[V]** read in code at `origin/main` `dfb96cb50e` (or the W06 branch where named). **[I]** inferred. **[C]** claimed by the Codex review and checked as noted.

### WebSocket client (`agent/internal/websocket/client.go`, 1,348 lines)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F1 | `reconnectLoop` redials an accepted socket that closed **at once**, whatever the close code. Backoff (1 s → 60 s, ×2, ±30 %) grows **only** after a dial error and resets after a connection that lasted more than 30 s. A socket accepted and then closed within 30 s is redialled immediately and does not grow the backoff | `client.go:41-45` (constants), `:428-484` (loop) [V] | (1) of the spec, and a latent tight loop on accept-then-close. Both fixed by one policy (D2) |
| F2 | `connect()` discards the handshake response: `conn, _, err := dialer.Dial(wsURL, headers)`. gorilla returns the `*http.Response` on a non-101 answer (`ErrBadHandshake`) | `client.go:396` [V] | W08's pre-upgrade `503` + `Retry-After` never reaches the loop today (D1) |
| F3 | W08 patched `@hono/node-ws` to forward a digits-only `Retry-After` (1–4 digits) on a refused upgrade | `patches/@hono__node-ws@1.3.1.patch` [V] | The agent may read `Retry-After` from the refused handshake; values are integer seconds |
| F4 | `readPump` handles `ping`, `connected`, `error`, `ack` and `revocation_lease*` before `if msg.ID == "" { continue }`. An unknown id-less type is skipped silently | `client.go:525-567` [V] | Pre-W09 agents ignore `drain`. W09 must parse it **before** the skip (the #3001 trap the comments describe) |
| F5 | `ForceReconnect()` closes the socket without a close frame; callers are local events (mTLS renewal twice, helper-token rotation) | `client.go:370-372`; `heartbeat.go:5843, 6114, 6394` [V] | These must stay immediate (D3) |
| F6 | `Stop()` closes `done`, closes the socket and drains `resultChan` to the outbox. The loop selects on `done` during backoff, but `dialer.Dial` takes no context | `client.go:291-306, 396` [V] | Use `DialContext` with a context cancelled by `Stop` (Task 2) |
| F7 | `SendResult` enqueues to `resultChan` whenever the client is not stopped, connected or not; `OnResultHandedOff` (clears the on-disk in-flight journal, #8296) fires on that enqueue | `SendResult` `client.go:873-940`; `processCommand` calls the outbox only when `SendResult` errors, and calls `OnResultHandedOff` unconditionally afterwards (`:846-863`) [V] | Longer offline windows widen a hard-kill loss window (Review Focus 8; Task 6) **[C, checked]** |
| F8 | No time or randomness seam in the package: `time.After`, `time.Since` and the `math/rand/v2` global are called directly. Existing reconnect tests use real time (`client_reconnect_test.go:100-170`) | [V] | Task 1 adds `wsClock` and `wsRand`; the old tests keep working with the real clock |
| F9 | Heartbeat first beat is already jittered `U(0, interval)` and skipped after a self-update (`.update-restart` marker); the startup bundle `sendInventory`, `sendHardwareInventory`, `sendPatchInventory` and `runProcessSampler` fires together right after that first beat | `heartbeat.go:2038-2061, 2079-2089`; the gates `lastHardwareUpdate`/`lastPatchUpdate`/`lastInventoryUpdate` are already stamped right after the bundle (`:2113-2115`) [V] | Agents' phases are spread; the bundle burst per agent is not (D7) |

### HTTP retry (`agent/internal/httputil`)

| # | Finding | Evidence | Consequence |
|---|---|---|---|
| F10 | `Do` retries 429/500/502/503/504 and network errors (4 attempts). It honours `Retry-After` (seconds or HTTP-date, clamped to 300 s by `ParseRetryAfter`) with additive 0–30 % jitter, **clamped back to 300 s** after jitter (`applyPositiveJitter`) | `retry.go:45-148, 164-173`; `retryafter.go:13-57` [V] | The post-jitter clamp re-synchronises every agent that got 300 s (D1, D5) |
| F11 | When the `Retry-After` sleep outlasts the caller's context (every caller uses 15–30 s), `Do` returns `ctx.Err()`. The parsed value is a local and is lost. `RetryableStatusError{StatusCode, URL}` has no delay field, and nothing outside the package inspects it | `retry.go:94-97, 138-148`; callers `heartbeat.go:2505, 2699, 5015` [V] | "Loop level" needs a typed error that carries the delay, returned **before** sleeping into the deadline (D5) |
| F12 | `retry_jitter_test.go` asserts the jittered value never exceeds `retryAfterMaxCap` | `retry_jitter_test.go` [V] | Task 5 changes that assertion on purpose (390 s ceiling) and says so in the commit |

### Periodic senders (from a read-only map of `internal/heartbeat`, `internal/unifi`, `internal/logging`, `internal/monitoring`)

| # | Sender | Call | Today on `503` | Evidence |
|---|---|---|---|---|
| F13 | Inventory family (`sendInventoryData`): software, disks, network, changes, connections, config-state, warranty-info, eventlogs, security/status, security/recovery-keys, sessions, management/posture, hardware, hardware-health, time-status, workloads, patches/pending, patches/installed | `httputil.Do`, 30 s ctx | Error logged; caller's own failure path | `heartbeat.go:2474-2510` [V] |
| F14 | Event logs collect **before** the send and ignore the send's error | `collectors.Guard("eventLogs", h.eventLogCol.Collect)` then `sendInventoryData` | Events collected in a failed cycle are not re-sent **[C]**: the collect-then-ignore shape is [V] at `heartbeat.go:4124-4136`; whether `Collect` advances a persisted cursor is [I] | Gate before collect (Task 7) |
| F15 | Recovery keys pop `pendingRecoveryKeys` before the push, re-park on error and log ERROR | `heartbeat.go:4151-4166` [V] | Gate before the pop, so a deferral does not log a false key-loss ERROR |
| F16 | Process sample, reliability, boot-performance, monitoring results | `httputil.Do` at `heartbeat.go:2698, 4304, 4255, 2419` (15 s ctx for monitoring) [V] | Same deferral path |
| F17 | Heartbeat | `httputil.Do` at `heartbeat.go:5014`, 30 s ctx; 60 s ticker; a missed tick is dropped | Never shed by W08, but W08 D14 can answer it `503` + `Retry-After` 30–45 s on DB saturation | `heartbeat.go:2063, 5011`; `dbSaturationResponse.ts:6-41` [V] |
| F18 | UniFi collector: `GET /unifi-collectors` and `POST /unifi-telemetry` with raw `deps.HTTP.Do`, no retry, `Retry-After` ignored. Timer loop with an injectable `fetchSchedule` | `unifi/collector.go:224-235, 374-420, 427-440`; `collector_schedule.go:31-60` [V] | Both calls need the deferral (Task 8) |
| F19 | Log shipper: own loop of 3 attempts, `time.Sleep(Retry-After)` with **no** stop or context; the hint is lost after the last attempt | `logging/shipper.go:569-610` [V] | Cancellable sleep and a carried `notBefore` (Task 9). W08 sends 2–4 s for `/logs`, but D14 can send 30–45 s |
| F20 | Monitoring runs an immediate check on `Start`, then a fixed ticker | `monitoring/monitor.go:105, 132-136` [V] | First run jittered once per process, not on every config refresh (Task 10) |

### Server contract (W08, merged as #8456)

| # | Finding | Evidence |
|---|---|---|
| S1 | Route classes and `Retry-After` ranges: protected (never shed: heartbeat, commands, command result, eventlogs, …); standard 60–90 s; bulk 120–180 s; `/logs` 2–4 s; `unifi-collectors` 30–45 s; WS upgrade 5–120 s; DB saturation 30–45 s on **any** route | W08 plan "Per-route policy" and D14; `dbSaturationResponse.ts` [V] |
| S2 | WS upgrade bucket per instance: 10/s, burst 20, at most 8 setups at once, scaled down at higher levels (`[1, 0.5, 0.2, 0.05]`) | `services/admission/admissionConfig.ts:26-50` [V] |
| S3 | W08 wrote its `Retry-After` ranges as "semantics for W09 agents, which will honour them at loop level"; for current agents any value ≥ 30 s means one attempt per cycle | W08 plan D6 and `agentRouteClasses.ts` comments [V] |
| S4 | No server code sends `drain`. The `drain` hits in `apps/api/src` are the shutdown phase name and the tenant-offboarding channel, unrelated | `git grep` [V] |

### Rollout mechanics

| # | Finding | Evidence |
|---|---|---|
| R1 | Hosted sets `AGENT_AUTO_PROMOTE=false`. A deploy registers binaries in `agent_versions`; devices update only after `is_latest` is moved, per region, in that region's DB (the release skill's "Promote the agent fleet" step) | `.claude/skills/release/SKILL.md` "Promote the agent fleet" [V] |
| R2 | Per-org agent update policy `auto` / `staged` / `manual` plus maintenance window, and per-org **version pins** (#2124) honoured by the heartbeat upgrade offer | `routes/agents/agentUpdatePolicy.ts:1-60`; `routes/agents/heartbeat.ts:636-660` [V] **[C, checked]** |
| R3 | The server offers an upgrade only when the target is **newer**: `compareAgentVersions(target, current) > 0`. Moving `is_latest` back does not downgrade agents | `routes/agents/heartbeat.ts:960` [V] |
| R4 | Whether a pin may point **ahead** of `is_latest` (the canary shape Codex proposed) | [I] — Rollout step R-1 verifies it before relying on it |

### Not in scope, on purpose

- **The watchdog's own failover heartbeat** (`cmd/breeze-watchdog`, `watchdog/failover.go`). It runs only while the main agent is down. Unchanged.
- **Watchdog "overload liveness".** Repeated `503`s on heartbeats already risk a watchdog restart today (W08 D14). W09 does not make that worse (D6). A watchdog signal that tells "the server is overloaded" apart from "the agent is wedged" is follow-up 2.
- **Server-hinted reconnect windows** (a field in the `connected` frame). Rejected for W09 (D2). Follow-up 4 if W07's data shows a fixed 30 s window is wrong at M2.
- **Sending `drain`** on graceful API shutdown. W5c owns the sender (follow-up 1).

---

## Design decisions

The draft went to an independent Codex review (`gpt-6-astra`, reasoning `xhigh`, read-only) with the spec row, the W08 contract and the findings above. Verdict: "revise before implementation, especially D4–D6". Every revision is adopted below unless the row says otherwise.

| # | Question | Draft | Codex | Resolution |
|---|---|---|---|---|
| D1 | Refused WS upgrade | Read `Retry-After` from the handshake; next delay = max(jittered backoff, RA × (1 + U(0, 0.3))), capped 300 s | Keep max(); clamp the **parsed** value to 300 s, jitter, ceiling **390 s** — clamping after jitter re-synchronises every 300 s hint. Admission, not the window, limits accepts: 10k agents at 10 accepts/s need about 1,000 instance-seconds whatever the window | **Adopt.** The arithmetic goes in the plan because it is why the agent's own window stays small: the server's `Retry-After` paces the herd, the agent's jitter only takes the edge off the first second. Same 300/390 bounds for HTTP (D5). |
| D2 | First reconnect after a drop | U(0, 30 s) after a remote drop; backoff after | Keep 30 s. Apply to every remote close, normal codes included. A socket that lived < 30 s must also sleep and grow the backoff (1 → 60 s, ×2, ±30 %, reset after 30 s stable) | **Adopt.** One table: stable socket (> 30 s) dropped remotely → U(0, 30 s), backoff reset; short-lived socket → jittered backoff, then ×2. 30 s is below the 90 s presence lease, so an API restart does not flap a device offline for longer than the lease. A server-hinted window was considered and rejected for W09: it needs an API change, and D1's server pacing already bounds the accept rate. |
| D3 | Local reconnects | Flag set by `ForceReconnect`, consumed by the loop | Tie the reason to a **connection generation**; a global flag set while no socket is held would exempt the next remote drop. `Stop` must cancel waits and the dial | **Adopt.** `ForceReconnect` records `localCloseGen = currentGen` only when it actually closed a socket; the loop treats the close as local only if the generations match. `connect()` uses `DialContext` with a client context cancelled in `Stop`; a dial that returns after `Stop` closes its socket and returns. |
| D4 | `drain` semantics | Target T = receipt + U(0, N); redial at max(close, T); no self-close | Receipt-based targets collapse when the close comes late in the window. Start U(0, N) **at the close**. Keep the 600,000 ms cap and the N + 30 s lifetime. First valid hint per socket wins. Require a present, non-negative integer. N = 0 must not defeat the short-lived backoff | **Adopt.** Wire shape (owned by W09, implemented by W5c): `{"type":"drain","reconnectWithinMs":<int>}`, optional `"reason":"<string>"` (logged, never parsed), sent **before** the server closes the socket. Agent: validate, clamp to 600,000, store on the current socket with expiry receipt + N + 30 s; never close the socket itself (W5c closes remote sessions last); on the next remote close of that socket, delay = U(0, N) if the socket was stable, else max(U(0, N), short-lived backoff). Expired or absent hint → D2. Hint is cleared with the socket. |
| D5 | Loop-level `Retry-After` | Typed error with the delay; return early instead of sleeping into the deadline; per-route deferral; `ErrDeferred` reuses each caller's failure path | Carry an **absolute `RetryAt`**, jittered once. Key by origin + method + route. A skip never extends the deferral and is not a connectivity failure. "Failure paths retain state" is false for event logs and monitoring: gate **before** collection. Cover both UniFi calls. The log shipper needs cancellable, carried pacing too | **Adopt all.** Key = `serverOrigin + " " + method + " " + routeTemplate` (route without the agent id), so a backup-server promotion starts clean. `RetryAt = now + clamp(RA, 300 s) × (1 + U(0, 0.3))`, at most now + 390 s. Monitoring results are point-in-time: a deferred cycle's results are dropped, as a shed would drop them; the PR states this. |
| D6 | Heartbeat | Cap heartbeat deferral at 60 s | Tick quantisation breaks the arithmetic: a failure at t = 70 s with 58.5 s deferral skips t = 120 and sends at t = 180, at the stale threshold. Repeated 503s defeat any cap. Keep 180 s; add a separate overload liveness for the watchdog | **Revised further: heartbeats take no loop-level deferral at all.** Under W08 the only heartbeat `503` is D14's 30–45 s (× 1.3 ≤ 58.5 s), which never reaches the next 60 s tick, so a deferral would change nothing on the current server and could only make cadence worse against another one. The watchdog overload signal is real but pre-existing and out of scope (follow-up 2). |
| D7 | Startup spread | WS first dial U(0, 10 s), skipped after self-update; monitoring first run U(0, min(interval, 60 s)); startup bundle U(0, 2 min) each | WS U(0, 10 s) **even after updates** (the heartbeat already reports the new version at once). Monitor first run U(0, min(interval, 60 s)); startup bulk tasks U(0, 120 s) each. Keep the ±10 % helpers. Avoid double sends and repeated postponement on config refresh | **Adopt.** The process sampler already waits one full interval before its first sample (F9), so it is unchanged. The startup gates (`lastInventoryUpdate`, `lastHardwareUpdate`, `lastPatchUpdate`) are already stamped right after the bundle is launched (`heartbeat.go:2113-2115`); the refactor must keep that, so the first tick cannot duplicate a delayed send. The startup reliability post (`go h.sendReliabilityMetrics`) is left unstaggered on purpose: it fires only when 24 h have passed since the last persisted post, so it is not a per-restart burst. Monitoring jitters only the first `Start` per process. |
| D8 | Acceptance proof | Pure picker test with 10k virtual agents; simulator mirror; 400-agent lab; 10k on fixed hardware is a Todd gate | Keep the numbers. The picker test proves only sampling: also drive the real client through delayed closes, duplicate and expired hints, refusals, repeated short connections, cancellation, prolonged shedding and restart. Measure attempts separately from admissions, allowing burst 20 | **Adopt.** Task 4 drives the real `Client` against an `httptest` WS server on the fake clock for each of those cases. The simulator imports the real policy (Task 12) rather than mirroring it, and its report already separates connects from failures (W06 D5). |
| D9 | Rollout | No ring mechanism beyond regional promote and org policy | No server change, agreed. Org version pins (#2124) can carry a canary: one pinned canary org, 24 h, then regional promotion. `staged` is not a percentage. Rehearse recovery from an unreachable agent | **Adopt with a check.** Whether a pin may point ahead of `is_latest` is [I] (R4); Rollout R-1 verifies it on a lab stack first and names the fallback. Recovery rehearsal is R-0's last step. |
| D10 | Escape hatch | — (added after the review: agents never downgrade, R3) | — | Two agent config keys, read at start: `ws_first_reconnect_window_seconds` (default 30; 0 restores today's immediate redial after a stable socket; max 300) and `loop_retry_after` (default `true`; `false` restores today's per-request-only handling, including sleeping into the deadline). A Breeze script run can set them fleet-wide without a release. `drain` handling and the short-lived backoff (a bug fix) have no switch. |
| D11 | Codex blocker: results during longer offline windows | — | Persist disconnected/buffered results before journal handoff; test abrupt termination | **Adopt (Task 6).** Only the **command-result** path changes: `processCommand` checks `IsConnected()` before `SendResult` and, with no socket, hands the result to the outbox before `OnResultHandedOff`. `SendResult` itself is unchanged, because three non-durable callers (tunnel-closed, clipboard summary, desktop-disconnect notices) rely on it buffering while disconnected. The outbox already flushes on `OnConnected`. |

### Reconnect policy table (superseded by Amendment A3)

| Last event | Next delay | Backoff after |
|---|---|---|
| Process start (first dial) | U(0, 10 s) | 1 s |
| Dial failed, no `Retry-After` | jitter(backoff, ±30 %) | × 2, max 60 s |
| Dial refused with `Retry-After: RA` | max(jitter(backoff, ±30 %), min(RA, 300 s) × (1 + U(0, 0.3))), ≤ 390 s | × 2, max 60 s |
| Local close (`ForceReconnect`, same generation) | 0 | unchanged |
| Remote close, socket lived > 30 s, no live drain hint | U(0, W), W = `ws_first_reconnect_window_seconds` (30 s) | reset to 1 s |
| Remote close, socket lived > 30 s, live drain hint N | U(0, N) | reset to 1 s |
| Remote close, socket lived ≤ 30 s | max(jitter(backoff, ±30 %), U(0, N) if a live hint) | × 2, max 60 s |
| `Stop()` | loop exits; no further dial | — |

"Remote close" is any read error or close frame on a socket the agent did not close itself: server close codes (including 4008 pong timeout), read deadline, TCP reset.

---

## File structure

| File | Purpose |
|---|---|
| Create `agent/internal/websocket/clock.go` | `wsClock` interface (`Now`, `After`), `realClock`, `wsRand func() float64` |
| Create `agent/internal/websocket/fakeclock_test.go` | `installFakeWSClock(t)`, `installWSRand(t, seq...)` helpers |
| Create `agent/internal/websocket/reconnect_policy.go` (+ `reconnect_policy_test.go`) | Pure `ReconnectPolicy.Next(event, state) (delay, state)`; exported for the simulator |
| Modify `agent/internal/websocket/client.go` | `reconnectLoop` uses the policy and the clock; `connect` uses `DialContext` and returns `*DialRefusedError`; connection generation; `readPump` routes `drain` |
| Create `agent/internal/websocket/drain.go` (+ `drain_test.go`) | Parse and validate the hint; per-socket hint state |
| Create `agent/internal/websocket/client_reconnect_policy_test.go` | Real `Client` + `httptest` server + fake clock: the D8 scenarios |
| Modify `agent/internal/websocket/client.go` `processCommand` (+ `result_disconnected_test.go`) | Disconnected command results go to the outbox (D11) |
| Modify `agent/internal/httputil/retry.go`, `retryafter.go`; create `clock.go` (+ tests) | `RetryAt` on `RetryableStatusError`; early return; 300/390 bounds; seams |
| Create `agent/internal/heartbeat/loop_deferral.go` (+ test) | Per-route deferral store, `ErrDeferred`, `h.loopReady(method, route)` |
| Modify `agent/internal/heartbeat/heartbeat.go` (call sites only) | Gate each sender; record `RetryAt`; startup bundle via the stagger helper |
| Create `agent/internal/heartbeat/startup_stagger.go` (+ test) | Staggered startup bundle |
| Modify `agent/internal/unifi/collector.go`, `collector_schedule.go` (+ tests) | Honour `Retry-After` on fetch and telemetry |
| Modify `agent/internal/logging/shipper.go`, `retryafter.go` (+ tests) | Cancellable sleep; carried `notBefore` |
| Modify `agent/internal/monitoring/monitor.go` (+ test) | First-run jitter, once per process |
| Modify `agent/internal/config/config.go` (+ test) | D10 keys with defaults and bounds |
| Modify `agent/internal/agentapp/main.go` | Pass D10 values into the WS client and heartbeat |
| Modify `agent/tools/agentsim/sim/ws.go`, `sim/agent.go`, `sim/storm.go` (+ tests); create `load-tests/agentsim/storms/drain-120.json` | **After #8587 merges:** use the real policy; `drain-sockets` internal action; `--pre-w09-fraction` cohort |
| Modify `apps/docs/src/content/docs/deploy/upgrades.mdx`; `docs/release-notes/next-release-draft.md` | Operator-visible behaviour and the D10 keys |

### File ownership (keeps W09 disjoint from W05, W06 and W07)

| Wave | Owns | Overlap with W09 |
|---|---|---|
| **W09 (this)** | `agent/**` except `agent/tools/agentsim/**` until #8587 merges; then also `agent/tools/agentsim/sim/{ws,agent,storm}.go` and their tests, one new `load-tests/agentsim/storms/drain-120.json`, a `## Reconnect and drain (W09)` section in `load-tests/agentsim/README.md`; the two docs files above | — |
| W06 (#8145, PR #8587 open) | `agent/tools/agentsim/**`, `load-tests/agentsim/**` | **Sequenced, not concurrent.** Tasks 1–11 and 13 never touch `agent/tools/agentsim/**`. Task 12 starts only after #8587 merges and rebases onto it. `storm-suite.json` is W06's file: W09 adds a new scenario file and does not edit the suite |
| W05 (#8144, cluster cache) | `apps/api/src/services/{hotPathCache,clusterCache*,agentOrgSettingsCache,manifestSigning}.ts`, `index.ts` boot lines, `apps/docs/.../monitoring/stack.mdx` | None. W09 touches no `apps/api/**` and not `stack.mdx` |
| W07 (#8146, KPI dashboard + perf gate) | `.github/workflows/perf*.yml`, dashboards, `routes/metrics.ts`, perf docs | None. W07 reads the agentsim report schema; W09's simulator changes are additive (a new action and a new cohort counter, `omitempty`) |
| W08 (merged) | — | W09 consumes its contract; no edits |
| Shared | `load-tests/agentsim/README.md`, `docs/release-notes/next-release-draft.md` | Each wave appends its own section; whoever merges second rebases |

---

## Tasks

Every task: write the test, run it, **see it fail for the stated reason**, implement, run it green, run the package under `-race`, commit. Test names below are the contract; bodies may grow.

### Task 1: Clock and randomness seams in `internal/websocket` — amended: keep, smaller (A5)

**Files:** create `agent/internal/websocket/clock.go`, `agent/internal/websocket/fakeclock_test.go`, `agent/internal/websocket/clock_test.go`.

- [ ] **Step 1: Red.** In `clock_test.go`:

```go
func TestFakeWSClockFiresOnlyOnAdvance(t *testing.T) {
	clk := installFakeWSClock(t)
	ch := wsClock.After(30 * time.Second)
	clk.WaitForWaiters(t, 1)
	clk.Advance(29 * time.Second)
	select {
	case <-ch:
		t.Fatal("fired before its deadline")
	default:
	}
	clk.Advance(time.Second)
	select {
	case <-ch:
	default:
		t.Fatal("did not fire at its deadline")
	}
}
```

Run `cd agent && go test -race -run TestFakeWSClock ./internal/websocket/` → fails to build (`wsClock` undefined).

- [ ] **Step 2: Implement.** `clock.go`: `type clock interface { Now() time.Time; After(d time.Duration) <-chan time.Time }`; `type realClock struct{}`; `var wsClock clock = realClock{}`; `var wsRand = rand.Float64`. `fakeclock_test.go`: `fakeWSClock` with a mutex, a virtual `now`, a slice of `{deadline, ch}` waiters, `Advance(d)` (fires every waiter whose deadline ≤ now, in deadline order, by a non-blocking send on a 1-buffered channel), and `WaitForWaiters(t, n)` that blocks on a `sync.Cond` until n waiters are registered, failing after a 5 s **real** deadline (the only real-time bound, a hang guard). `installFakeWSClock(t)` swaps `wsClock` and restores it in `t.Cleanup`. `installWSRand(t, v float64)` installs a constant `func() float64 { return v }` (a constant, not a sequence, so tests do not depend on how many draws `Next` makes, and nothing calls `t.Fatal` off the test goroutine). The restore in `t.Cleanup` runs only after the test has stopped the client **and waited for `Start` to return** (helper `startClient(t, c) (stop func())` returns a stop that calls `c.Stop()` and then waits on `Start`'s return), so `-race` sees no read of a global during its restore. Comment on both helpers: "mutates a package global — tests that use it must not call t.Parallel()".
- [ ] **Step 3:** `go test -race -run TestFakeWSClock ./internal/websocket/` green; `go test -race ./internal/websocket/...` green (no behaviour change yet).
- [ ] **Step 4: Commit** — `test(agent): fake clock and rand seams for the websocket client (W09, #8148)`

### Task 2: Reconnect policy and the loop that uses it — amended: REWRITTEN, run A6 instead

**Files:** create `agent/internal/websocket/reconnect_policy.go`, `reconnect_policy_test.go`, `client_reconnect_policy_test.go`; modify `client.go`.

- [ ] **Step 1: Red — pure policy.** `reconnect_policy_test.go`, table-driven over the **Reconnect policy table** above. The policy takes its randomness as an argument, so no seam is needed:

```go
func TestReconnectPolicyTable(t *testing.T) {
	p := ReconnectPolicy{FirstWindow: 30 * time.Second}
	cases := []struct {
		name      string
		ev        ReconnectEvent
		st        BackoffState
		rnd       float64
		wantDelay time.Duration
		wantNext  time.Duration
	}{
		{"start", ReconnectEvent{Kind: EventStart}, BackoffState{Backoff: time.Second}, 0.5, 5 * time.Second, time.Second},
		{"stable remote drop", ReconnectEvent{Kind: EventRemoteClose, Lived: 2 * time.Minute}, BackoffState{Backoff: 8 * time.Second}, 0.5, 15 * time.Second, time.Second},
		{"short-lived remote drop grows", ReconnectEvent{Kind: EventRemoteClose, Lived: 2 * time.Second}, BackoffState{Backoff: 4 * time.Second}, 0.5, 4 * time.Second, 8 * time.Second},
		{"local close immediate", ReconnectEvent{Kind: EventLocalClose}, BackoffState{Backoff: 4 * time.Second}, 0.9, 0, 4 * time.Second},
		{"window zero restores immediate", ReconnectEvent{Kind: EventRemoteClose, Lived: time.Hour}, BackoffState{Backoff: time.Second}, 0.9, 0, time.Second},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			pp := p
			if tc.name == "window zero restores immediate" {
				pp.FirstWindow = 0
			}
			d, next := pp.Next(tc.ev, tc.st, func() float64 { return tc.rnd })
			if d != tc.wantDelay || next.Backoff != tc.wantNext {
				t.Fatalf("Next = (%v, %v), want (%v, %v)", d, next.Backoff, tc.wantDelay, tc.wantNext)
			}
		})
	}
}
```

(`rnd = 0.5` makes the ±30 % jitter term zero: `backoff × (1 + 0.3 × (2·0.5 − 1))`.) Add `TestReconnectPolicyBackoffCapsAt60s` and `TestReconnectPolicyNeverNegative` (rnd 0 and 0.999… across every event kind). Run → build failure.

- [ ] **Step 2: Red — the real client on the fake clock.** `client_reconnect_policy_test.go`, each test with `installFakeWSClock(t)`, `installWSRand`, and an `httptest` WS server from `helpers_test.go`. Unless a test is about the start row, the client is built with `StartWindow: 0` (a `newTestClient` option) so no start wait is registered first. Sync points, so no test races the loop: `connStart` is stamped inside `connect()` when the conn is installed, and the test waits on a test hook `c.testHooks.connected` (a channel fed after install) before advancing the clock; drain tests wait on `c.testHooks.drainStored` before advancing.
  - `TestWSStartDialJittered`: with the default `StartWindow` (10 s) and rand 0.5, `Start()` registers a 5 s waiter before the first dial, also when the update marker is present. Plus `TestStopDuringStartWait`.
  - `TestStableRemoteDropWaitsFirstWindow`: server accepts, the test waits on `connected`, advances the fake clock 31 s (the loop reads `Lived` from `wsClock.Now()`), server closes; assert no second dial until the clock is advanced by the drawn delay (rand 0.5 → 15 s), then exactly one dial. **Today this fails:** the second dial happens at once.
  - `TestShortLivedSocketsBackOff`: server accepts and closes at once, five times; assert the waits registered on the clock are 1 s, 2 s, 4 s, 8 s, 16 s (rand 0.5). **Today:** five immediate redials.
  - `TestForceReconnectIsImmediate`: stable socket, `c.ForceReconnect()`; wait for the second dial on the server, then assert no clock waiter was registered between the two dials.
  - `TestStaleForceReconnectDoesNotExemptNextDrop`: call `ForceReconnect()` while disconnected (during a backoff wait), let the dial succeed, advance 31 s, server closes; assert the first-window wait applies.
  - `TestForceReconnectAfterRemoteDeathIsRemote`: the server closes the socket and, before the loop handles the read error, the test calls `ForceReconnect()`; the close is treated as remote (first-window wait).
  - `TestLivedExactly30sIsShortLived`: a socket that lived exactly 30 s takes the short-lived row (the existing code uses `>`).
  - `TestStopDuringFirstReconnectWait`: stable drop, loop parked on a 15 s waiter; `c.Stop()`; `Start` returns within the hang guard and no dial is attempted.
  - `TestDialAfterStopIsDiscarded`: a test hook `c.testHooks.beforeInstall` (called between a successful dial and the install) blocks; the test calls `Stop()`, then releases the hook; assert `c.IsConnected()` stays false and the server sees the connection closed. This exercises the install-vs-`Stop` race, which `DialContext` cancellation alone does not.
  - `TestNoHintServerKeepsBackoffShape`: server refuses with a bare `503` (no `Retry-After`); waits are 1, 2, 4 … 60, 60 s.
  - Existing real-clock tests (`TestReconnectLoop_ReconnectsAfterDisconnect`, `TestReconnectLoop_StopsDuringBackoff`, `client_pump_test.go:28`) build their client through `newTestClient`, which now sets `StartWindow: 0`, so the 10 s start jitter cannot flake them.

Run `go test -race -run 'TestStableRemoteDrop|TestShortLived|TestForceReconnectIsImmediate|TestStaleForceReconnect|TestStopDuring|TestDialAfterStop|TestNoHintServer' ./internal/websocket/` → fails (behaviour) after the policy compiles.

- [ ] **Step 3: Implement.** `reconnect_policy.go`: `ReconnectEventKind` (`EventStart`, `EventDialFailed`, `EventLocalClose`, `EventRemoteClose`), `ReconnectEvent{Kind, Lived, RetryAfter time.Duration, DrainWithin time.Duration, HasDrain bool}`, `BackoffState{Backoff}`, `ReconnectPolicy{FirstWindow, StartWindow time.Duration}` with defaults `30 s` and `10 s`, constants `stableAfter = 30 s`, `retryAfterParsedCap = 300 s`, `retryAfterCeiling = 390 s`, `maxDrainWithin = 600 s`, and `Next(ev, st, rnd) (time.Duration, BackoffState)` — no I/O, no globals. `client.go`:
  - Add `gen uint64` (incremented on each successful `connect`) and `localCloseGen uint64` under `connMu`. `ForceReconnect` sets `localCloseGen = gen` **only if** `c.conn != nil` and the read pump has not already seen a read error on that generation (a `readFailedGen` field set by `readPump` on exit).
  - Add `ctx, cancel` created in `New`; `Stop` calls `cancel()` before closing `done`. `connect` uses `dialer.DialContext(c.ctx, …)`; it installs the conn under `connMu` **after re-checking `done`** in the same critical section, and closes the new conn and returns `context.Canceled` if the client stopped. `connStart` is stamped there.
  - `reconnectLoop`: compute the event for the iteration (start, dial failure, local close iff `localCloseGen == gen` of the connection that ended, else remote close with `Lived = wsClock.Now() − connStart`), call `policy.Next(ev, st, wsRand)`, wait on `wsClock.After(delay)` or `done` (skip the wait when delay is 0). Log one line per scheduled reconnect: `log.Info("reconnect scheduled", "cause", ev.Kind, "delay", delay, "lived", ev.Lived)`.
  - Keep the constants `initialBackoff`, `maxBackoff`, `backoffFactor`, `jitterFactor` (`TestConstants` and `TestBackoff*` in `client_connect_test.go` read them).
- [ ] **Step 4:** the Step 1 and Step 2 tests green; `go test -race ./internal/websocket/...` green, including the existing real-clock tests (`TestReconnectLoop_ReconnectsAfterDisconnect` dials, is closed at once and expects a second dial within 10 s: with `StartWindow: 0` the only wait is the 1 s short-lived backoff; if it still fails, move the test to the fake clock rather than widening its timeout).
- [ ] **Step 5: Commit** — `feat(agent): jittered first reconnect and short-lived-socket backoff in the WS loop (W09, #8148)`

### Task 3: Honour `Retry-After` on a refused WS upgrade (D1) — amended: DROPPED, delivered by #9145

**Files:** modify `agent/internal/websocket/client.go`; extend `client_reconnect_policy_test.go`, `reconnect_policy_test.go`.

- [ ] **Step 1: Red.**
  - `TestRefusedDialHonoursRetryAfter`: the server answers the upgrade with `503` and `Retry-After: 120` (a plain `http.HandlerFunc`, no upgrade); with rand 0.5 for both draws, assert the registered wait is max(1 s, 120 s × 1.15) = 138 s.
  - `TestRefusedDialRetryAfterBounds` (pure): RA 299 s, rnd 0.999 → ≤ 390 s; RA 10,000 s → parsed to 300 s, then × (1 + 0.3·rnd); RA `abc` or `-5` → ignored, plain backoff. Uses `httputil.ParseRetryAfter` for parsing so the two paths agree.
  - `TestRefusedDialRetryAfterHTTPDate`: `Retry-After` as an HTTP-date 90 s after the fake clock's `now` (the fake epoch is a realistic date, e.g. 2026-10-12T00:00:00Z) → 90 s × 1.15; a past date → plain backoff.
  - `TestRefusedDialNon503`: `401`, `403` and `429` refusals carrying `Retry-After: 60` → the hint is honoured for `429` and `503` only; `401`/`403` keep the plain backoff (auth failures are not overload).
  Run → the first test fails (the loop waits 1 s).
- [ ] **Step 2: Implement.** In `connect`, keep the response: `conn, resp, err := dialer.DialContext(…)`. On error with `resp != nil` and status `429` or `503`: read `httputil.ParseRetryAfter(resp.Header, wsClock.Now())`; close `resp.Body` if non-nil; and return `&DialRefusedError{Status: resp.StatusCode, RetryAfter: ra, Err: err}`. The loop maps it to `EventDialFailed{RetryAfter: ra}`. Log the status and the hint at Warn once per refusal.
- [ ] **Step 3:** green; package green under `-race`.
- [ ] **Step 4: Commit** — `feat(agent): honour Retry-After on a refused WebSocket upgrade (W09, #8148)`

### Task 4: The `drain` message (spec item 2) — amended: plumbing rewritten (A7)

**Files:** create `agent/internal/websocket/drain.go`, `drain_test.go`; modify `client.go` (`readPump`, loop); extend `client_reconnect_policy_test.go`, `reconnect_policy_test.go`.

- [ ] **Step 1: Red — parsing.** `drain_test.go`:

```go
func TestDrainHintValidation(t *testing.T) {
	cases := []struct {
		raw    string
		ok     bool
		within time.Duration
	}{
		{`{"type":"drain","reconnectWithinMs":120000}`, true, 120 * time.Second},
		{`{"type":"drain","reconnectWithinMs":0}`, true, 0},
		{`{"type":"drain","reconnectWithinMs":900000}`, true, 600 * time.Second},
		{`{"type":"drain","reconnectWithinMs":-1}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":1.5}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":"120000"}`, false, 0},
		{`{"type":"drain"}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":null}`, false, 0},
		{`{"type":"drain","reconnectWithinMs":120000,"reason":"rolling-deploy"}`, true, 120 * time.Second},
	}
	for _, tc := range cases {
		within, ok := parseDrainHint([]byte(tc.raw))
		if ok != tc.ok || within != tc.within {
			t.Errorf("parseDrainHint(%s) = (%v, %v), want (%v, %v)", tc.raw, within, ok, tc.within, tc.ok)
		}
	}
}
```

Decode `reconnectWithinMs` as `json.Number` with `UseNumber`, accept only an integer that `strconv.ParseInt` takes, reject a float form.

- [ ] **Step 2: Red — the 10k spread (spec acceptance, pure).**

```go
func TestDrainSpread10kAgents(t *testing.T) {
	r := rand.New(rand.NewPCG(8148, 9))
	p := ReconnectPolicy{FirstWindow: 30 * time.Second}
	const agents, window = 10000, 120 * time.Second
	var buckets [12]int
	for i := 0; i < agents; i++ {
		d, _ := p.Next(ReconnectEvent{Kind: EventRemoteClose, Lived: time.Hour, HasDrain: true, DrainWithin: window},
			BackoffState{Backoff: time.Second}, r.Float64)
		if d < 0 || d > window {
			t.Fatalf("agent %d delay %v outside [0, %v]", i, d, window)
		}
		b := int(d / (10 * time.Second))
		if b == 12 {
			b = 11
		}
		buckets[b]++
	}
	mean := float64(agents) / 12
	for i, n := range buckets {
		if float64(n) < mean*0.9 || float64(n) > mean*1.1 {
			t.Fatalf("bucket %d has %d arrivals, want %.0f ±10%%: %v", i, n, mean, buckets)
		}
	}
	if maxDelay < window*95/100 {
		t.Fatalf("latest arrival %v: the window shrank (want ≥ %v)", maxDelay, window*95/100)
	}
}
```

(Track `maxDelay` in the loop.) The seed is fixed, so the test is deterministic. The ±10 % band is the spec's acceptance wording; each 10 s bucket expects 833 with a standard deviation near 28, so the band is about 3σ. If a later change to how the policy consumes randomness trips it, do not swap seeds until it passes: first run the test body over 50 seeds and check the failure rate is near the expected ~3 %; only then change the seed, and record that run in the commit.

- [ ] **Step 3: Red — the real client (D8 scenarios), fake clock, `httptest` server that writes the frame then closes when the test says:**
  - `TestDrainDelayStartsAtClose`: drain 120 s at t = 0; the clock advances 60 s; server closes; rand 0.5 → the registered wait is 60 s **from the close**, not 0.
  - `TestDrainThenImmediateClose`: drain 120 s and close at once (the SIGTERM shape) on a stable socket; rand 0.25 → wait 30 s.
  - `TestDrainExpires`: drain 10 s; the clock advances 41 s (10 + 30 + 1); server closes; the first-window policy applies (rand 0.5 → 15 s), not U(0, 10 s).
  - `TestDuplicateDrainFirstWins`: drain 120 s then drain 10 s on the same socket; close; rand 0.5 → 60 s.
  - `TestDrainHintClearedOnNewSocket`: drain on socket 1, server closes, redial; socket 2 lives 31 s and is closed without a drain; the first-window policy applies.
  - `TestDrainZeroDoesNotDefeatBackoff`: the server sends drain 0 and closes at once, five times on fresh sockets; waits are 1, 2, 4, 8, 16 s (the short-lived row).
  - `TestDrainNeverClosesTheSocketItself` and `TestDrainNotTreatedAsCommand` are **regression guards**, not red-first (both pass today): the socket stays open after a drain and `cmdHandler` is never called for it.
  - `TestDrainAfterCloseDetectedIsIgnored`: a hint processed after the loop has already handled the close does not affect the next wait.
  - `TestRefusalAfterDrainUsesRetryAfter`: drain 120 s, close, U(0, N) wait, then the redial is refused with `Retry-After: 60` → the next wait is 60 × (1 + 0.3·rnd).
  Run → fail (the frame is skipped as id-less; the loop ignores it).
- [ ] **Step 4: Implement.** `drain.go`: `parseDrainHint(raw []byte) (time.Duration, bool)`; `type drainHint struct{ within time.Duration; expires time.Time }`. `client.go`: `readPump` handles `msg.Type == "drain"` **before** the id-less skip and stores the hint on the client under `connMu`, tagged with the current `gen`, only if no hint exists for that `gen`; log Info `drain hint received` with `withinMs` and `reason` (reason truncated to 64 bytes). The loop reads and clears the hint when the connection ends: a hint for the ending `gen` that has not expired sets `HasDrain`/`DrainWithin`.
- [ ] **Step 5:** green; package green under `-race`.
- [ ] **Step 6: Commit** — `feat(agent): honour the server drain hint and spread reconnects over its window (W09, #8148)`

### Task 5: `httputil.Do` keeps the server's delay (D5 part 1) — amended: REWRITTEN, run A8 instead

**Files:** create `agent/internal/httputil/clock.go`; modify `retry.go`, `retryafter.go`; add `retry_loop_test.go`; update `retry_jitter_test.go`.

- [ ] **Step 1: Red.** `retry_loop_test.go` with an `installFakeRetryClock(t)` helper (same shape as Task 1) and an `httptest` server:
  - `TestDoReturnsRetryAtWhenHintOutlivesContext`: server answers `503`, `Retry-After: 120`; ctx deadline now + 30 s; rand 0.5. Assert `Do` returns after **one** request, without waiting on the clock, with `errors.As(err, &rse)`, `rse.StatusCode == 503`, and `rse.RetryAt == now + 138 s`.
  - `TestDoStillRetriesShortHints`: `Retry-After: 2`, 30 s ctx; the server answers 200 on the second request; `Do` returns the 200 after the clock is advanced 2 s × (1 + 0.3·rnd).
  - `TestRetryAtBounds`: RA 300 s and rnd 0.999 → `RetryAt ≤ now + 390 s`; HTTP-date 1 h ahead → parsed to 300 s first.
  - `TestDoWithoutHintUnchanged`: `503` with no header, 30 s ctx → 4 attempts with exponential sleeps on the fake clock, final error is `*RetryableStatusError` with zero `RetryAt`.
  - `TestDoLoopRetryAfterDisabled`: with `httputil.SetLoopRetryAfter(false)` (D10) and a **cancellable** context, the first test's server leads to today's behaviour: `Do` parks on the fake `afterFn`; the test waits for the waiter, cancels the context, and asserts `ctx.Err()` is returned (no real 30 s wait).
  - `TestRetryAtHTTPDateForms`: a date 90 s ahead → 90 s × (1 + 0.3·rnd); a past date → no `RetryAt`.
  Run → fails (`RetryAt` undefined; `Do` sleeps into the deadline).
- [ ] **Step 2: Implement.** `clock.go`: `nowFn`, `afterFn`, `randFloat` package vars. `retryafter.go`: rename the cap to `retryAfterParsedCap` (300 s), add `retryAfterCeiling` (390 s). `applyPositiveJitter` clamps to the ceiling. `RetryableStatusError` gains `RetryAt time.Time` (zero when no hint). In `Do`, after a retryable status with a hint: compute `wait := applyPositiveJitter(ra, cfg.JitterFrac)` and `retryAt := nowFn().Add(wait)` once; if the context has a deadline and `time.Until(deadline) < wait` (remaining real time against the wait, so the fake `nowFn` and the real context clock are never compared), or this was the last attempt, return `&RetryableStatusError{StatusCode, URL, RetryAt: retryAt}` at once; otherwise sleep until `retryAt` on `afterFn`. Add `func RetryAtFrom(err error) (time.Time, bool)`. Gate the early return on a package-level `loopRetryAfter atomic.Bool` (default true) with `SetLoopRetryAfter(bool)`.
- [ ] **Step 3:** update `retry_jitter_test.go:70-72`: it references `retryAfterMaxCap`, which this task renames, and asserts the 300 s clamp; rename it to `retryAfterCeiling` and assert 390 s, with a comment pointing at D1 (clamping after jitter re-synchronises the fleet). `logging/retryafter.go:12` keeps its own copy of the cap (Task 9). Sweep the other `httputil.Do` callers outside the heartbeat's periodic senders, `discovery/adjacency_transport.go:265`, `heartbeat/handlers_elevation.go:44` and `heartbeat/pam_reconciliation.go:135`: when a `Retry-After` outlasts their context they now get `*RetryableStatusError` instead of `ctx.Err()`. Confirm none branches on `context.DeadlineExceeded` for that case, and list them in the PR. `go test -race ./internal/httputil/... ./internal/discovery/...` green.
- [ ] **Step 4: Commit** — `feat(agent): return the server's Retry-After as an absolute RetryAt instead of sleeping into the deadline (W09, #8148)`

### Task 6: Results sent while disconnected go to the durable outbox (D11) — amended: keep

**Files:** modify `agent/internal/websocket/client.go` (`SendResult`); create `agent/internal/websocket/result_disconnected_test.go`.

- [ ] **Step 1: Red.** `processCommand` (`client.go:842-863`) calls `handleResultWriteFailure` (the outbox) only when `SendResult` errors, and then always calls `OnResultHandedOff`. `SendResult` succeeds while no socket is held, so a command result sits in memory after the journal entry is cleared. Change only the command-result path. Test through the real dispatch path:

```go
func TestResultWhileDisconnectedGoesToOutboxBeforeHandoff(t *testing.T) {
	c := newTestClient("http://127.0.0.1:1", func(cmd Command) CommandResult {
		return CommandResult{Status: "completed"}
	})
	var mu sync.Mutex
	var order []string
	note := func(s string) { mu.Lock(); order = append(order, s); mu.Unlock() }
	handedOff := make(chan struct{})
	c.OnResultWriteFailed = func(r CommandResult) { note("outbox:" + r.CommandID) }
	c.OnResultHandedOff = func(r CommandResult) { note("handoff:" + r.CommandID); close(handedOff) }

	c.dispatchCommand(Command{ID: "cmd-1", Type: "run_script"}) // never connected
	select {
	case <-handedOff:
	case <-time.After(5 * time.Second): // hang guard only
		t.Fatal("result never handed off")
	}
	mu.Lock()
	defer mu.Unlock()
	if want := []string{"outbox:cmd-1", "handoff:cmd-1"}; !slices.Equal(order, want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	if n := len(c.resultChan); n != 0 {
		t.Fatalf("result buffered in memory while disconnected (%d queued)", n)
	}
}
```

Add `TestSendResultWhileConnectedStillUsesChannel` (no change when a socket is held) and `TestSendResultWhileDisconnectedStillBuffers` (a guard: direct `SendResult` callers keep today's buffering, which the existing `client_send_test.go:15-50`, `result_resend_test.go` and `result_after_stop_test.go:68` tests and the tunnel-closed, clipboard-summary and desktop-disconnect notices rely on). Run `go test -race -run 'TestResultWhileDisconnected|TestSendResultWhileConnected|TestDisconnectedResult' ./internal/websocket/` → the first fails: the result is queued in `resultChan` and the outbox hook never runs.
- [ ] **Step 2: Implement.** In `processCommand` only: if `!c.IsConnected()` (and the client is not stopped), log Info `command result held for reconnect` and call `c.handleResultWriteFailure(result)` instead of `SendResult`; the unconditional `OnResultHandedOff` that follows is unchanged, so the outbox write still precedes the journal clear. `SendResult` and its other callers are untouched, so no existing test changes. A socket that drops between the check and the write is already covered by `writePump`'s `OnResultWriteFailed` path. The outbox re-sends on `OnConnected`.
- [ ] **Step 3:** green; `go test -race ./internal/websocket/...` and `go test -race -run 'Result|Outbox|Journal' ./internal/heartbeat/` green.
- [ ] **Step 4: Commit** — `fix(agent): persist command results to the outbox while the WS is down (W09, #8148)`

### Task 7: Per-route loop deferral in the heartbeat (D5 part 2, D6) — amended: keep with A9 edits

**Files:** create `agent/internal/heartbeat/loop_deferral.go`, `loop_deferral_test.go`, `loop_deferral_senders_test.go`; modify `heartbeat.go` call sites.

- [ ] **Step 1: Red — the store.** `loop_deferral_test.go` (store constructed with an injected `now`):
  - `TestDeferralBlocksUntilRetryAt`, `TestDeferralKeyIncludesOriginAndMethod` (a new server URL after promotion is not blocked), `TestDeferralKeyNormalisesIDs` (two agent ids, or two command ids in a path, map to one route key), `TestSkipDoesNotExtendDeferral` (calling `Ready` while blocked does not move `RetryAt`), `TestLaterRetryAtWins` (two records keep the later one), `TestRecordWithoutRetryAtKeepsDeferral` (a plain error does not clear an existing deferral), `TestDeferralConcurrentRecordReady` (many goroutines `Record`/`Ready` under `-race`), `TestDeferralDisabledByConfig` (D10 `loop_retry_after=false` → `Ready` always true, `Record` no-op). Both the store's `now` and httputil's `nowFn` are faked in the sender tests.
- [ ] **Step 2: Red — the senders.** `loop_deferral_senders_test.go`, a `Heartbeat` wired to an `httptest` server and the fake clocks of Task 5:
  - `TestDeferredInventorySkipsUntilRetryAt`: `PUT software` answers `503`, `Retry-After: 150`; the next inventory cycle before `RetryAt` makes **no** request; after it, one request.
  - `TestDeferredEventLogsDoNotCollect`: with `eventlogs` deferred, a fake `eventLogCol` records zero `Collect` calls.
  - `TestDeferredRecoveryKeysStayParked`: with `security/recovery-keys` deferred, `pendingRecoveryKeys` is unchanged and no ERROR line is logged.
  - `TestHeartbeatIgnoresLoopDeferral`: pre-seed a deferral 390 s ahead for **every** key, including the heartbeat route's key, and have the heartbeat answer `503`, `Retry-After: 300`; the next `sendHeartbeat` still makes its request. (Pre-seeding makes it a real guard: it fails if heartbeat is ever routed through the gated path.)
  - `TestEveryAgentRouteCallIsGatedOrExempt` (a source-scan contract test): every `sendInventoryData(` and `httputil.Do(` call in non-test files of `internal/heartbeat` is either preceded by a `loopReady` gate in its function or listed in an explicit exempt list (heartbeat, command result, elevation, PAM reconciliation) with a reason. A new ungated call fails CI.
  - `TestCommandResultNeverDeferred`: a deferral recorded for every route does not stop `POST commands/:id/result`.
  - `TestNoHintNoDeferral`: `503` without the header records nothing; the next cycle sends as today.
  Run → fail.
- [ ] **Step 3: Implement.** `loop_deferral.go`: `type loopDeferral struct{ mu sync.Mutex; until map[string]time.Time; now func() time.Time; enabled bool }`; `Ready(key) bool`; `Record(key, err)` that uses `httputil.RetryAtFrom`; `var ErrDeferred = errors.New("deferred by server Retry-After")`; `func (h *Heartbeat) loopKey(method, route string) string` (origin from `h.serverURL()`); `func (h *Heartbeat) loopReady(method, route string) bool` that logs Debug when it skips. In `sendInventoryData`: return `ErrDeferred` before marshalling when not ready; after `httputil.Do` errors, `Record`. Add `if !h.loopReady(...) { return }` at the top of `sendEventLogs` (before `Collect`), `sendRecoveryKeys` (before the pop), the patch inventory claim (before `claimPatchScanLocked` takes the claim), `sendReliabilityMetrics`, the boot-performance post, `runProcessSampler`'s per-tick body, and `sendMonitoringResults`. Heartbeat and command-result paths get no call.
- [ ] **Step 4: Audit and record.** List every caller of `sendInventoryData` and every direct `httputil.Do` in `internal/heartbeat` (`git grep -n "sendInventoryData(\|httputil.Do(" agent/internal/heartbeat | grep -v _test`). For each, write one row in the PR body: route, collects-before-send (yes/no), state mutated before send, gate placement. Any "yes" row without an early gate is a defect: fix it in this task.
- [ ] **Step 5:** green; `go test -race ./internal/heartbeat/...` green (run with `-timeout 15m`; the package is large).
- [ ] **Step 6: Commit** — `feat(agent): defer each periodic route until the server's Retry-After, before collecting (W09, #8148)`

### Task 8: UniFi collector honours `Retry-After` — amended: keep, 300 s bound

**Files:** modify `agent/internal/unifi/collector.go`, `collector_schedule.go`; extend their tests.

- [ ] **Step 1: Red.** With the injectable `fetchSchedule` and a `now` seam added to `CollectorDeps`:
  - `TestFetchConfigsHonoursRetryAfter`: `GET /unifi-collectors` answers `503`, `Retry-After: 40`; the loop's next timer is ≥ 40 s (and ≤ 52 s with rand ≤ 1), not 30 s.
  - `TestTelemetryHonoursRetryAfter`: `POST /unifi-telemetry` answers `503`, `Retry-After: 120`; that collector's next run is not before `RetryAt`, while the config fetch keeps its own cadence.
  - `TestUnifiNoHintUnchanged`: bare `503` → today's cadence.
  - `TestUnifiLoopRetryAfterDisabled`: D10 off → today's cadence even with the header.
  Run → fail.
- [ ] **Step 2: Implement.** Parse `httputil.ParseRetryAfter` on a `429`/`503` in both calls; return a typed error carrying `RetryAt` (reuse `httputil.RetryableStatusError`); the loop sets `timer.Reset(max(next, RetryAt − now))` for fetch, and keeps a per-collector `notBefore` map for telemetry. Respect D10 `loop_retry_after`.
- [ ] **Step 3:** `go test -race ./internal/unifi/...` green.
- [ ] **Step 4: Commit** — `feat(agent): UniFi collector honours Retry-After on fetch and telemetry (W09, #8148)`

### Task 9: Log shipper — cancellable waits and a carried `notBefore` — amended: keep, 300 s bound

**Files:** modify `agent/internal/logging/shipper.go`; extend `shipper_test.go` (or create `shipper_retryafter_test.go`).

- [ ] **Step 1: Red.**
  - `TestShipperStopInterruptsRetryAfterWait`: server answers `503`, `Retry-After: 45`; `Stop()` called while the shipper waits returns within the hang guard, with no real 45 s wait (the faked seam is the shipper's `afterFn`, so the real stop-select in `s.sleep` is exercised).
  - `TestShipperCarriesRetryAfterToNextBatch`: three `503`s with `Retry-After: 40`; the batch is dropped as today (counted), and the **next** batch is not posted before `RetryAt`.
  - `TestShipperShortHintsUnchanged`: `Retry-After: 3` keeps today's in-loop retry.
  - `TestShipperLoopRetryAfterDisabled`: with D10 `loop_retry_after=false`, nothing is carried to the next batch.
  Run → fail (`time.Sleep` ignores stop; nothing carried).
- [ ] **Step 2: Implement.** Replace both `time.Sleep` calls in the retry loop with `s.sleep(d) bool` that selects on the shipper's stop channel and `afterFn(d)` (seam). Keep `notBefore time.Time` on the `Shipper`, set from the last attempt's `Retry-After` (jittered once, 390 s ceiling); `shipLoop` skips a tick while `now < notBefore` and keeps buffering (the 500-entry buffer's drop-when-full behaviour is unchanged). Use the package's own `parseRetryAfter` (the import-cycle copy) and keep it in step with `httputil` bounds; add a test that the two parsers agree on the shared cases.
- [ ] **Step 3:** `go test -race ./internal/logging/...` green.
- [ ] **Step 4: Commit** — `fix(agent): log shipper waits are cancellable and honour Retry-After across batches (W09, #8148)`

### Task 10: Startup spread (spec item 4) and the config escape hatch (D7, D10) — amended: keep with A10 edits

**Files:** create `agent/internal/heartbeat/startup_stagger.go`, `startup_stagger_test.go`; modify `heartbeat.go` (three lines of the startup bundle), `agent/internal/monitoring/monitor.go` (+ test), `agent/internal/config/config.go` (+ test), `agent/internal/agentapp/main.go`, `agent/internal/websocket/client.go` (`Config` gains `FirstReconnectWindow`).

- [ ] **Step 1: Red.**
  - `TestStartupBundleIsStaggered` (`startup_stagger_test.go`): with an injected `after` and rand sequence 0.1, 0.5, 0.9, the three bulk tasks (inventory, hardware inventory, patch inventory) are scheduled at 12 s, 60 s and 108 s; none runs before its timer fires; each runs exactly once.
  - `TestStartupStaggerKeepsGateStamps` (a regression guard, not red-first: `heartbeat.go:2113-2115` already stamps the gates): after the refactor, `lastInventoryUpdate`, `lastHardwareUpdate` and `lastPatchUpdate` are stamped when the tasks are scheduled, so the first tick cannot duplicate a delayed send.
  - `TestStartupStaggerStopsWithHeartbeat`: closing `stopChan` cancels pending tasks.
  - `TestMonitorFirstRunJitteredOnce` (`monitoring`): with interval 30 s and rand 0.5 the first run waits 15 s; a `Stop()`/`Start()` caused by a config refresh within the same process runs at once on its first tick instead of drawing a new delay. The `firstRunDelay` field defaults to zero for a `Monitor` built in tests, so existing `monitor_test.go` tests gain no wait.
  - `TestFirstReconnectWindowZeroVsUnset` (`websocket`): an unset window gives 30 s; `ws_first_reconnect_window_seconds: 0` gives an immediate redial after a stable drop. `websocket.Config` carries `FirstReconnectWindow *time.Duration` (nil = default) so the zero value of `Config` is not mistaken for "off".
  - `TestAgentAppPassesReconnectKeys` (`agentapp`): the two keys reach `websocket.Config` and `httputil.SetLoopRetryAfter`.
  - `TestConfigReconnectKeys` (`config`): defaults 30 and true; `ws_first_reconnect_window_seconds: 0` accepted; 301 clamped to 300 with a Warn; negative → default with a Warn.
  Run → fail.
- [ ] **Step 2: Implement.** `startup_stagger.go`: `func (h *Heartbeat) staggerStartup(tasks []startupTask, window time.Duration, rnd func() float64, after func(time.Duration) <-chan time.Time)`; production window 120 s. Replace `go h.sendInventory()` / `go h.sendHardwareInventory()` / `go h.sendPatchInventory()` at `heartbeat.go:2085-2087` with one call; leave `go h.runProcessSampler()` at `:2088` (it already waits one interval) and the 24 h-gated reliability post. The WS start jitter is Task 2's (`EventStart`); this task only wires the config window into it. `monitor.go`: `firstRunDelay` field (default `U(0, min(interval, 60 s))`), consumed only on the first `Start` of the `Monitor` value. `config.go`: two keys with `mapstructure` tags `ws_first_reconnect_window_seconds` and `loop_retry_after`, defaults set where the other defaults are set, bounds in the existing validation function. `agentapp/main.go`: pass the window into `websocket.Config` and call `httputil.SetLoopRetryAfter(cfg.LoopRetryAfter)` before `startAgent` starts any loop.
- [ ] **Step 3:** green: `go test -race ./internal/heartbeat/... ./internal/monitoring/... ./internal/config/... ./internal/websocket/... ./internal/agentapp/...` (one package per command on a loaded host).
- [ ] **Step 4: Commit** — `feat(agent): spread startup requests and add reconnect/Retry-After config escape hatches (W09, #8148)`

### Task 11: Docs and release note — amended: keep, wording per A4

**Files:** `apps/docs/src/content/docs/deploy/upgrades.mdx`, `docs/release-notes/next-release-draft.md`.

- [ ] **Step 1:** In `upgrades.mdx`, the "Expected downtime" paragraph (currently "Agents continue running independently during this window and reconnect automatically", line 77): add that from this agent version agents spread their reconnect over up to 30 seconds after a server restart, and that a server overloaded by reconnects answers with `503` and a retry delay that agents honour. Add a short "Agent reconnect settings" subsection naming the two config keys, their defaults, and that `0` / `false` restore the earlier behaviour.
- [ ] **Step 2:** `next-release-draft.md`: an "Agent" entry: jittered reconnect, `drain` support (dormant until the server sends it), loop-level `Retry-After`, startup spread, the two keys, and the operator-visible effect (a device can show offline up to about 30 s longer after an API restart).
- [ ] **Step 3:** `pnpm --filter @breeze/docs build` if the docs app builds locally on this host; otherwise state in the PR that the docs build runs in CI.
- [ ] **Step 4: Commit** — `docs(agent): reconnect spreading and Retry-After behaviour (W09, #8148)`

### Task 12: Simulator uses the real policy; `drain` storm scenario — amended: REWRITTEN, run A11 instead

**Gate:** start only when `gh pr view 8587 --json state --jq .state` prints `MERGED`. Then `git fetch origin && git rebase origin/main` and re-run `go test -race ./tools/agentsim/...` before editing. If #8587 is not merged when Tasks 1–11 are done, open the PR without this task and file it as the first follow-up with the text below.

**Files:** modify `agent/tools/agentsim/sim/ws.go`, `sim/agent.go`, `sim/storm.go`, `sim/config.go`, `agent/tools/agentsim/main.go` (+ their tests); create `load-tests/agentsim/storms/drain-120.json`; append `## Reconnect and drain (W09)` to `load-tests/agentsim/README.md`.

- [ ] **Step 1: Red.**
  - `TestSimRunUsesAgentReconnectPolicy` (`ws_test.go`): a sim session against the fake API whose socket is dropped after 31 s (sim clock) waits the policy's first-window delay, not 0. W06's mirror comment "An established socket that drops is redialled at once" is deleted with the behaviour.
  - `TestDrainSocketsActionSpreadsReconnects` (`storm_test.go`): 1,000 sim agents, `drain-sockets {withinMs: 120000}` then close; the timeline's `reconnectSpanS` is within [108, 132] and `peakToMean` ≤ 1.5.
  - `TestPreW09CohortRedialsImmediately`: with `--pre-w09-fraction 0.5`, half the sessions use the pre-W09 policy (immediate redial, drain ignored, WS `Retry-After` ignored) and their reconnects land in the first second.
  - `TestScenarioFilesLoad` (W06's committed-scenario test) picks up `drain-120.json`.
  Run → fail.
- [ ] **Step 2: Implement.** `ws.go`: delete the mirrored backoff constants that the policy now owns (keep `wsWriteWait`, `wsPongWait`, `wsHandshake`, `wsMaxMessage`), call `agentws.ReconnectPolicy.Next` with the session's seeded rng, map the sim's events to `ReconnectEvent`, and keep a per-session drain hint. `storm.go`: a `drain-sockets` internal action with a `withinMs` argument that sets each live session's hint and then closes every socket (the sim stands in for the server's frame; this exercises the shared policy, not the shipped binary's `readPump`, which Task 4 covers). `config.go` + `main.go`: `--pre-w09-fraction` in `[0, 1]`; the cohort is `index < round(f·N)` after W06's legacy-retry cohort so the two can overlap; `AgentReport.PreW09` (`omitempty`). `drain-120.json`: one event, `drain-sockets` at the steady-window open with `withinMs: 120000`, recovery 4 min. README: how to run `storm.sh drain-120` and `storm.sh api-kill` with `--pre-w09-fraction 0` and `0.5`, and which report fields W09's acceptance reads.
- [ ] **Step 3:** `go test -race ./tools/agentsim/...` green; `storm.sh drain-120 --storm-dry-run` prints the expanded schedule.
- [ ] **Step 4: Commit** — `feat(agentsim): use the agent's reconnect policy; drain-sockets storm and pre-W09 cohort (W09, #8148)`

### Task 13: Full verification before the PR

- [ ] `cd agent && go vet ./...` (exit 0).
- [ ] `cd agent && go test -race -timeout 15m ./internal/websocket/... ./internal/httputil/...`, then `./internal/heartbeat/...`, then `./internal/unifi/... ./internal/logging/... ./internal/monitoring/... ./internal/config/... ./internal/agentapp/...`, then `./tools/agentsim/...` if Task 12 ran, then `./...` once at the end. Record pass counts per command in the PR.
- [ ] Cross-compile the shipped binaries for every release target: `GOOS=windows GOARCH=amd64 go build ./cmd/...`, `GOOS=darwin GOARCH=arm64 go build ./cmd/...`, `GOOS=darwin GOARCH=amd64 go build ./cmd/...`, `GOOS=linux GOARCH=amd64 go build ./cmd/...`, `GOOS=linux GOARCH=arm64 go build ./cmd/...` (all exit 0; `CGO_ENABLED=0` where the Makefile uses it).
- [ ] `git grep -n "time.Sleep" -- $(git diff --name-only origin/main -- '*_test.go')` returns nothing new.
- [ ] Placeholder scan of the diff: no `TODO(W09)`, no `TBD`.

---

## Gates (Todd / orchestrator)

These need hardware, a quiet host or production access; the implementer opens the PR with the unit evidence and lists each gate's status.

- **G1 — Lab storm run (pre-merge, orchestrator or Todd).** On a quiet host with a wt-stack and W08 in `enforce`: `storm.sh storm-suite` (W06) at 400 agents with `--pre-w09-fraction 0` and again with `0.5`, then `storm.sh drain-120` at 400 agents. Record per event: `t90S`, `peakConnectsPerSecond`, `reconnectSpanS`, `peakToMean`, WS refusals, heartbeat p95 and pool minimum. **Pass:** for `api-kill` with fraction 0, connect attempts per second never exceed (W08 WS rate + burst) × 1.5 after the first 2 s and all refusals are followed by waits ≥ their `Retry-After`; `drain-120` span within [108, 132] s. Fraction 0.5 is recorded, not gated (it models the rollout midpoint). Needs Task 12; if #8587 has not merged, G1 waits.
- **G2 — Real agents on the lab rigs (pre-merge, Todd).** Per the release skill Step 0.2 recipe (non-prod rigs only): build this branch for Windows and Linux, point a lab rig at a local stack, then (a) restart the API container and read the agent log for `reconnect scheduled cause=remote_close` with a delay ≤ 30 s; (b) set `BREEZE_ADMISSION_WS_RATE_PER_SEC` very low in `enforce`, restart, and read `reconnect scheduled cause=dial_failed` with a wait ≥ the logged `Retry-After`; (c) drive admission to level ≥ 1 per W08's lab recipe and read one `deferred` line for a bulk route and no gap in heartbeats; (d) set `ws_first_reconnect_window_seconds: 0` and `loop_retry_after: false`, restart the agent, and confirm (a) and (c) show today's behaviour. Restore each rig's config afterwards.
- **G3 — 10k on fixed hardware (post-merge, Todd).** The spec's "10k simulated agents" needs W07's fixed hardware; one dev host carried 400 (W06) and one lab API could not carry 2,000 at production cadence (W02). The 10k figure is carried until then by `TestDrainSpread10kAgents` (the shipped policy, 10k draws) and G1's 400-agent run. Record the 10k run under W07 when its hardware exists.
- **G4 — Rollout (below).** Every promote step is a separate explicit go from Todd.

## Rollout (agent release path)

There is no percentage or ring mechanism for agent binaries. The levers are the regional promote of `agent_versions.is_latest` (hosted runs with `AGENT_AUTO_PROMOTE=false`), the per-org update policy and maintenance window, and per-org version pins (#2124). Agents never downgrade (R3), so **rollback is a forward fix**: the D10 keys (fleet-wide via a Breeze script), or a new release that restores the old behaviour. The server-side controls (W08) protect the API throughout, with or without W09 agents in the field (spec §8 risk 2).

| Step | What | Watch | Advance when |
|---|---|---|---|
| R-0 | Lab rigs (G2), including a rehearsal: set the D10 keys by a Breeze script run on a lab device and confirm they take effect after the agent restarts, and confirm an agent that cannot reach the API recovers when it can again | Agent logs | G2 passes |
| R-1 | **Canary org.** First verify on a lab stack that a version pin may point ahead of `is_latest` (R4). If it can: pin one internal hosted org to the release in the sleeping region for 24 h. If it cannot: on that org, use the explicit per-device upgrade path for a handful of internal devices instead, and record that the canary is per-device | WS accept rate and refusals, heartbeat gap alerts, watchdog restarts in agent diagnostics, presence count, support tickets | 24 h clean |
| R-2 | Promote in the sleeping region (release skill, "Promote the agent fleet"; slot-aware SQL) | Same, plus the W08 admission panel | 24 h clean, no rise in watchdog restarts or offline flaps |
| R-3 | Promote in the other region | Same | — |
| Self-host | Ships in the release; the upgrade notes (Task 11) describe the behaviour and the keys | — | — |

**Abort criteria at any step:** watchdog restarts per device-day above the previous release's rate; a device class that never reconnects; heartbeat p95 or gap regressions not explained by load. Response: stop promoting, set the D10 keys fleet-wide if the cause is the reconnect window or deferral, file the defect, ship a fix release.

## Acceptance (W09)

| Requirement | Evidence |
|---|---|
| (1) Jittered first reconnect | Task 2 `TestStableRemoteDropWaitsFirstWindow`, policy table; G2 (a) |
| (2) `drain {reconnectWithinMs}`, uniform over the window | Task 4 tests, incl. `TestDrainDelayStartsAtClose`; `TestDrainSpread10kAgents`; G1 `drain-120` |
| (3) Loop-level `Retry-After` | Task 5 (`RetryAt`), Task 7 (deferral), Task 8 (UniFi), Task 9 (shipper), Task 3 (WS); G2 (b), (c) |
| (4) Jittered startup and periodic requests | Task 10; Task 2 `TestWSStartDialJittered` |
| "10k told 120 s arrive spread over 120 s ±10 %" | `TestDrainSpread10kAgents` (10k, 10 s buckets, ±10 %); G1 span check; G3 on fixed hardware |
| "Unannounced API kill: no reconnect spike above the W1c admission rate" | D1 + D2 + Task 3; G1 `api-kill` attempts/s bound |
| Old servers unchanged | `TestNoHintServerKeepsBackoffShape`, `TestDoWithoutHintUnchanged`, `TestNoHintNoDeferral`, `TestUnifiNoHintUnchanged`, `TestShipperShortHintsUnchanged` |
| Legacy cohorts | G1 with W06's `--legacy-retry-fraction` and W09's `--pre-w09-fraction` |
| Heartbeats never deferred | `TestHeartbeatIgnoresLoopDeferral` |
| No result loss in longer offline windows | Task 6 |

## PR

- Title: `feat(agent): jittered reconnect, drain handling, loop-level Retry-After (W09, #8148)`.
- Body: `Closes #8148`; the policy table; the Task 7 audit table; Task 13 counts; G1/G2 status; the owner decisions below; a `## Merge Danger` section (below).
- Review: `/pr-review-toolkit:review-pr`, one round. Ask `silent-failure-hunter` to check every new early return (deferral, refused dial, drain parse) logs or counts what it skipped, and `pr-test-analyzer` to check each Review Focus item has a failing-first test.
- Merge through the queue with `gh pr merge <N>`. Never `--admin`. Promote only per Rollout.

**Merge Danger (for the implementation PR):**
- **Door: one-way once promoted.** Merging is two-way (nothing changes on a device until a release is promoted). After promotion, agents do not downgrade (R3); the escape hatch is the D10 keys or a fix release.
- **Blast radius:** every agent that updates. Worst cases and their guards: watchdog restarts from late heartbeats (heartbeats are never deferred, D6); a tight reconnect loop (short-lived backoff, Review Focus 2); devices offline up to 30 s longer after an API restart (expected, documented, bounded below the presence lease); a route silenced for up to 390 s per server answer (bounded, per route, never heartbeats or command results).
- **Self-hosters** get the behaviour when they update agents; no server change is needed for any of it.
- **CI:** `test-agent` runs `go test -race ./...` in `agent/`.

## Owner decisions surfaced by this plan (Todd) — all four decided 2026-10-16 (Amendment A0)

1. **First-reconnect window 30 s** (D2). It is the user-visible cost: after an API restart a device may show offline and a remote session may take up to 30 s longer to come back. Recommend 30 s; the key allows 0–300.
2. **Watchdog overload liveness** (follow-up 2) is out of W09 and pre-existing. Recommend filing it now so W5's rolling deploys do not depend on it.
3. **Canary shape** (R-1) depends on R4. Recommend the pinned org if pins can point ahead.
4. **Graceful-shutdown `drain`** (follow-up 1). Until W5c sends `drain`, the hint is dormant; the first-reconnect jitter covers today's single-instance restarts. Recommend leaving the sender to W5c unless G1 shows `rolling-deploy` needs it sooner.

## Follow-ups to file at merge (not in this wave)

1. W5c: send `{"type":"drain","reconnectWithinMs":N}` before closing agent sockets on a draining instance (and optionally on graceful shutdown of a single instance); W06's `drain` internal action then becomes a server action in the storm suite.
2. Watchdog: distinguish "server overloaded" from "agent wedged" so repeated heartbeat `503`s (W08 D14) do not restart agents; ships watchdog first.
3. If Task 12 did not run in this PR: the simulator task as written above.
4. Server-hinted reconnect window in the `connected` frame, if W07 data at M2 shows the fixed 30 s window is wrong for large instances.
5. Pre-existing, seen while planning: event-log collection and monitoring results are lost on any failed send, deferral or not (F14). Decide whether either needs a durable buffer.

## Self-review

**Spec coverage (W1d).** (1) first-reconnect jitter: Task 2, D2. (2) `drain`: Task 4, D4, wire shape fixed here for W5c. (3) loop-level `Retry-After`: Tasks 3, 5, 7, 8, 9, D1/D5. (4) startup and periodic jitter: Task 10, D7 (periodic loops already spread by the jittered first beat and existing ±10 % helpers; the post-`Retry-After` jitter re-spreads a fleet that a shed synchronised). "Old agents still rely on W1c": no server change, pre-W09 agents ignore `drain` (F4), W08 unchanged. Acceptance: see **Acceptance**. Ships to customers: Rigor high, Merge Danger, Rollout, G2/G4. Dispatch asks: files, red-first test, commands and commit per task; fake clocks (Tasks 1, 5, 7–10); backward compatibility (the "no hint" tests); legacy-retry cohort (G1); release rollout and lab acceptance as Todd gates; no infrastructure details; Merge Danger; ownership against W05/W06/W07; simulator mirror task (Task 12).

**Placeholder scan.** No TBD. Three "verify, then adapt" points, each with a named fallback: R4 pin-ahead (per-device canary), Task 7's audit (fix any unguarded "collects first" row in the same task), Task 12's gate on #8587 (ship without it, file follow-up 3).

**Type consistency.** `wsClock`/`wsRand` (Task 1) → `ReconnectPolicy`, `ReconnectEvent`, `BackoffState` (Task 2) → `DialRefusedError` (Task 3) → `drainHint`, `parseDrainHint` (Task 4) → used by the sim (Task 12). `RetryableStatusError.RetryAt`, `RetryAtFrom`, `SetLoopRetryAfter` (Task 5) → `loopDeferral`, `ErrDeferred` (Task 7) → UniFi (Task 8). D10 keys (Task 10) feed `ReconnectPolicy.FirstWindow` and `SetLoopRetryAfter`.
