# Remote Desktop Bug Fix — PR Review Follow-ups

> Follow-up work deferred from the 2026-04-10 remote desktop fix set
> (adaptive bitrate oscillation, Tauri clipboard sync, login-transition
> desktop disconnect). Captured from PR review findings that were worth
> doing but out of scope for the primary fix.

**Parent change summary:**
- `agent/internal/remote/desktop/adaptive.go` — switched encoder throughput
  cap from encoded/captured ratio to observed-FPS EWMA with sticky
  hysteresis; preserved encoder state across `SoftResetForActivity`.
- `agent/internal/remote/desktop/session_capture.go` — added a 3s no-video
  watchdog that forces thread-desktop re-attach and capturer re-init.
- `agent/internal/remote/desktop/dxgi_desktop_windows.go` — added
  `ForceReattach()`, tightened `checkDesktopSwitch` silent-return paths,
  fixed the secure-desktop-on-startup branch.
- `apps/viewer/src/components/DesktopViewer.tsx` — routed clipboard receive
  through the Tauri plugin; awaited clipboard push before dispatching
  `key_press` on Ctrl+V.

---

## 1. Clipboard Ctrl+V ordering — extract + Vitest

**Status:** ✅ done (2026-04-11). Extracted to `apps/viewer/src/lib/clipboardPaste.ts`; 7 Vitest cases in `clipboardPaste.test.ts` all pass. Required bumping viewer `vite` from ^5.4.3 → ^6.4.1 because vitest 4.1.2 imports `vite/module-runner` which only exists in vite 6+.

**Why:** the core Ctrl+V fix is pure async ordering logic (read clipboard
→ push to DataChannel → wait → dispatch keystroke). Today it's inlined in
a React `useCallback` alongside keymap translation, so it can't be
unit-tested. A future refactor that re-orders the awaits or drops the
50 ms sync delay would silently regress and no test would catch it.

**File map:**
- **Create** `apps/viewer/src/lib/clipboardPaste.ts` — pure async function:
  ```ts
  export interface CtrlVPasteDeps {
    dc: RTCDataChannel | null;
    readText: () => Promise<string | null>;
    lastHash: { current: string };
    dispatchPaste: () => void;
    syncDelayMs: number;
  }
  export async function handleCtrlVPaste(deps: CtrlVPasteDeps): Promise<void>;
  ```
- **Create** `apps/viewer/src/lib/clipboardPaste.test.ts` — Vitest cases:
  - sends clipboard text on the DataChannel *before* calling `dispatchPaste`
  - skips `dc.send` when `text === lastHash.current`
  - dispatches paste synchronously when `dc` is null
  - dispatches paste synchronously when `dc.readyState !== 'open'`
  - re-checks `dc.readyState` after the await; if it closed, logs but
    still dispatches paste
  - dispatches paste even when `readText()` rejects (fall-through)
- **Modify** `apps/viewer/src/components/DesktopViewer.tsx` — replace the
  inline Ctrl+V IIFE in `handleKeyDown` with a call to `handleCtrlVPaste`.
  The component still wires up `dispatchPaste`, `readText` (dynamic
  import), and `lastClipboardHashRef`.

**Acceptance:** all 6 test cases pass; `pnpm tsc --noEmit`; manual Ctrl+V
still works end-to-end against a Windows agent.

---

## 2. Agent ack for Ctrl+V clipboard apply

**Status:** ✅ done (2026-04-11). Agent sends `{"type":"ack","hash":"<fingerprint>"}` after successful `SetContent`; viewer tracks in-flight pushes in `clipboardAckMapRef` and resolves on ack with a 300ms timeout fallback for backwards compat. `setTimeout(50)` stop-gap removed along with the TODO.

**Why:** the current 50 ms `setTimeout` is a stop-gap. Under load — busy
Windows user helper, large clipboard payloads, cross-session helper
latency — 50 ms is insufficient and the paste will land before
`ClipboardSync.SetContent` finishes, pasting stale content. The
deterministic fix is a bidirectional ack on the existing clipboard
DataChannel.

**Design:**
- **Agent** `agent/internal/remote/clipboard/sync.go`: in `Receive()`, after
  `c.provider.SetContent(content)` succeeds, send an ack message on the
  same DataChannel: `{"type":"ack","hash":"<fingerprint>"}`.
- **Viewer** `apps/viewer/src/components/DesktopViewer.tsx` clipboard
  `onmessage` handler: track in-flight pushes by hash; when the ack
  arrives, resolve the matching promise.
- **Ctrl+V flow**: after `dc.send`, await the ack with a 300 ms timeout
  fallback (in case the agent is older, or the message is dropped).
- **Backwards compat**: agent ack is opt-in by type; old viewers ignore
  unknown message types. Viewer falls back to the 300 ms timeout if no
  ack arrives.

**File map:**
- Modify `agent/internal/remote/clipboard/sync.go` — add ack send on
  successful `Receive`.
- Modify `agent/internal/remote/clipboard/sync_test.go` — assert ack is
  sent.
- Modify `apps/viewer/src/components/DesktopViewer.tsx` — in-flight ack
  tracking, remove the `setTimeout(50)` stop-gap.
- Remove the TODO comment at the Ctrl+V handler.

**Acceptance:** e2e paste under synthetic 500 ms helper delay still works
(currently fails); no-ack timeout fallback covers old agents.

---

## 3. Watchdog escalation after N failed reattaches

**Status:** ✅ done (2026-04-11). `Session.failedReattaches` + `evaluateReattachFailure()` helper in `session.go`; both DXGI and ticker watchdogs in `session_capture.go` call the helper and `go s.Stop(); return captureModeStopped` on exhaustion. Error log at 3 failures (`desktop watchdog: reattach failing, escalating`), termination at 5 (~25s). 4 unit tests in `session_watchdog_test.go` cover first-attempt, recovery reset, full escalation, and late recovery.

**Why:** the no-video watchdog in
`agent/internal/remote/desktop/session_capture.go` currently retries
`ForceReattach()` every 5 s forever. If the re-init is permanently
broken (e.g. DXGI totally unavailable after a driver crash, helper
starved of GPU), the log stream fills with `Warn` lines but there's no
escalation. The session looks alive to the viewer, but no video is
flowing.

**Fix:**
- Track consecutive failed reattaches in the watchdog:
  ```go
  failedReattaches int
  ```
- After each `ForceReattach()`, wait one tick (or check on the next
  iteration) — if `lastVideoWriteUnixNano` hasn't advanced, increment
  the counter.
- After 3 failures (~15 s total) log at `Error` level with a distinct
  message so alerting can pick it up.
- After 5 failures, signal session termination so the viewer can
  reconnect and get a fresh session/helper. Surface via closing `s.done`
  with a reason code, or via a new field `s.fatalErr`.

**File map:**
- Modify `agent/internal/remote/desktop/session_capture.go` — failure
  counting + escalation in both DXGI and ticker watchdogs.
- Modify `agent/internal/remote/desktop/session_webrtc.go` — propagate
  fatal error so the viewer sees a clear `session_failed` signal instead
  of a connection that just stops.

**Acceptance:** add a unit test in a new `session_watchdog_test.go` that
injects a mock capturer whose `ForceReattach` is a no-op — assert the
watchdog escalates after N calls.

---

## 4. Encoder cap boundary + edge-case tests

**Status:** ✅ done (2026-04-11). Added `TestAdaptive_EncoderCapEngagementBoundary`, `TestAdaptive_IntervalResetClearsEWMAKeepsCap`, `TestAdaptive_DeltaCapturedGuardSkipsSamples`, `TestAdaptive_SetEncoderClearsCap`, `TestAdaptive_ThroughputIntervalGuardSub100ms` in `adaptive_test.go`.

**Why:** the adaptive bitrate cap has several thresholds that are
currently only tested away from the boundary. A future refactor could
weaken one without any existing test catching it.

**Tests to add in `agent/internal/remote/desktop/adaptive_test.go`:**

- **0.85 engagement threshold** — at `maxFPS=60`, feed `observed=52`
  (no cap, just above `51`) then `observed=50` (cap). Both cases with
  `encoderSamples >= 3`.
- **`interval > 5s` reset path** (`adaptive.go:317-323`) — engage cap,
  then feed a sample 10 s after the last: assert `encoderSamples == 0`
  and `smoothedEncodedFPS == 0`, and the cap stays engaged (preserved
  across the EWMA reset).
- **`deltaCaptured < 5` guard** — feed `captured=10, encoded=0` across
  10 × 1 s intervals. Delta is 1 per sample, guard skips every one, no
  cap should engage.
- **`SetEncoder` mid-session** — engage cap on encoder A, call
  `SetEncoder(newEnc)`, feed 3 healthy samples, assert cap is cleared
  (opposite of `TestAdaptive_SoftResetPreservesEncoderCap`, proving the
  two reset paths have deliberately different semantics).
- **`UpdateEncoderThroughput` interval < 100 ms** — first sample seeds,
  second sample arrives at +50 ms: assert the 50 ms sample is ignored
  and the baseline is NOT advanced, so the next legitimate sample at
  +1 s still produces the correct delta.

---

## 5. `ForceReattach` empty-name edge case

**Status:** ✅ done (2026-04-11). Took fix option B (structural). Extracted `decideReattach(desktopName string) reattachAction` into platform-neutral `dxgi_desktop_decide.go`; `ForceReattach()` now calls it. 7-case table test in `dxgi_desktop_decide_test.go` covers `""`, `"Default"` (3 cases), `"Winlogon"`, `"Screen-saver"`, random.

**Why:** in `agent/internal/remote/desktop/dxgi_desktop_windows.go`
`ForceReattach()`, the desktop classification line is
`onSecure := currentName != "" && !strings.EqualFold(currentName, "Default")`.
If `desktopName()` returns `""` (which is *exactly* the silent failure
mode the watchdog exists to handle), `onSecure` is `false` and the code
optimistically tries `initDXGI` before falling back to GDI.
Functionally it recovers because `switchToGDI()` catches the DXGI
failure, but the recovery path is one layer deeper than necessary.

**Fix option A (minimal):** treat empty name as "unknown, try GDI first"
to short-circuit the DXGI attempt when we have no confidence.

**Fix option B (structural, preferred):** extract the decision logic
into a pure function so it can be table-tested without Win32:
```go
type reattachAction int
const (
    reattachUseDXGI reattachAction = iota
    reattachUseGDI
)
func decideReattach(desktopName string) reattachAction
```
Then `ForceReattach()` calls `decideReattach(currentName)` and acts on
the enum. Table test covers `"Default"`, `"Winlogon"`, `"Screen-saver"`,
`""`, random strings.

**File map:**
- Modify `agent/internal/remote/desktop/dxgi_desktop_windows.go` — extract
  helper.
- Modify `agent/internal/remote/desktop/dxgi_desktop_windows_test.go`
  (create if missing) — table test for the extracted decision.

---

## 6. Session-capture scene-change test coverage

**Status:** deferred as YAGNI (2026-04-11). `TestAdaptive_SoftResetPreservesEncoderCap` already guards the worst symptom (1Hz pulse on mouse movement). Revisit if the scene-change logic is touched again.

**Why:** the parent PR removed the `consecutiveSkips >= 30` early
scene-change trigger at `session_capture.go:~535`. There's no existing
test coverage for the capture loop's scene-change path, so a future
regression (re-adding the early trigger, or weakening the `wasIdle`
gate) would not be caught. Larger effort because the capture loop has
heavy Win32 dependencies.

**Scope option:** extract the scene-change decision — "should we call
`SoftResetForActivity` + `ForceKeyframe` this iteration?" — into a pure
helper that takes `(wasIdle bool, consecutiveSkips int)` and returns a
bool. Unit-test the helper.

Alternatively, skip as YAGNI — the adaptive-side test
`TestAdaptive_SoftResetPreservesEncoderCap` already guards the most
damaging symptom (1 Hz pulse on mouse movement). Leaving this open as
"consider if we touch the scene-change logic again."

---

## Ownership

All items are owned by whoever picks up follow-up work on the remote
desktop feature. Items 1 and 2 pair naturally (both touch clipboard);
item 3 stands alone. Items 4–6 are cheap to do together in one pass
over the adaptive/capture test files.
