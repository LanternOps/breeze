# Remote Desktop Architecture Rewrite — Brainstorm Notes (DEFERRED)

> **Status:** Deferred. This is a working brainstorm, not a finalized spec. Sections 3–5 of the design (data flow, error handling, testing) were never written because we discovered a concrete one-row encoder bug that explains the acute Kit symptoms and needs to ship first. Come back to this doc after the encoder fix has stabilized Kit and decide whether the rewrite is still worthwhile.

## Why this exists

Kit's remote desktop regressed between v0.62.0 and v0.62.25-rc.2. The symptoms — low-bitrate blurry streams, disconnect/reconnect on login→desktop handoff, black-screen 0fps, and a general sense that every fix breaks something else — were attributed during brainstorming to structural fragility in the desktop path: 20KLOC across 40+ files, no state machine, four independent watchdogs that can all kill a session, two parallel helper-spawn pipelines, and no way to write integration tests without a real Windows desktop.

During investigation we found the actual acute cause was simpler: **`amfEncoder.SetDimensions` silently rounds odd heights down with `h &^ 1`, but the capturer is never told to crop its output, so every frame fails with `frame size 1434888 doesn't match 1512x948`**. That's being fixed in a separate, scoped change. This document preserves what we designed for the broader rewrite so we can resume if the fragility pattern persists after the encoder fix.

## Decisions we locked in before pivoting

| Decision | Answer | Rationale |
|---|---|---|
| **Scope** (Q1) | **A** — all four workstreams in one spec: integration-test harness, single FSM, kill heartbeat-parallel helper spawn, fix Kit's ForceReattach loop | User explicit choice; the four items were considered coherent as one story. |
| **Migration** (Q2) | **B** — full cutover behind a normal RC, no feature flag | User explicit choice; no safety net. Raises the bar on the harness. |
| **FSM implementation** (Q3) | **C** — extract-and-own: rename `Session` → unexported `sessionState` (data only), introduce `SessionController` as the only exported type, single writer goroutine | Deletes fragility instead of moving it: the `sync.Mutex`, `atomic.Pointer[VideoEncoder]`, `atomic.Bool`, and `startMu` primitives all become dead code because only one goroutine touches state. |
| **Coordinator placement** (Q4, after pushback) | **Two-level FSM** — `DesktopCoordinator` in agent (session 0), `PipelineController` in each helper process | I first proposed putting everything in the helper; user correctly pushed back that cross-helper decisions (RDP server with multiple concurrent sessions, failover between console/RDP helpers) can only be made from the main service. Two-level is the corrected model. |
| **Package name for coordinator** | `agent/internal/desktopcoord/` | Short, unambiguous, doesn't collide with `remote/desktop`. |

## Two-level FSM architecture (locked in)

### Agent (session 0) — `agent/internal/desktopcoord/`

`DesktopCoordinator` — small top-level FSM, one per agent process. Single place that decides "which helper is streaming right now." Heartbeat, broker lifecycle, and `findActiveHelper` all become inputs/outputs of the coordinator, not peers.

- **States:** `Idle`, `HelperStarting`, `Streaming`, `Stopping`, `Failed`.
- **Input events:** `EventAPIStart(sessionUUID, offer, iceServers, targetWTS)`, `EventAPIStop`, `EventHelperConnected(sessionID, caps, wts)`, `EventHelperDisconnected(sessionID, reason)`, `EventHelperCapabilityChanged`, `EventPipelineStateChanged(sessionID, state)`, `EventPipelineStopped(sessionID, reason)`, `EventPipelineFailed(sessionID, error)`.
- **Output actions (via injectable `Actions` interface for tests):** `SpawnHelper(wts, role)`, `SendIPC(sessionID, envelope)`, `PostAPIStatus(status)`.
- **Absorbs from heartbeat:** `desktopOwners` sync.Map, `findActiveHelper`, `findOrSpawnHelper`, `spawnHelperForDesktop`, the dedup-bypass logic, and the #434 WTS-substitution safety net.

### Helper (session N) — `agent/internal/remote/desktop/`

`Controller` (renamed from my original `PipelineController` for brevity) — per-helper FSM, one active instance per process, has no knowledge of other helpers.

- **States:** `Idle`, `Starting`, `Streaming`, `SecureDesktopStalled`, `DesktopTransitioning`, `NetworkFlapping`, `Stopping`, `Stopped`, `Failed`.
- **Owns:** `sessionState` (pion PeerConnection, capturer, encoder, adaptive controller, audio/video/cursor/clipboard DataChannels) — private, single-writer.
- **Input events:** IPC from agent (`Start`, `Stop`, `QueryState`), pion callbacks (ICE/PeerConn state change, RTCP PLI), capture-loop events (`eventFrameCaptured`, `eventNoFrame`, `eventDesktopSwitchDetected`, `eventCaptureError`, `eventBitBltError`), encoder events (`eventMFTStall`, `eventCPUFallback`, `eventEncoderSizeMismatch`), timer events (`eventDisconnectGraceFired`, `eventReattachCooldownElapsed`).
- **Output actions:** pion ops, encoder swap, capture reinit, `forceDesktopRepaint`, IPC events back to agent.
- **Collapses today's four watchdogs** (`reattachWatchdog`, `OnConnectionStateChange` disconnect grace, MFT stall detector, `noVideoWatchdog`) into state transitions on the same FSM, bounded by a single timer per state.

## File layout (locked in)

### New: `agent/internal/desktopcoord/`

| File | Purpose | Rough size |
|---|---|---|
| `coordinator.go` | `Coordinator` struct, `Run` goroutine, event-loop `select` | ~300 lines |
| `state.go` | State enum + transition table | ~80 lines |
| `events.go` | All event types | ~120 lines |
| `actions.go` | `Actions` interface (for fake injection in tests) | ~60 lines |
| `coordinator_test.go` | FSM tests driven by `FakeActions`. Every transition has at least one test, including the Kit scenario: session 2 streaming, pion failed, coord switches to session 4. | ~600 lines |
| `fakes.go` | `FakeActions` + test helpers | ~150 lines |

Public surface: `type Coordinator`, `func New(actions Actions) *Coordinator`, `func (*Coordinator) Run(ctx context.Context)`, `func (*Coordinator) Submit(event Event) error`. Everything else unexported.

### Modified: `agent/internal/remote/desktop/`

Adds:

| File | Purpose | Rough size |
|---|---|---|
| `controller.go` | `Controller` struct, `Run` goroutine, `Start`/`Stop` public methods | ~400 lines |
| `controller_state.go` | State enum + transition table for the per-helper FSM | ~100 lines |
| `controller_events.go` | Event types | ~150 lines |
| `controller_actions.go` | Side-effect dispatch (encoder swap, capture reinit, peerconn close) — called only from the controller goroutine | ~200 lines |
| `controller_test.go` | FSM tests using `fakeCapturer` / `fakeEncoder` / `fakeTransport`. Includes the GDI ForceReattach loop repro. | ~800 lines |
| `fakes.go` | `fakeCapturer`, `fakeEncoder`, `fakeTransport` implementing existing interfaces | ~300 lines |

**No subpackage split.** YAGNI. The current 40-file flat layout stays; `controller_*.go` fits in.

Renamed / shrunk:

- **`session.go`** — `Session` → `sessionState`, unexported, no mutexes, no atomics, no methods beyond pure accessors. Goes from 448 → ~100 lines.
- **`session_manager.go` / `session_webrtc.go`** — `SessionManager.StartSession` becomes a thin factory that hands pion+capturer+encoder+adaptive to a fresh `Controller` and calls `controller.Start(sessionID, offer, iceServers)`. The 500-line StartSession body shrinks to ~80 lines; the rest moves into `buildPipeline` helpers inside `controller_actions.go`. The `startMu` lock disappears entirely.
- **`session_capture.go`** — `captureLoopDXGI` / `captureLoopTicker` stop calling `handleDesktopSwitch` / `restoreHardwareEncoder` / `forceDesktopRepaint` / `s.Stop` directly. They become pure capture producers that emit events and let the controller decide. File goes from 1272 → ~600 lines.

Deleted:

- **`session_watchdog.go` + `session_watchdog_test.go`** — `reattachWatchdog` escalation logic is absorbed into the controller's `StateSecureDesktopStalled` transition (bounded by a single timer, not four interlocking counters).

### Modified: `agent/internal/heartbeat/handlers_desktop_helper.go`

Loses ~450 lines. Deletes: `findActiveHelper`, `findOrSpawnHelper`, `spawnHelperForDesktop`, `killDesktopStaleHelpers`, `rememberDesktopOwner`, `forgetDesktopOwner`, `desktopOwnerSession`, and most of `startDesktopViaHelper`. Kept functions: the macOS LaunchAgent plist bits (`darwinHelperPlists`, `ensureDarwinHelperPlists`, `kickstartDarwinDesktopHelpers`, `findGUIUserUIDs`, `parseGUIUserUIDs`) — but **these move to `agent/internal/sessionbroker/spawn_darwin.go`** in the same PR, otherwise we end up with "unified spawn on Windows, split spawn on macOS" which is worse than today. After this, the file shrinks from 665 → ~80 lines: just IPC command forwarding into `coordinator.Submit`.

### Modified: `agent/internal/sessionbroker/`

- **`lifecycle.go`** — expose `SpawnHelperInSession(wts int, role string) error` as the single canonical cross-platform spawn entry point. Calls into `spawn_windows.go` / `spawn_darwin.go` / `spawn_linux.go`. Today this partially exists but heartbeat bypasses it.
- **`broker.go`** — add `HelperEventSink interface { OnConnect(…); OnDisconnect(…); OnCapabilityChange(…) }` wired at construction so the coordinator receives helper lifecycle events directly. Remove ad-hoc callbacks.
- **New: `spawn_darwin.go`** — receives LaunchAgent bits moved from heartbeat.

### Modified: `agent/cmd/breeze-agent/main.go`

Construct `desktopcoord.Coordinator` at startup, wire it to `sessionbroker.Broker` (as `HelperEventSink`), wire heartbeat's desktop-command handler to call `coordinator.Submit(EventAPIStart{…})`, start the coordinator's `Run` goroutine. ~30 lines added.

## Things this commits us to

1. **`Session` stops being a public type.** Anyone currently importing `desktop.Session` breaks. The spec should include a grep for external import sites and list them as explicit changes. (Not done; brainstorming was paused before Section 3.)
2. **`session_watchdog.go` is deleted, not refactored.** Apr 11 code (commit `49451007`) — the escalation instinct was right but the coordination level was wrong.
3. **The macOS LaunchAgent spawn logic moves out of heartbeat.** Scope creep from "desktop fragility" → "spawn ownership," but leaving the Darwin bits in heartbeat defeats the unification goal.

## Why this was deferred

The concrete Kit symptoms trace cleanly to `encoder_amf_windows.go:146-156`:

```go
func (e *amfEncoder) SetDimensions(w, h int) error {
    w = w &^ 1
    h = h &^ 1
    ...
}
```

Kit's display is 1512×949 (odd height). AMF silently rounds to 1512×948. The capturer is never told to crop. Every frame fails with `frame size 1434888 doesn't match 1512x948` (`1,434,888 = 1512 × 949`). The cascading failures (low bitrate, reconnect, watchdog-triggered restart) all follow from this one bug once the encoder throughput collapses to near-zero.

This is a one-row fix. The full rewrite is not urgent — it's an improvement worth scheduling, not a fire worth rebuilding the house for. We'll do the encoder fix, verify Kit is stable, and revisit the rewrite decision based on whether the remaining fragility (helper spawn storms, parallel heartbeat/broker spawn paths, no integration-test harness) is still actively causing problems.

## Pickup checklist (for the next session)

- [ ] Has the encoder fix stabilized Kit? (Need days, not hours, of soak.)
- [ ] Are there still helper spawn storms in the broker logs after the encoder fix? (The `max connections exceeded count=5 identity=S-1-5-18` pattern.)
- [ ] Is heartbeat still stalling during active desktop sessions? (Watch for gaps in the `heartbeat` component logs.)
- [ ] If any of those are still yes, resume this spec at Section 3 (data flow), 4 (error handling), 5 (testing harness).
- [ ] If all three are no, archive this doc as "resolved without rewrite" and keep the learnings.
- [ ] Regardless: **write the integration-test harness anyway** — `fakeCapturer`/`fakeEncoder`/`fakeTransport` + one end-to-end test that drives a fake DXGI through Winlogon→Default. That's the smallest-footprint piece of this plan and it retires the "live-Kit-only regression cycle" even without the FSM work.

## References

- Original Kit log repro: `agent_logs` for device `85ff0d63-fe61-4a89-ac48-a5da02ccbd17` between 2026-04-16 00:13:19 and 00:15:38 UTC.
- Watchdog code path: `agent/internal/watchdog/watchdog.go`, `checks.go`, `recovery_windows.go`. Added Apr 5 in commit `06b94e3c`. Present in v0.62.0.
- Restore-hardware-encoder path: `agent/internal/remote/desktop/session_capture.go:1118-1198`, from commit `19240eee` (Apr 12).
- Encoder dimension rounding: `agent/internal/remote/desktop/encoder_amf_windows.go:146-156`, from commit `acdccf23` (direct NVENC+AMF encoders via purego).
- Unmerged work: branch `fix/pr450-review` has commit `b75a9572` closing a concurrent-retry race in `SessionManager.StartSession` + `sessionbroker.Session.SendCommand`. The FSM's single-writer model makes the race impossible, so that branch is superseded by this rewrite — do not cherry-pick first.
