---
tracking_issue: LanternOps/breeze#8236
---

# Remote Viewer Input — W2b Agent Reliable Input Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Key presses, key releases, button presses, button releases and scrolls from a W3 viewer reach
the customer's machine in the order they were sent, and none of them is lost. Pointer motion stays on
the low-latency lossy channel, but a move can no longer overtake the click it follows. After any
agent-side reset, no event from before the reset can press a key again.

**Architecture:** The agent accepts a second viewer data channel, `input-r` (reliable, ordered), next
to the existing lossy `input`. Sequenced events carry `seq`, `epoch` and `geoEpoch`. Moves also
carry `after`. A pure state machine, `inputOrder`, owned by the W2a `SafeInput` worker goroutine,
decides for each event: inject it, drop it, or (for a move) hold it until its barrier is met. All
checks run on the worker at injection time, never at submission time. Every agent-side
`ReleaseAll` bumps the reset epoch and closes the gate. The viewer reopens it with
`input_reset{epoch}`. Events without `seq` keep exact W2a behaviour, so old viewers are unaffected.

**Tech Stack:** Go agent, pion/webrtc v4.2.22 (`agent/go.mod:27`). Package
`agent/internal/remote/desktop`. Builds on W2a (`SafeInput`, `heldInput`, `ValidateInputEvent`).

**Spec:** `docs/superpowers/specs/remote-desktop/2026-10-07-viewer-input-clipboard-convenience-design.md`
§1 "Input transport v2" and §2 "Agent held-state tracker" (reset epoch, geometry epoch, idle
accounting). The spec is committed on the W1 branch (`origin/feature/8236-viewer-input-clipboard/wave-8237`)
and is **not** on this branch yet. Read it from there (`git show origin/feature/8236-viewer-input-clipboard/wave-8237:docs/superpowers/specs/remote-desktop/2026-10-07-viewer-input-clipboard-convenience-design.md`).
Do not create it here.

**Base:** branch `feature/8236-viewer-input-clipboard/wave-8246`, cut from the W2a branch
`feature/8236-viewer-input-clipboard/wave-8238` (PR #8251, open). Every `file:line` below was read
at W2a HEAD `0cf03e4185`. When #8251 merges, rebase onto `origin/main` before opening the PR.

**Scope:** wave W2b (#8246) only. W2c (#8247) covers `code` → scancode, extended keys, back/forward,
horizontal wheel, Num/Caps sync and the macOS flags mask. W3 (viewer) adopts the protocol below.
The WebSocket desktop transport stays on the legacy protocol (see Global Constraints).

---

## Wire protocol (the contract W3 implements)

All additions are additive JSON keys. Nothing that exists changes meaning.

**Viewer → agent, on input events** (`InputEvent`, `agent/internal/remote/desktop/input.go:4-20`):

| Key | Type | On | Meaning |
|---|---|---|---|
| `seq` | uint, 1…2^53−1 | every sequenced event, both channels | Per-session counter, strictly increasing across both channels. `0` or absent = legacy event. |
| `after` | uint | `mouse_move` only | `seq` of the last discrete event the viewer sent before this move (`0` if none). Must be `< seq`. |
| `epoch` | uint32 ≥ 1 | every sequenced event | Reset epoch the viewer believes is current. |
| `geoEpoch` | uint32 ≥ 1 | every sequenced pointer event (`mouse_*`) | Geometry epoch from the last `monitor_switched` (or `input_capabilities`). Ignored on key events. |

"Discrete" means every event type except `mouse_move`: `key_*`, `mouse_down/up/click`,
`mouse_scroll` and `input_reset`.

**New viewer → agent event:** `{"type":"input_reset","seq":N,"epoch":E}`, on `input-r` only.
- `E` equals the agent's current reset epoch: the agent releases everything held, **in order**
  behind the events already sent, and accepts sequenced input with epoch `E` from then on. The first
  accepted `input_reset` switches the session to the sequenced protocol for good.
- `E` is stale: the agent drops it and re-announces the current epoch.
- A viewer-initiated `input_reset` (Release-all button, focus loss, entering view-only) does **not**
  bump the epoch. There is no round trip.

**Agent → viewer** (control channel):

| Message | When | Keys |
|---|---|---|
| `input_capabilities` reply | on request (existing) | adds `reliableInput: true`, `inputEpoch`, `geoEpoch` |
| `input_epoch` (new) | after every agent-side reset; and at most every 500 ms while sequenced input arrives with a stale epoch | `epoch`, `reason`. **No `geoEpoch`.** Sent only to viewers that opened `input-r`. |
| `monitor_switched` (existing) | after every geometry transition, once the new offset is in place: a monitor switch; a failed monitor switch (repeats the unchanged monitor); and a desktop switch (UAC, lock, Winlogon; same index) | adds `inputEpoch`, `geoEpoch` |

**Viewer obligations (W3):**
1. Route on `input-r` only after a reply with `reliableInput: true`. Until then, and against any
   agent that never says so, send exactly what W1 sends today on `input`, with no `input_reset`.
   A W2a agent rejects `input_reset` (`input_validate.go:19-22`), which is harmless but logs a Warn.
2. Open the sequenced stream with `input_reset{seq, epoch: inputEpoch}` on `input-r`.
3. Send all discrete events on `input-r` and `mouse_move` on `input`. A sequenced discrete event on
   `input` is rejected. An unsequenced event on `input-r` is rejected.
4. On `input_epoch` with an epoch it has not yet acknowledged: reconcile its own held state, then
   send `input_reset{seq, epoch}`. Take the maximum epoch seen. Announcements can arrive out of
   order or repeat.
5. Adopt `geoEpoch` **only** from `monitor_switched` and `input_capabilities`, together with the
   geometry they describe. Never adopt it from `input_epoch`, which does not carry it. A
   `monitor_switched` can repeat the current index; treat it the same way.
6. Create `input-r` with `{ordered: true}` and no `maxRetransmits` or `maxPacketLifeTime`. The
   agent closes an `input-r` that is not reliable and ordered. Whenever `input-r` closes, fall back
   to the legacy protocol on `input` for the rest of that peer connection.

**Compatibility matrix:**

| Viewer | Agent | Result | Evidence |
|---|---|---|---|
| W1 or older (no `input-r`, no `seq`) | W2b | W2a behaviour, unchanged. Never gated. No `input_epoch` is sent. The extra reply keys are ignored. | Viewer `apply()` reads `typeText` only (`apps/viewer/src/lib/inputCapabilities.ts:53-56`). `monitor_switched` handler reads `index` only (`DesktopViewer.tsx:1303-1307`). Unknown control types fall through the switch. Task 7 regression test. |
| W3 | W2a or older | Viewer stays legacy (no `reliableInput`). The agent ignores `input-r`: there is no `case` for the label (`session_webrtc.go:467-491`), and pion drops messages that have no handler (`pion/webrtc@v4.2.22/datachannel.go:330-332`). `json.Unmarshal` ignores unknown `seq`, etc. | [V] by reading; W3 owns the viewer test. |
| W3 | pre-`typeText` agent (never answers) | Viewer stays legacy. | existing W1 gate behaviour |
| any | W2b over the WebSocket transport | Legacy. The relay rebuilds events field by field (`heartbeat/handlers_desktop.go:1022-1025`), so `seq` never crosses. Its own type allowlist has no `input_reset`. | Task 1 guard test |

---

## Global Constraints

- **Ships to customer machines. Rigor: high.** TDD, red first for every behaviour test. Run
  `go test -race` for the package before every commit that touches `agent/`, plus the cross-OS
  vet and test-binary compile below.
- **CI does not run this package's tests under `-race`, nor on Windows.** The Linux job runs
  `CGO_ENABLED=0 go test -v ./...` without `-race` (`.github/workflows/ci.yml:1814`). The Windows
  job excludes `remote/desktop` because of inherited debt (`ci.yml:1895`). Run the local `-race`
  steps; they are the only race coverage this code gets.
- **Cross-OS commands** (verified working at W2a HEAD on 2026-10-08):
  - `cd agent && GOOS=windows GOARCH=amd64 go vet -unsafeptr=false ./internal/remote/desktop/`.
    Plain `go vet` reports 30 pre-existing `possible misuse of unsafe.Pointer` findings in
    `*_windows.go` files this wave does not touch.
  - `cd agent && GOOS=linux GOARCH=amd64 go vet ./internal/remote/desktop/`
  - `cd agent && GOOS=darwin CGO_ENABLED=0 go vet ./internal/remote/desktop/`
  - `cd agent && GOOS=windows GOARCH=amd64 go test -c -o /dev/null ./internal/remote/desktop/`
    (compiles the Windows test binary).
- **Wire changes are additive only.** The names are exactly: `seq`, `after`, `epoch`, `geoEpoch`,
  `input_reset`, `input_epoch`, `reliableInput`, `inputEpoch`, and the channel label `input-r`.
- **Legacy is sacred.** An event with `seq == 0` behaves exactly as at W2a HEAD until the session's
  first accepted `input_reset`. Every existing W2a test passes unmodified.
- **WebSocket path stays legacy.** Do not copy `seq`/`after`/`epoch`/`geoEpoch` in
  `normalizeDesktopInputEvent`, and do not add `input_reset` to `desktopInputTypes`.
- **Worker invariants:**
  - `inputOrder` is touched only under `SafeInput.orderMu`.
    - The worker judges events under it.
    - A reset trigger moves the epochs under it, on the trigger's own goroutine.
  - The drop counters, `heldInput`, `discardBelow` and `lastResync` are worker-only.
  - Epochs are published to other goroutines through atomics.
  - Geometry transitions (monitor switch, desktop switch) are serialised by `Session.geometryMu`.
    The lock order is `geometryMu` → `Session.mu`.
  - The worker never calls into `Session` synchronously: hooks only spawn goroutines.
  - No `Session.mu` is held while waiting on the worker.
- **No-strand invariant (the core safety property).** An ordering-layer drop must never leave a key
  or button held. Every transition that starts dropping a class of events first releases everything
  held, in the same worker job. See the proof table in "Race and concurrency analysis".
- **Logging:**
  - Never log key names, typed text, or event payloads above `Debug`.
  - Drops are logged at `Debug` with a reason constant.
  - Resets are logged at `Info` with reason, epoch and count.
  - Reasons are fixed strings, never viewer-supplied.
- **No new policy knobs, no new dependencies.**

## Review Focus

These are the inputs and conditions most likely to bite an operator that no task's main-path test
would naturally hit. Each has its test pinned in the owning task.

1. **A discrete event the agent cannot accept.** Examples: a W3 viewer sends a scroll delta beyond
   the clamp, or a field with the wrong JSON type. Expected: the pointer keeps moving; the next move
   is not frozen waiting for a `seq` that will never be injected. → Task 5,
   `TestRejectedInputREventDoesNotFreezeThePointer`.
2. **An old viewer across every reset trigger** (monitor switch, peer disconnect, channel close).
   Expected: input keeps working with no `input_reset`; nothing is gated. → Task 4
   `TestSafeInputLegacyInputIsNeverGatedByAReset`, Task 7
   `TestLegacyViewerKeepsWorkingAcrossEveryReset`.
3. **The `input_epoch` announcement is lost**, for example sent while ICE was disconnected.
   Expected: the viewer's next stale event makes the agent announce again, rate-limited, so input
   recovers. → Task 4 `TestSafeInputAsksForResyncAtMostOncePerInterval`.
4. **A superseded channel's `OnClose` fires late**, after the viewer has re-handshaken on its
   replacement. Expected: no second reset; input on the new channel keeps flowing. → Task 6
   `TestSupersededChannelClosingLateDoesNotResetAgain`.
5. **The WS relay starts forwarding `seq`** in some future edit. Expected: WS sessions must never
   become sequenced. They have no `input_reset` path, so they would be gated forever. → Task 1
   `TestNormalizeDesktopInputEventDropsOrderingFields`.

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `agent/internal/remote/desktop/input.go` | modify | `InputEvent` gains `Seq`, `After`, `Epoch`, `GeoEpoch` |
| `agent/internal/remote/desktop/input_validate.go` | modify | `input_reset` type; seq range; `after < seq` |
| `agent/internal/remote/desktop/input_order.go` | **create** | Pure ordering state machine `inputOrder` |
| `agent/internal/remote/desktop/input_order_test.go` | **create** | Table tests for `inputOrder` |
| `agent/internal/remote/desktop/input_safe.go` | modify | Barrier-gated move slot, ordered discrete jobs, `SkipSeq`, `orderMu`, synchronous epoch bumps, generation-tagged jobs, `ResetGeometry`, hooks, resync |
| `agent/internal/remote/desktop/input_safe_order_test.go` | **create** | Worker-level ordering and epoch tests |
| `agent/internal/remote/desktop/session.go` | modify | `Session` gains `viewerChannels`, `inputRAttached`, `geometryMu` |
| `agent/internal/remote/desktop/session_control.go` | modify | `input-r` routing, channel rules, idle, capabilities; `switchMonitor` extracted and serialised |
| `agent/internal/remote/desktop/session_input.go` | modify | Channel attach/close, epoch announcements, hooks, geometry reset |
| `agent/internal/remote/desktop/session_webrtc.go` | modify | `OnDataChannel` wiring for `input-r`; hooks at construction |
| `agent/internal/remote/desktop/session_capture.go` | modify | `handleDesktopSwitch` becomes a serialised geometry transition |
| `agent/internal/remote/desktop/session_desktop_switch_test.go` | modify | desktop switch moves the geometry epoch |
| `agent/internal/remote/desktop/session_input_reliable_test.go` | **create** | Session-level routing, lifecycle and compat tests |
| `agent/internal/heartbeat/desktop_validation_test.go` | modify | WS relay guard |

`input_safe.go` is 339 lines at W2a HEAD and grows to about 470. That is cohesive (one worker). The
pure decision logic lives in `input_order.go` so it is testable without goroutines.

---

### Task 1: Ordering fields on `InputEvent` and their validation

**Files:**
- Modify: `agent/internal/remote/desktop/input.go:4-20` (struct `InputEvent`)
- Modify: `agent/internal/remote/desktop/input_validate.go:12-22,29-57`
- Test: `agent/internal/remote/desktop/input_validate_test.go` (append cases to `TestValidateInputEvent`, line 8)
- Test: `agent/internal/heartbeat/desktop_validation_test.go` (new test next to `TestNormalizeDesktopInputEventCarriesCapsLockState`, line 131)

**Interfaces:**
- Produces:
  - `InputEvent.Seq uint64`, `InputEvent.After uint64`, `InputEvent.Epoch uint32` and
    `InputEvent.GeoEpoch uint32`. The JSON keys are `seq`, `after`, `epoch`, `geoEpoch`, all
    `omitempty`.
  - `const MaxInputSeq = 1<<53 - 1`.
  - `ValidateInputEvent` accepts `"input_reset"`.

- [ ] **Step 1: Write the failing tests**

Append to the `cases` slice in `TestValidateInputEvent` (`input_validate_test.go`):

```go
		{"input_reset ok", InputEvent{Type: "input_reset", Seq: 1, Epoch: 1}, false},
		{"input_reset needs seq", InputEvent{Type: "input_reset", Epoch: 1}, true},
		{"input_reset needs epoch", InputEvent{Type: "input_reset", Seq: 1}, true},
		{"sequenced move ok", InputEvent{Type: "mouse_move", Seq: 5, After: 4}, false},
		{"sequenced move before any discrete event ok", InputEvent{Type: "mouse_move", Seq: 1, After: 0}, false},
		{"move cannot depend on a later event", InputEvent{Type: "mouse_move", Seq: 5, After: 5}, true},
		{"seq beyond a JS safe integer", InputEvent{Type: "key_down", Key: "a", Seq: MaxInputSeq + 1}, true},
		{"after beyond a JS safe integer", InputEvent{Type: "mouse_move", Seq: 1, After: MaxInputSeq + 1}, true},
```

Note: the last case also fails `after < seq`. Either error is fine; it must be rejected.

Add to `agent/internal/heartbeat/desktop_validation_test.go`:

```go
// The WS relay must keep stripping the W2b ordering fields. A WS session has no
// input_reset path, so if seq crossed the relay the agent would treat the
// session as sequenced and gate its input forever.
func TestNormalizeDesktopInputEventDropsOrderingFields(t *testing.T) {
	t.Parallel()

	event, err := normalizeDesktopInputEvent(map[string]any{
		"type": "key_down", "key": "a",
		"seq": float64(7), "after": float64(6), "epoch": float64(3), "geoEpoch": float64(2),
	})
	if err != nil {
		t.Fatalf("normalizeDesktopInputEvent error = %v", err)
	}
	if event.Seq != 0 || event.After != 0 || event.Epoch != 0 || event.GeoEpoch != 0 {
		t.Fatalf("relay forwarded ordering fields: %+v", event)
	}
	if _, err := normalizeDesktopInputEvent(map[string]any{"type": "input_reset", "seq": float64(1), "epoch": float64(1)}); err == nil {
		t.Fatal("relay accepted input_reset; the WS transport has no sequenced protocol")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/remote/desktop/ -run TestValidateInputEvent -race && go test ./internal/heartbeat/ -run TestNormalizeDesktopInputEventDropsOrderingFields -race`
Expected: both FAIL to compile with `unknown field Seq in struct literal` / `event.Seq undefined`.

- [ ] **Step 3: Implement**

In `input.go`, append inside `InputEvent` after `CapsLock`:

```go
	// W2b ordering fields (spec §1–2). All zero for viewers that predate them.
	// A zero Seq means "legacy": the event is handled exactly as before W2b
	// (see inputOrder). The WebSocket relay (heartbeat/handlers_desktop.go)
	// rebuilds events field by field and deliberately does not copy these, so WS
	// input always stays legacy.
	Seq      uint64 `json:"seq,omitempty"`      // per-session, strictly increasing across both channels
	After    uint64 `json:"after,omitempty"`    // mouse_move only: seq of the last discrete event sent before it
	Epoch    uint32 `json:"epoch,omitempty"`    // reset epoch the viewer believes is current
	GeoEpoch uint32 `json:"geoEpoch,omitempty"` // geometry epoch from the last monitor_switched
```

In `input_validate.go`, add to the `const` block:

```go
	// MaxInputSeq is the largest integer a JavaScript number holds exactly.
	// A larger seq cannot have come from a well-behaved viewer.
	MaxInputSeq = 1<<53 - 1
```

Add `"input_reset": {},` to `validInputTypes`. In `ValidateInputEvent`, directly before the final
`return nil`, add:

```go
	if ev.Seq > MaxInputSeq || ev.After > MaxInputSeq {
		return fmt.Errorf("sequence out of range")
	}
	switch ev.Type {
	case "input_reset":
		if ev.Seq == 0 || ev.Epoch == 0 {
			return fmt.Errorf("input_reset requires seq and epoch")
		}
	case "mouse_move":
		if ev.Seq > 0 && ev.After >= ev.Seq {
			return fmt.Errorf("move cannot depend on a later event")
		}
	}
```

Do not touch `heartbeat/handlers_desktop.go`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ ./internal/heartbeat/ -race`
Expected: PASS. All existing tests are still green.

- [ ] **Step 5: Check that the WS guard can fail**

The heartbeat test passes as soon as it compiles, so prove it can fail.
1. Temporarily add `event.Seq = 1` after `event.CapsLock = capsLock` in `normalizeDesktopInputEvent`.
2. Re-run `go test ./internal/heartbeat/ -run TestNormalizeDesktopInputEventDropsOrderingFields`.
   Expected: FAIL.
3. Revert the edit. Check with `git diff --stat agent/internal/heartbeat/handlers_desktop.go`: no
   output.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/remote/desktop/input.go agent/internal/remote/desktop/input_validate.go \
  agent/internal/remote/desktop/input_validate_test.go agent/internal/heartbeat/desktop_validation_test.go
git commit -m "feat(agent): input events carry seq, after and reset/geometry epochs (#8246)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `inputOrder` — the pure ordering state machine

**Files:**
- Create: `agent/internal/remote/desktop/input_order.go`
- Create: `agent/internal/remote/desktop/input_order_test.go`

**Interfaces:**
- Consumes: the `InputEvent` fields from Task 1.
- Produces (all unexported; callers serialise access — SafeInput uses `orderMu`):
  - `type inputOrder struct { v2, awaitingReset bool; resetEpoch, geoEpoch uint32; lastDiscrete, lastMove uint64 }`
  - `func newInputOrder() *inputOrder`: starts at epochs 1/1, `awaitingReset: true`.
  - `func (o *inputOrder) discrete(ev InputEvent) (orderVerdict, string)`
  - `func (o *inputOrder) move(ev InputEvent) (moveVerdict, string)`
  - `func (o *inputOrder) skip(seq uint64)`
  - `func (o *inputOrder) agentReset(geometry bool)`
  - `type orderVerdict int` with `orderInject`, `orderDrop`, `orderAcceptReset`
  - `type moveVerdict int` with `moveReady`, `moveWait`, `moveStale`
  - Drop-reason constants: `dropLegacyAfterV2`, `dropDuplicateSeq`, `dropStaleEpoch`,
    `dropAwaitingReset`, `dropStaleGeometry`, `dropBehindBarrier`, `dropOlderMove`,
    `dropInvalidReset`
  - `func resyncNeeded(reason string) bool`
  - `func isPointerEvent(eventType string) bool`

- [ ] **Step 1: Write the failing tests**

`agent/internal/remote/desktop/input_order_test.go`:

```go
package desktop

import (
	"math"
	"testing"
)

func oKey(seq uint64, epoch uint32) InputEvent {
	return InputEvent{Type: "key_down", Key: "a", Seq: seq, Epoch: epoch}
}
func oReset(seq uint64, epoch uint32) InputEvent {
	return InputEvent{Type: "input_reset", Seq: seq, Epoch: epoch}
}
func oDown(seq uint64, geo uint32) InputEvent {
	return InputEvent{Type: "mouse_down", Seq: seq, Epoch: 1, GeoEpoch: geo}
}
func oMove(seq, after uint64) InputEvent {
	return InputEvent{Type: "mouse_move", Seq: seq, After: after, Epoch: 1, GeoEpoch: 1}
}

func wantDiscrete(t *testing.T, o *inputOrder, ev InputEvent, want orderVerdict, wantReason string) {
	t.Helper()
	got, reason := o.discrete(ev)
	if got != want || reason != wantReason {
		t.Fatalf("discrete(%+v) = (%v, %q), want (%v, %q)", ev, got, reason, want, wantReason)
	}
}

func wantMove(t *testing.T, o *inputOrder, ev InputEvent, want moveVerdict, wantReason string) {
	t.Helper()
	got, reason := o.move(ev)
	if got != want || reason != wantReason {
		t.Fatalf("move(%+v) = (%v, %q), want (%v, %q)", ev, got, reason, want, wantReason)
	}
}

func TestInputOrderLegacyBeforeHandshakeIsInjected(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, InputEvent{Type: "key_down", Key: "a"}, orderInject, "")
	wantMove(t, o, InputEvent{Type: "mouse_move", X: 1}, moveReady, "")
	o.agentReset(false) // an old viewer is never gated
	wantDiscrete(t, o, InputEvent{Type: "key_down", Key: "a"}, orderInject, "")
}

func TestInputOrderSequencedInputNeedsTheHandshake(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oKey(1, 1), orderDrop, dropAwaitingReset)
	wantDiscrete(t, o, oReset(2, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(3, 1), orderInject, "")
}

func TestInputOrderStaleHandshakeIsRefused(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 2), orderDrop, dropStaleEpoch)
	wantDiscrete(t, o, oKey(2, 1), orderDrop, dropAwaitingReset)
}

func TestInputOrderUnsequencedInputResetIsInvalid(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, InputEvent{Type: "input_reset", Epoch: 1}, orderDrop, dropInvalidReset)
}

func TestInputOrderLegacyAfterHandshakeIsDropped(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, InputEvent{Type: "key_up", Key: "a"}, orderDrop, dropLegacyAfterV2)
	wantMove(t, o, InputEvent{Type: "mouse_move", X: 1}, moveStale, dropLegacyAfterV2)
}

func TestInputOrderDuplicateOrReorderedSeqIsDropped(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(3, 1), orderInject, "")
	wantDiscrete(t, o, oKey(2, 1), orderDrop, dropDuplicateSeq)
	wantDiscrete(t, o, oKey(3, 1), orderDrop, dropDuplicateSeq)
}

func TestInputOrderAgentResetGatesUntilAcknowledged(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	o.agentReset(false)
	if o.resetEpoch != 2 || !o.awaitingReset {
		t.Fatalf("after agentReset: epoch=%d awaiting=%v", o.resetEpoch, o.awaitingReset)
	}
	wantDiscrete(t, o, oKey(2, 1), orderDrop, dropAwaitingReset)
	wantDiscrete(t, o, oReset(3, 1), orderDrop, dropStaleEpoch)
	wantDiscrete(t, o, oReset(4, 2), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(5, 1), orderDrop, dropStaleEpoch)
	wantDiscrete(t, o, oKey(6, 2), orderInject, "")
}

func TestInputOrderViewerResetDoesNotBumpTheEpoch(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oReset(2, 1), orderAcceptReset, "")
	if o.resetEpoch != 1 || o.awaitingReset {
		t.Fatalf("viewer reset changed agent state: epoch=%d awaiting=%v", o.resetEpoch, o.awaitingReset)
	}
}

func TestInputOrderGeometryResetDropsOldCoordinatesOnly(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	o.agentReset(true)
	if o.resetEpoch != 2 || o.geoEpoch != 2 {
		t.Fatalf("geometry reset: epoch=%d geo=%d", o.resetEpoch, o.geoEpoch)
	}
	wantDiscrete(t, o, oReset(2, 2), orderAcceptReset, "")
	stale := InputEvent{Type: "mouse_down", Seq: 3, Epoch: 2, GeoEpoch: 1}
	wantDiscrete(t, o, stale, orderDrop, dropStaleGeometry)
	wantDiscrete(t, o, InputEvent{Type: "key_down", Key: "a", Seq: 4, Epoch: 2, GeoEpoch: 1}, orderInject, "")
	wantDiscrete(t, o, InputEvent{Type: "mouse_down", Seq: 5, Epoch: 2, GeoEpoch: 2}, orderInject, "")
}

func TestInputOrderMoveBarrier(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oDown(3, 1), orderInject, "") // lastDiscrete = 3

	wantMove(t, o, oMove(5, 4), moveWait, "")              // depends on 4, not handled yet
	wantMove(t, o, oMove(4, 2), moveStale, dropBehindBarrier) // sent before 3
	wantMove(t, o, oMove(6, 3), moveReady, "")             // sent right after 3
	wantMove(t, o, oMove(6, 3), moveStale, dropOlderMove)  // already injected one at seq 6
	wantMove(t, o, oMove(5, 3), moveStale, dropOlderMove)  // arrived after a newer move
}

func TestInputOrderMoveGates(t *testing.T) {
	o := newInputOrder()
	// Waiting on the handshake itself: ready once it is handled.
	wantMove(t, o, oMove(2, 1), moveWait, "")
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantMove(t, o, oMove(2, 1), moveReady, "")

	o.agentReset(true) // epoch 2, geo 2, gate closed
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 3, After: 1, Epoch: 1, GeoEpoch: 1}, moveStale, dropStaleEpoch)
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 4, After: 1, Epoch: 2, GeoEpoch: 1}, moveStale, dropStaleGeometry)
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 5, After: 1, Epoch: 2, GeoEpoch: 2}, moveStale, dropAwaitingReset)
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 7, After: 6, Epoch: 2, GeoEpoch: 2}, moveWait, "") // waits for the re-handshake
	wantDiscrete(t, o, oReset(6, 2), orderAcceptReset, "")
	wantMove(t, o, InputEvent{Type: "mouse_move", Seq: 7, After: 6, Epoch: 2, GeoEpoch: 2}, moveReady, "")
}

// Review amendment R2: a move whose barrier is a discrete event the reset
// discarded must be dropped (and so ask for a resync), not wait forever.
func TestInputOrderStaleEpochMoveDoesNotWaitOnADiscardedBarrier(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantDiscrete(t, o, oKey(2, 1), orderInject, "")
	o.agentReset(false) // discrete event 3 was queued and is discarded by the reset
	wantMove(t, o, oMove(4, 3), moveStale, dropStaleEpoch)
	if !resyncNeeded(dropStaleEpoch) {
		t.Fatal("a stale-epoch move must ask for a resync")
	}
}

func TestInputOrderSkipAdvancesTheBarrier(t *testing.T) {
	o := newInputOrder()
	wantDiscrete(t, o, oReset(1, 1), orderAcceptReset, "")
	wantMove(t, o, oMove(3, 2), moveWait, "")
	o.skip(2)
	wantMove(t, o, oMove(3, 2), moveReady, "")
	o.skip(1) // never moves backwards
	if o.lastDiscrete != 2 {
		t.Fatalf("lastDiscrete = %d, want 2", o.lastDiscrete)
	}
}

func TestInputOrderEpochsNeverWrapToZero(t *testing.T) {
	o := newInputOrder()
	o.resetEpoch, o.geoEpoch = math.MaxUint32, math.MaxUint32
	o.agentReset(true)
	if o.resetEpoch != 1 || o.geoEpoch != 1 {
		t.Fatalf("wrapped to %d/%d; 0 means 'absent' on the wire", o.resetEpoch, o.geoEpoch)
	}
}

func TestResyncNeeded(t *testing.T) {
	for reason, want := range map[string]bool{
		dropStaleEpoch: true, dropAwaitingReset: true,
		dropStaleGeometry: false, dropBehindBarrier: false, dropDuplicateSeq: false,
		dropLegacyAfterV2: false, dropOlderMove: false, dropInvalidReset: false,
	} {
		if got := resyncNeeded(reason); got != want {
			t.Errorf("resyncNeeded(%q) = %v, want %v", reason, got, want)
		}
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestInputOrder|TestResyncNeeded' -race`
Expected: FAIL to compile with `undefined: newInputOrder`.

- [ ] **Step 3: Implement**

`agent/internal/remote/desktop/input_order.go`:

```go
package desktop

// inputOrder is the W2b ordering state for one session (spec §1–2). For every
// event the worker is about to inject, it decides whether to inject it, drop it
// or (for a move) hold it until the discrete event it depends on has been
// handled.
//
// The protocol in brief:
//   - Events with Seq == 0 are legacy and behave exactly as before W2b, until
//     the session's first accepted input_reset. After that they are dropped.
//   - A sequenced stream opens with input_reset{epoch}. Sequenced input before
//     it is dropped (awaitingReset).
//   - Every agent-side reset bumps resetEpoch and closes the gate again, so a
//     press sent before the reset cannot re-latch a key after it.
//   - A move carries After, the seq of the last discrete event the viewer sent
//     before it. It waits while After > lastDiscrete and is stale once
//     After < lastDiscrete. lastDiscrete advances for every discrete seq
//     handled, whatever its fate, so a rejected event cannot freeze the pointer.
//
// It is not safe for concurrent use. SafeInput serialises every call with
// orderMu: the worker judges events, and a reset trigger calls agentReset from
// its own goroutine, so the epoch moves the instant the trigger fires, even if
// the worker is wedged (review amendment R1).
type inputOrder struct {
	v2            bool   // latched by the first accepted input_reset
	awaitingReset bool   // sequenced input is dropped until input_reset{resetEpoch}
	resetEpoch    uint32 // never 0: 0 means "absent" on the wire
	geoEpoch      uint32 // never 0
	lastDiscrete  uint64 // highest discrete seq handled (injected, dropped, rejected or skipped)
	lastMove      uint64 // highest move seq judged ready
}

type orderVerdict int

const (
	orderInject      orderVerdict = iota
	orderDrop                     // not injected; the reason says why
	orderAcceptReset              // input_reset accepted: release held input, in order
)

type moveVerdict int

const (
	moveReady moveVerdict = iota
	moveWait              // barrier not met yet; keep it in the slot
	moveStale             // never inject
)

// Drop reasons. Fixed strings: logged and counted, never viewer content.
const (
	dropLegacyAfterV2 = "legacy_after_v2"
	dropDuplicateSeq  = "duplicate_seq"
	dropStaleEpoch    = "stale_epoch"
	dropAwaitingReset = "awaiting_reset"
	dropStaleGeometry = "stale_geometry"
	dropBehindBarrier = "behind_barrier"
	dropOlderMove     = "older_move"
	dropInvalidReset  = "invalid_reset"
)

func newInputOrder() *inputOrder {
	return &inputOrder{awaitingReset: true, resetEpoch: 1, geoEpoch: 1}
}

// isPointerEvent reports whether the event's coordinates are used, and so
// whether it must carry the current geometry epoch.
func isPointerEvent(eventType string) bool {
	switch eventType {
	case "mouse_move", "mouse_click", "mouse_down", "mouse_up", "mouse_scroll":
		return true
	}
	return false
}

// resyncNeeded reports whether a drop means the viewer holds a stale reset
// epoch and should be told the current one (input_epoch).
func resyncNeeded(reason string) bool {
	return reason == dropStaleEpoch || reason == dropAwaitingReset
}

// discrete judges every event type except mouse_move. For sequenced events it
// advances lastDiscrete first, so a dropped event still moves the barrier.
func (o *inputOrder) discrete(ev InputEvent) (orderVerdict, string) {
	if ev.Seq == 0 {
		if ev.Type == "input_reset" {
			return orderDrop, dropInvalidReset
		}
		if o.v2 {
			return orderDrop, dropLegacyAfterV2
		}
		return orderInject, ""
	}
	if ev.Seq <= o.lastDiscrete {
		return orderDrop, dropDuplicateSeq
	}
	o.lastDiscrete = ev.Seq
	if ev.Type == "input_reset" {
		if ev.Epoch != o.resetEpoch {
			return orderDrop, dropStaleEpoch
		}
		o.v2 = true
		o.awaitingReset = false
		return orderAcceptReset, ""
	}
	if o.awaitingReset {
		return orderDrop, dropAwaitingReset
	}
	if ev.Epoch != o.resetEpoch {
		return orderDrop, dropStaleEpoch
	}
	if isPointerEvent(ev.Type) && ev.GeoEpoch != o.geoEpoch {
		return orderDrop, dropStaleGeometry
	}
	return orderInject, ""
}

// move judges a pending mouse_move. A ready verdict records the move's seq, so
// the caller must inject it.
//
// The epoch and geometry checks come BEFORE the barrier wait (review amendment
// R2). A reset discards queued discrete events without advancing lastDiscrete,
// so a pre-reset move can carry an After that will never be reached. If it
// waited, it would never be dropped, never ask for a resync, and a viewer that
// only moves the mouse would never learn the new epoch. A move with the CURRENT
// epoch still waits; that is how moves sent right after a handshake wait for it.
func (o *inputOrder) move(ev InputEvent) (moveVerdict, string) {
	if ev.Seq == 0 {
		if o.v2 {
			return moveStale, dropLegacyAfterV2
		}
		return moveReady, ""
	}
	if ev.Seq <= o.lastMove {
		return moveStale, dropOlderMove
	}
	if ev.Epoch != o.resetEpoch {
		return moveStale, dropStaleEpoch
	}
	if ev.GeoEpoch != o.geoEpoch {
		return moveStale, dropStaleGeometry
	}
	if ev.After > o.lastDiscrete {
		return moveWait, ""
	}
	if ev.After < o.lastDiscrete {
		return moveStale, dropBehindBarrier
	}
	if o.awaitingReset {
		return moveStale, dropAwaitingReset
	}
	o.lastMove = ev.Seq
	return moveReady, ""
}

// skip advances the barrier past a discrete seq that never reached discrete()
// (rejected before the worker). It never moves the barrier backwards.
func (o *inputOrder) skip(seq uint64) {
	if seq > o.lastDiscrete {
		o.lastDiscrete = seq
	}
}

// agentReset starts a new reset epoch and closes the gate. With geometry, it
// also starts a new geometry epoch in the same step. A geometry change always
// comes with a reset, so a press made under the old geometry has already been
// released before its old-geometry release starts being dropped.
func (o *inputOrder) agentReset(geometry bool) {
	o.resetEpoch = nextEpoch(o.resetEpoch)
	if geometry {
		o.geoEpoch = nextEpoch(o.geoEpoch)
	}
	o.awaitingReset = true
}

func nextEpoch(e uint32) uint32 {
	e++
	if e == 0 {
		e = 1
	}
	return e
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestInputOrder|TestResyncNeeded' -race -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/input_order.go agent/internal/remote/desktop/input_order_test.go
git commit -m "feat(agent): pure ordering state machine for sequenced desktop input (#8246)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `SafeInput` honours the barrier (`seq`/`after`) and accepts `input_reset`

**Files:**
- Modify: `agent/internal/remote/desktop/input_safe.go`:
  - struct at 35-52; `NewSafeInput` 61-75; wake branch 95-103; `submit` 172-206; `sync` 221;
    `HandleEvent` 225-242; `ReleaseAll` 248-266
- Create: `agent/internal/remote/desktop/input_safe_order_test.go`

**Interfaces:**
- Consumes: `inputOrder` (Task 2).
- Produces:
  - `var errInputDropped`: returned by `HandleEvent` for an event the ordering layer dropped.
    Callers treat it as expected, like `errInputReset`.
  - `func (s *SafeInput) SkipSeq(seq uint64)`: moves the barrier past a discrete seq that was
    rejected before the worker. Synchronous.
  - `func (s *SafeInput) droppedCount(reason string) uint64`: test helper, runs on the worker.
  - Internal: `orderMu sync.Mutex`, `order *inputOrder`, `judgeDiscrete`, `judgeMove`,
    `skipOrder`, `drops map[string]uint64`, `flushMove()`, `offerMove(ev)`,
    `takeLegacyMove()`, `injectDiscrete(ev)`, `releaseHeld(reason)`, `noteDrop(reason)`,
    `submitJob(urgent, flushLegacyMove bool, timeout, run)`.

**Why `submit`'s move flush must not apply to sequenced events.** At `input_safe.go:188-194`,
`submit` enqueues a pending move ahead of each discrete event. That is right when both share one
ordered channel (legacy). It is wrong across two channels. A move that *arrived* before a
`mouse_down` may have been *sent* after it: the move overtook the press, which was still
retransmitting. Sequenced events are therefore ordered by arithmetic on the worker:
- A move with `after == lastDiscrete` was sent before the next discrete event. It is injected
  before that event.
- A move with `after == S` is injected right after `S`.

Both checks run inside each sequenced discrete job, as a pre-flush and a post-flush. Legacy events
keep W2a's arrival-order flush exactly.

- [ ] **Step 1: Write the failing tests**

`agent/internal/remote/desktop/input_safe_order_test.go`:

```go
package desktop

import (
	"errors"
	"reflect"
	"testing"
	"time"
)

func seqEv(typ string, seq uint64) InputEvent {
	return InputEvent{Type: typ, Seq: seq, Epoch: 1, GeoEpoch: 1}
}

func seqKey(typ, key string, seq uint64) InputEvent {
	ev := seqEv(typ, seq)
	ev.Key = key
	return ev
}

func seqMove(x int, seq, after uint64) InputEvent {
	ev := seqEv("mouse_move", seq)
	ev.X, ev.Y, ev.After = x, x, after
	return ev
}

func seqDown(x int, seq uint64) InputEvent {
	ev := seqEv("mouse_down", seq)
	ev.X, ev.Y, ev.Button = x, x, "left"
	return ev
}

// handshake opens a sequenced stream the way a W3 viewer does. With nothing
// held it injects nothing, so it does not touch a blocking recorder.
func handshake(t *testing.T, s *SafeInput, seq uint64, epoch uint32) {
	t.Helper()
	if err := s.HandleEvent(InputEvent{Type: "input_reset", Seq: seq, Epoch: epoch}); err != nil {
		t.Fatalf("input_reset seq=%d epoch=%d: %v", seq, epoch, err)
	}
}

// wedgeSeq parks the worker inside the platform handler on a sequenced key_down.
func wedgeSeq(t *testing.T, s *SafeInput, inner *workerRecorder, key string, seq uint64) {
	t.Helper()
	go func() { _ = s.HandleEvent(seqKey("key_down", key, seq)) }()
	select {
	case <-inner.entered:
	case <-time.After(2 * time.Second):
		t.Fatal("worker never reached the platform handler")
	}
}

func wantCalls(t *testing.T, inner *workerRecorder, want []string) {
	t.Helper()
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputSequencedMoveSentBeforeADiscreteEventGoesFirst(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	wedgeSeq(t, s, inner, "x", 2)
	_ = s.HandleEvent(seqMove(5, 3, 2)) // sent after key x, before the press
	downDone := make(chan error, 1)
	go func() { downDone <- s.HandleEvent(seqDown(9, 4)) }()
	waitFor(t, "the mouse_down to queue", func() bool { return len(s.jobs) == 1 })
	close(inner.block)
	if err := <-downDone; err != nil {
		t.Fatal(err)
	}

	wantCalls(t, inner, []string{"key_down:x", "mouse_move:5,5:", "mouse_down:9,9:left"})
}

// The bug the barrier exists for (spec §1): the press was retransmitting on
// input-r while a newer move on the lossy channel arrived first.
func TestSafeInputSequencedMoveThatOvertookAPressWaitsForIt(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	wedgeSeq(t, s, inner, "x", 2)
	_ = s.HandleEvent(seqMove(5, 4, 3)) // sent after mouse_down 3, arrived before it
	downDone := make(chan error, 1)
	go func() { downDone <- s.HandleEvent(seqDown(9, 3)) }()
	waitFor(t, "the mouse_down to queue", func() bool { return len(s.jobs) == 1 })
	close(inner.block)
	if err := <-downDone; err != nil {
		t.Fatal(err)
	}

	wantCalls(t, inner, []string{"key_down:x", "mouse_down:9,9:left", "mouse_move:5,5:"})
}

func TestSafeInputDropsAMoveOlderThanTheLastDiscreteEvent(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	if err := s.HandleEvent(seqDown(9, 3)); err != nil {
		t.Fatal(err)
	}
	_ = s.HandleEvent(seqMove(5, 2, 1)) // sent before the press, arrived after it
	s.sync()

	wantCalls(t, inner, []string{"mouse_down:9,9:left"})
	if n := s.droppedCount(dropBehindBarrier); n != 1 {
		t.Fatalf("behind_barrier drops = %d, want 1", n)
	}
}

func TestSafeInputKeepsOnlyTheNewestSequencedMove(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	_ = s.HandleEvent(seqMove(5, 5, 1))
	s.sync()
	_ = s.HandleEvent(seqMove(4, 4, 1)) // older, delivered late
	s.sync()

	wantCalls(t, inner, []string{"mouse_move:5,5:"})
}

func TestSafeInputSkippedSeqReleasesAWaitingMove(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	_ = s.HandleEvent(seqMove(5, 3, 2)) // waits for discrete event 2
	s.sync()
	wantCalls(t, inner, nil)

	s.SkipSeq(2) // event 2 was rejected before it reached the worker
	wantCalls(t, inner, []string{"mouse_move:5,5:"})
}

func TestSafeInputDropsUnsequencedInputOnceSequenced(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "a"}); !errors.Is(err, errInputDropped) {
		t.Fatalf("legacy key_down after handshake: err=%v, want errInputDropped", err)
	}
	_ = s.HandleEvent(InputEvent{Type: "mouse_move", X: 1, Y: 1})
	s.sync()
	wantCalls(t, inner, nil)
}

// input_reset from the viewer releases what is held behind the events sent
// before it, not ahead of them.
func TestSafeInputViewerResetReleasesInOrder(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	for _, ev := range []InputEvent{seqKey("key_down", "shift", 2), seqKey("key_down", "a", 3)} {
		if err := s.HandleEvent(ev); err != nil {
			t.Fatal(err)
		}
	}
	handshake(t, s, 4, 1)
	if err := s.HandleEvent(seqKey("key_down", "b", 5)); err != nil {
		t.Fatalf("input after a viewer reset was gated: %v", err)
	}

	wantCalls(t, inner, []string{"key_down:shift", "key_down:a", "key_up:a", "key_up:shift", "key_down:b"})
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestSafeInputSequenced|TestSafeInputDrops|TestSafeInputKeepsOnly|TestSafeInputSkipped|TestSafeInputViewerReset' -race`
Expected: FAIL to compile with `undefined: errInputDropped` / `s.SkipSeq undefined` /
`s.droppedCount undefined`.

- [ ] **Step 3: Implement**

In `input_safe.go`:

(a) Add to the `var` block (line 10-13):

```go
	errInputDropped = errors.New("input dropped by the ordering layer")
```

(b) Add to `SafeInput` (after `held *heldInput`, line 51):

```go
	// orderMu guards order. The worker judges events under it; Task 4's resets
	// bump the epochs under it from the trigger's own goroutine. Lock order:
	// moveMu, then orderMu. Never held while injecting or waiting.
	orderMu sync.Mutex
	order   *inputOrder
	drops   map[string]uint64 // worker goroutine only; keyed by drop reason
```

and initialise them in `NewSafeInput`: `order: newInputOrder(), drops: map[string]uint64{},`.
Add the locked accessors:

```go
func (s *SafeInput) judgeDiscrete(ev InputEvent) (orderVerdict, string) {
	s.orderMu.Lock()
	defer s.orderMu.Unlock()
	return s.order.discrete(ev)
}

func (s *SafeInput) judgeMove(ev InputEvent) (moveVerdict, string) {
	s.orderMu.Lock()
	defer s.orderMu.Unlock()
	return s.order.move(ev)
}

func (s *SafeInput) skipOrder(seq uint64) {
	s.orderMu.Lock()
	defer s.orderMu.Unlock()
	s.order.skip(seq)
}
```

(c) Replace the wake branch body (lines 95-103) with:

```go
		case <-s.wake:
			// A legacy pending move is older than every queued discrete job,
			// because a legacy submit flushes the move slot into the queue first.
			// A sequenced move is injected only once its barrier is met.
			s.runQueued()
			s.flushMove()
```

(d) Replace `takeMove` (158-164) and add the move-slot helpers:

```go
func (s *SafeInput) takeMove() *InputEvent {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	mv := s.pendingMove
	s.pendingMove = nil
	return mv
}

// takeLegacyMove takes the pending move only if it is unsequenced. A sequenced
// move is ordered by its seq/after on the worker, never by arrival.
func (s *SafeInput) takeLegacyMove() *InputEvent {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	mv := s.pendingMove
	if mv == nil || mv.Seq != 0 {
		return nil
	}
	s.pendingMove = nil
	return mv
}

// offerMove puts ev in the one-move slot. A newer move replaces an older one
// (coalescing). A sequenced move older than the one already held is ignored.
func (s *SafeInput) offerMove(ev InputEvent) {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	if ev.Seq > 0 && s.pendingMove != nil && s.pendingMove.Seq >= ev.Seq {
		return
	}
	s.pendingMove = &ev
}

// flushMove injects the pending move if it is ready, drops it if stale, and
// leaves it in the slot while it waits for its barrier. Worker goroutine only.
func (s *SafeInput) flushMove() {
	s.moveMu.Lock()
	mv := s.pendingMove
	if mv == nil {
		s.moveMu.Unlock()
		return
	}
	verdict, reason := s.judgeMove(*mv)
	if verdict == moveWait {
		s.moveMu.Unlock()
		return
	}
	s.pendingMove = nil
	s.moveMu.Unlock()
	if verdict == moveStale {
		s.noteDrop(reason)
		return
	}
	if err := s.inject(*mv); err != nil {
		slog.Debug("Mouse move injection failed", "session", s.label, "error", err.Error())
	}
}

// noteDrop counts an event the ordering layer dropped. Worker goroutine only.
func (s *SafeInput) noteDrop(reason string) {
	s.drops[reason]++
	slog.Debug("Dropped input event", "session", s.label, "reason", reason)
}

// droppedCount reports how many events were dropped for reason. For tests.
func (s *SafeInput) droppedCount(reason string) uint64 {
	var n uint64
	_ = s.submit(false, 0, func() error { n = s.drops[reason]; return nil })
	return n
}
```

(e) Split `submit` (172-206) so legacy flushing is explicit. Replace the whole function with:

```go
func (s *SafeInput) submit(urgent bool, timeout time.Duration, run func() error) error {
	return s.submitJob(urgent, !urgent, timeout, run)
}

// submitJob queues run and waits for its result. timeout bounds the whole call,
// queueing included: a wedged worker can leave a bounded queue full, and a
// release or Close must never wait on it forever. timeout 0 waits as long as
// the worker lives. flushLegacyMove keeps an unsequenced move that arrived
// before this job ahead of it (one ordered channel: arrival order is send order).
func (s *SafeInput) submitJob(urgent, flushLegacyMove bool, timeout time.Duration, run func() error) error {
	select {
	case <-s.done:
		return errInputClosed
	default:
	}
	var expire <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		expire = t.C
	}
	job := safeInputJob{run: run, result: make(chan error, 1)}
	q := s.jobs
	if urgent {
		q = s.urgent
	} else if flushLegacyMove {
		if mv := s.takeLegacyMove(); mv != nil {
			move := *mv
			if err := s.enqueue(q, safeInputJob{run: func() error { s.injectMoveNow(move); return nil }}, expire); err != nil {
				return err
			}
		}
	}
	if err := s.enqueue(q, job, expire); err != nil {
		return err
	}
	select {
	case err := <-job.result:
		return err
	case <-s.exited:
		return errInputClosed
	case <-expire:
		return errInputWorkerUnresponsive
	}
}

// injectMoveNow injects a move taken out of the slot, if the ordering layer
// still allows it. Worker goroutine only.
func (s *SafeInput) injectMoveNow(mv InputEvent) {
	verdict, reason := s.judgeMove(mv)
	if verdict != moveReady {
		s.noteDrop(reason)
		return
	}
	if err := s.inject(mv); err != nil {
		slog.Debug("Mouse move injection failed", "session", s.label, "error", err.Error())
	}
}
```

(f) Replace `sync` (221) so it also judges a waiting sequenced move deterministically:

```go
func (s *SafeInput) sync() {
	_ = s.submit(false, 0, func() error { s.flushMove(); return nil })
}
```

(g) Replace `HandleEvent` (225-242):

```go
// HandleEvent injects ev on the worker. Discrete events wait for the platform
// handler and return its error (errInputDropped when the ordering layer
// refused them); mouse_move returns immediately.
func (s *SafeInput) HandleEvent(ev InputEvent) error {
	if ev.Type == "mouse_move" {
		select {
		case <-s.done:
			return errInputClosed
		default:
		}
		s.offerMove(ev)
		select {
		case s.wake <- struct{}{}:
		default:
		}
		return nil
	}
	if ev.Seq == 0 {
		return s.submit(false, 0, func() error { return s.injectDiscrete(ev) })
	}
	return s.submitJob(false, false, 0, func() error { return s.injectDiscrete(ev) })
}

// injectDiscrete runs a discrete event through the ordering layer. A sequenced
// event flushes the move slot before and after it: before, a move whose barrier
// is the previous discrete event (sent before ev); after, a move that was
// waiting for ev itself. Legacy events never flush here: on one ordered
// channel, a move still in the slot arrived (and was sent) after them.
func (s *SafeInput) injectDiscrete(ev InputEvent) error {
	sequenced := ev.Seq > 0
	if sequenced {
		s.flushMove()
	}
	err := s.applyDiscrete(ev)
	if sequenced {
		s.flushMove()
	}
	return err
}

func (s *SafeInput) applyDiscrete(ev InputEvent) error {
	verdict, reason := s.judgeDiscrete(ev)
	switch verdict {
	case orderAcceptReset:
		s.releaseHeld("input_reset")
		return nil
	case orderDrop:
		s.noteDrop(reason)
		return errInputDropped
	}
	return s.inject(ev)
}

// SkipSeq moves the ordering barrier past a discrete seq that was rejected
// before it reached the worker (malformed, failed validation, wrong channel),
// in order with the jobs queued before it. Without this, a move that depends
// on the rejected event waits until the next key or click.
func (s *SafeInput) SkipSeq(seq uint64) {
	_ = s.submitJob(false, false, 0, func() error {
		s.flushMove()
		s.skipOrder(seq)
		s.flushMove()
		return nil
	})
}
```

(h) Extract the release body out of `ReleaseAll` (248-266):

```go
func (s *SafeInput) ReleaseAll(reason string) {
	err := s.submit(true, s.closeTimeout, func() error {
		s.discardQueued()
		s.takeMove()
		s.releaseHeld(reason)
		return nil
	})
	if err != nil && !errors.Is(err, errInputClosed) {
		slog.Warn("Releasing held remote input failed", "session", s.label, "reason", reason, "error", err.Error())
	}
}

// releaseHeld injects a release for everything held. Worker goroutine only.
func (s *SafeInput) releaseHeld(reason string) {
	releases := s.held.releases()
	for _, ev := range releases {
		if err := s.inner.HandleEvent(ev); err != nil {
			slog.Debug("Release injection failed", "session", s.label, "type", ev.Type, "error", err.Error())
		}
	}
	if len(releases) > 0 {
		slog.Info("Released held remote input", "session", s.label, "reason", reason, "count", len(releases))
	}
}
```

- [ ] **Step 4: Run the new tests and the whole W2a suite**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestSafeInput|TestInputOrder' -race -count=20`
Expected: PASS 20×. In particular, the W2a test
`TestSafeInputMovesCoalesceAndKeepOrderWithDiscreteEvents` (`input_safe_test.go:170`) is unchanged
and still green: legacy moves keep the arrival-order flush.

- [ ] **Step 5: Check that the overtaking test can fail**

1. Temporarily delete the line `if ev.After > o.lastDiscrete { return moveWait, "" }` in
   `inputOrder.move`. This bypasses the barrier, so a move that overtook a press is judged ready.
2. Run `-run TestSafeInputSequencedMoveThatOvertookAPressWaitsForIt`. Expected: FAIL on the call
   order: the move is injected at key `x`'s post-flush, before the press.
3. Revert.

(Review amendment R9. An earlier draft mutated `HandleEvent` instead. That queues two jobs, so the
test's `len(s.jobs) == 1` wait timed out before the order was checked, and `injectMoveNow` drops a
waiting move instead of injecting it.) `injectMoveNow` only ever sees legacy moves, because
`takeLegacyMove` takes nothing else, so its `moveWait` branch is unreachable in practice.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/remote/desktop/input_safe.go agent/internal/remote/desktop/input_safe_order_test.go
git commit -m "feat(agent): input worker orders sequenced moves behind the press they follow (#8246)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Reset and geometry epochs, announcement hooks, resync

**Files:**
- Modify: `agent/internal/remote/desktop/input_safe.go`:
  - `safeInputJob` 54-57; `loop`/`run` 77-113; `submitJob` (Task 3); `ReleaseAll` (Task 3);
    `discardQueued` 268-279 (deleted); `Close` 288-298; `noteDrop` (Task 3); struct; `NewSafeInput`
- Test: `agent/internal/remote/desktop/input_safe_order_test.go` (append)

**Interfaces:**
- Consumes: `inputOrder.agentReset(geometry)` and `resyncNeeded` (Task 2); `orderMu`,
  `releaseHeld` and `noteDrop` (Task 3).
- Produces:
  - `func (s *SafeInput) ReleaseAll(reason string)`. The reset epoch moves **synchronously**,
    under `orderMu`, before this returns, even if the worker is wedged. Then `onReset` fires, and an
    urgent worker job releases what is held.
  - `func (s *SafeInput) ResetGeometry(reason string)`. Same, and also moves the geometry epoch
    in the same `orderMu` critical section.
  - `func (s *SafeInput) Epochs() (reset, geo uint32)`. Safe from any goroutine.
  - `type safeInputHooks struct { onReset func(reason string); onResync func() }`
  - `func (s *SafeInput) SetHooks(h safeInputHooks)`. `onReset` runs on the goroutine that called
    the reset; `onResync` runs on the worker. Both must not block and must not call `SafeInput`.
  - `const inputResyncInterval = 500 * time.Millisecond`
  - field `now func() time.Time`. Defaults to `time.Now`; tests may replace it before the first
    submit.
  - Internal:
    - `resetGen atomic.Uint64`: incremented once per reset.
    - `safeInputJob.gen uint64`: `resetGen` at submission.
    - `discardBelow uint64`: worker-only.

**Why the epoch moves at the trigger, not in the worker job (review amendments R1, R1b).**
- **R1.** An earlier draft bumped the epochs inside the urgent release job. If the worker was
  wedged, for example typing a long `type_text` paste, `ResetGeometry` timed out before the bump.
  `monitor_switched` then announced the old `geoEpoch`. The late job bumped it afterwards, and the
  viewer's pointer was dropped as stale-geometry for good.
- Now the bump happens before `ResetGeometry` returns. Linearisation still holds:
  - The worker judges every event under `orderMu`. An event judged before the bump was pressed
    under the old epoch; the release job runs after its job (one worker) and releases it.
  - An event judged after the bump with the old epoch is dropped.
- **R1b.** W2a's eager `discardQueued` would also have discarded a handshake that arrived after
  the bump but was queued before the urgent release job ran. Instead, jobs are tagged with the
  reset generation at submission. The release job raises `discardBelow` to its own generation, and
  `run` answers older jobs with `errInputReset` when they are dequeued. Jobs submitted after the
  bump survive, in order.

- [ ] **Step 1: Write the failing tests**

Append to `input_safe_order_test.go` (add `"sync"` to the imports):

```go
func TestSafeInputReleaseAllStartsANewEpochAndGatesSequencedInput(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)
	if err := s.HandleEvent(seqKey("key_down", "shift", 2)); err != nil {
		t.Fatal(err)
	}

	s.ReleaseAll("peer_disconnected")
	if r, g := s.Epochs(); r != 2 || g != 1 {
		t.Fatalf("Epochs() = %d,%d want 2,1", r, g)
	}
	if err := s.HandleEvent(seqKey("key_down", "a", 3)); !errors.Is(err, errInputDropped) {
		t.Fatalf("pre-reset epoch accepted: %v", err)
	}
	handshake(t, s, 4, 2)
	ev := seqKey("key_down", "b", 5)
	ev.Epoch = 2
	if err := s.HandleEvent(ev); err != nil {
		t.Fatal(err)
	}

	wantCalls(t, inner, []string{"key_down:shift", "key_up:shift", "key_down:b"})
}

// The race the epoch exists for: a press queued before a reset, or a
// retransmitted one delivered after it, must not re-latch a key just released.
func TestSafeInputSequencedPressCannotOutliveAReset(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	wedgeSeq(t, s, inner, "x", 2)
	queued := make(chan error, 1)
	go func() { queued <- s.HandleEvent(seqKey("key_down", "y", 3)) }()
	waitFor(t, "y to queue", func() bool { return len(s.jobs) == 1 })
	released := make(chan struct{})
	go func() { s.ReleaseAll("peer_disconnected"); close(released) }()
	waitFor(t, "the reset to queue", func() bool { return len(s.urgent) == 1 })
	close(inner.block)
	<-released

	if err := <-queued; !errors.Is(err, errInputReset) {
		t.Fatalf("queued press: err=%v, want errInputReset", err)
	}
	if err := s.HandleEvent(seqKey("key_down", "y", 4)); !errors.Is(err, errInputDropped) {
		t.Fatalf("retransmitted pre-reset press: err=%v, want errInputDropped", err)
	}
	wantCalls(t, inner, []string{"key_down:x", "key_up:x"})
}

// R1: the epochs move even when the worker is wedged, so monitor_switched
// (sent right after ResetGeometry returns) always announces the new geoEpoch,
// and the late release job does not move them a second time.
func TestSafeInputEpochsMoveEvenWhenTheWorkerIsWedged(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	s.closeTimeout = 50 * time.Millisecond
	defer s.Close()
	handshake(t, s, 1, 1)
	wedgeSeq(t, s, inner, "x", 2)

	s.ResetGeometry("monitor_switch") // times out waiting for the release job
	if r, g := s.Epochs(); r != 2 || g != 2 {
		t.Fatalf("Epochs() right after a timed-out reset = %d,%d want 2,2", r, g)
	}
	close(inner.block)
	s.sync()
	if r, g := s.Epochs(); r != 2 || g != 2 {
		t.Fatalf("the late release job moved the epochs again: %d,%d", r, g)
	}
	wantCalls(t, inner, []string{"key_down:x", "key_up:x"})
}

// R1b: a handshake that arrives after a reset but is queued before its release
// job runs must survive that release.
func TestSafeInputHandshakeQueuedBehindAResetSurvivesIt(t *testing.T) {
	inner := newBlockingRecorder()
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)
	wedgeSeq(t, s, inner, "x", 2)

	released := make(chan struct{})
	go func() { s.ReleaseAll("peer_disconnected"); close(released) }()
	waitFor(t, "the epoch to move", func() bool { r, _ := s.Epochs(); return r == 2 })
	shook := make(chan error, 1)
	go func() { shook <- s.HandleEvent(InputEvent{Type: "input_reset", Seq: 3, Epoch: 2}) }()
	waitFor(t, "the release and the handshake to queue", func() bool { return len(s.urgent) == 1 && len(s.jobs) == 1 })
	close(inner.block)
	<-released

	if err := <-shook; err != nil {
		t.Fatalf("handshake queued after the reset was discarded: %v", err)
	}
	ev := seqKey("key_down", "b", 4)
	ev.Epoch = 2
	if err := s.HandleEvent(ev); err != nil {
		t.Fatalf("input after the surviving handshake: %v", err)
	}
	wantCalls(t, inner, []string{"key_down:x", "key_up:x", "key_down:b"})
}

// Compatibility: a viewer that never sends seq is never gated, whatever resets.
func TestSafeInputLegacyInputIsNeverGatedByAReset(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	_ = s.HandleEvent(InputEvent{Type: "key_down", Key: "shift"})
	s.ReleaseAll("monitor_switch")
	s.ResetGeometry("monitor_switch")
	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "a"}); err != nil {
		t.Fatalf("legacy input gated after a reset: %v", err)
	}
	_ = s.HandleEvent(InputEvent{Type: "mouse_down", X: 1, Y: 1, Button: "left"})

	wantCalls(t, inner, []string{"key_down:shift", "key_up:shift", "key_down:a", "mouse_down:1,1:left"})
}

func TestSafeInputGeometryResetDropsOldCoordinates(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	handshake(t, s, 1, 1)

	s.ResetGeometry("monitor_switch")
	if r, g := s.Epochs(); r != 2 || g != 2 {
		t.Fatalf("Epochs() = %d,%d want 2,2", r, g)
	}
	handshake(t, s, 2, 2)
	old := InputEvent{Type: "mouse_down", X: 1, Y: 1, Button: "left", Seq: 3, Epoch: 2, GeoEpoch: 1}
	if err := s.HandleEvent(old); !errors.Is(err, errInputDropped) {
		t.Fatalf("old-geometry press: err=%v, want errInputDropped", err)
	}
	key := InputEvent{Type: "key_down", Key: "a", Seq: 4, Epoch: 2, GeoEpoch: 1}
	if err := s.HandleEvent(key); err != nil {
		t.Fatalf("key events ignore geometry: %v", err)
	}
	cur := InputEvent{Type: "mouse_down", X: 2, Y: 2, Button: "left", Seq: 5, Epoch: 2, GeoEpoch: 2}
	if err := s.HandleEvent(cur); err != nil {
		t.Fatal(err)
	}
	wantCalls(t, inner, []string{"key_down:a", "mouse_down:2,2:left"})
}

func TestSafeInputAnnouncesAgentResetsButNotClose(t *testing.T) {
	s := NewSafeInput(&workerRecorder{}, "t")
	resets := make(chan string, 4)
	s.SetHooks(safeInputHooks{onReset: func(r string) { resets <- r }})

	s.ReleaseAll("input_channel_closed")
	s.ResetGeometry("monitor_switch")
	s.Close()

	close(resets)
	var got []string
	for r := range resets {
		got = append(got, r)
	}
	if !reflect.DeepEqual(got, []string{"input_channel_closed", "monitor_switch"}) {
		t.Fatalf("onReset calls = %v", got)
	}
}

func TestSafeInputAsksForResyncAtMostOncePerInterval(t *testing.T) {
	inner := &workerRecorder{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	var mu sync.Mutex
	now := time.Unix(1000, 0)
	s.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	resyncs := make(chan struct{}, 10)
	s.SetHooks(safeInputHooks{onResync: func() { resyncs <- struct{}{} }})

	// No handshake yet, so sequenced input is gated and asks for a resync.
	for seq := uint64(1); seq <= 3; seq++ {
		_ = s.HandleEvent(seqKey("key_down", "a", seq))
	}
	if n := len(resyncs); n != 1 {
		t.Fatalf("resyncs after a burst = %d, want 1", n)
	}
	mu.Lock()
	now = now.Add(inputResyncInterval)
	mu.Unlock()
	_ = s.HandleEvent(seqKey("key_down", "a", 4))
	if n := len(resyncs); n != 2 {
		t.Fatalf("resyncs after the interval = %d, want 2", n)
	}
	// Barrier drops are the viewer's own reordering, not a stale epoch: no resync.
	handshake(t, s, 5, 1)
	_ = s.HandleEvent(seqMove(1, 6, 4))
	s.sync()
	if n := len(resyncs); n != 2 {
		t.Fatalf("a behind-barrier drop asked for a resync")
	}
	wantCalls(t, inner, nil)
}

// R2 at the worker level: after a reset, a viewer that only moves the mouse
// still learns the new epoch.
func TestSafeInputStaleMoveAsksForResync(t *testing.T) {
	s := NewSafeInput(&workerRecorder{}, "t")
	defer s.Close()
	resyncs := make(chan struct{}, 4)
	s.SetHooks(safeInputHooks{onResync: func() { resyncs <- struct{}{} }})
	handshake(t, s, 1, 1)
	s.ReleaseAll("peer_disconnected")

	_ = s.HandleEvent(seqMove(5, 4, 3)) // its barrier (3) was discarded by the reset
	s.sync()
	if len(resyncs) != 1 {
		t.Fatal("a stale-epoch move did not ask for a resync")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestSafeInputReleaseAllStarts|TestSafeInputSequencedPress|TestSafeInputEpochsMove|TestSafeInputHandshakeQueued|TestSafeInputLegacyInputIsNever|TestSafeInputGeometryReset|TestSafeInputAnnounces|TestSafeInputAsksForResync|TestSafeInputStaleMove' -race`
Expected: FAIL to compile with `s.Epochs undefined`, `s.ResetGeometry undefined`,
`undefined: safeInputHooks`.

- [ ] **Step 3: Implement**

Add `"sync/atomic"` to the imports. Add to the `const` block:

```go
	// inputResyncInterval bounds how often a viewer that keeps sending a stale
	// reset epoch is told the current one.
	inputResyncInterval = 500 * time.Millisecond
```

Change `safeInputJob` (54-57) to:

```go
type safeInputJob struct {
	run    func() error
	result chan error // buffered(1); nil for fire-and-forget
	gen    uint64     // resetGen at submission; older than discardBelow → discarded
}
```

Add to `SafeInput`:

```go
	resetGen      atomic.Uint64 // +1 per reset, before the epochs are published
	pubResetEpoch atomic.Uint32 // mirrors order.resetEpoch for other goroutines
	pubGeoEpoch   atomic.Uint32 // mirrors order.geoEpoch
	hooks         atomic.Pointer[safeInputHooks]
	now           func() time.Time // worker reads; tests may replace before first use
	lastResync    time.Time        // worker goroutine only
	discardBelow  uint64           // worker goroutine only
```

In `NewSafeInput`, set `now: time.Now` in the literal, and after it (before `go s.loop()`):

```go
	s.pubResetEpoch.Store(s.order.resetEpoch)
	s.pubGeoEpoch.Store(s.order.geoEpoch)
```

Replace `run` (108-113) so stale jobs are discarded when dequeued:

```go
func (s *SafeInput) run(j safeInputJob) {
	if j.gen < s.discardBelow {
		// Submitted before a reset whose release has already run.
		if j.result != nil {
			j.result <- errInputReset
		}
		return
	}
	err := j.run()
	if j.result != nil {
		j.result <- err
	}
}
```

In `submitJob` (Task 3), tag both jobs it builds with the generation read once at entry:
`gen := s.resetGen.Load()`, then `safeInputJob{run: …, result: …, gen: gen}` for the job and
`safeInputJob{run: …, gen: gen}` for the flushed legacy move. Delete `discardQueued` (268-279);
nothing calls it after this task.

Add the types and methods:

```go
// safeInputHooks must not block and must not call back into SafeInput.
// onReset runs on the goroutine that triggered the reset; onResync runs on the
// worker. The Session's hooks only spawn a goroutine.
type safeInputHooks struct {
	onReset  func(reason string) // an agent-side reset started a new epoch
	onResync func()              // sequenced input arrived with a stale epoch
}

func (s *SafeInput) SetHooks(h safeInputHooks) { s.hooks.Store(&h) }

// Epochs returns the current reset and geometry epochs. Any goroutine.
func (s *SafeInput) Epochs() (reset, geo uint32) {
	return s.pubResetEpoch.Load(), s.pubGeoEpoch.Load()
}
```

Replace `ReleaseAll` (from Task 3) with:

```go
// ReleaseAll releases every key and button the agent holds on the remote,
// discards input queued before it, and starts a new reset epoch so that
// sequenced input sent before it (queued, or retransmitted and delivered late)
// cannot press anything again. Legacy input is unaffected by the epoch. Safe to
// call at any time, including after Close. It never blocks longer than the
// close timeout, and the epoch has moved by the time it returns, even if the
// release itself timed out.
func (s *SafeInput) ReleaseAll(reason string) { s.reset(reason, false, true) }

// ResetGeometry is ReleaseAll plus a new geometry epoch, in one step. The
// monitor and desktop switches call it before the display offset changes.
func (s *SafeInput) ResetGeometry(reason string) { s.reset(reason, true, true) }

func (s *SafeInput) reset(reason string, geometry, announce bool) {
	s.orderMu.Lock()
	s.order.agentReset(geometry)
	epoch, geo := s.order.resetEpoch, s.order.geoEpoch
	gen := s.resetGen.Add(1) // before publishing: a reader that sees the new epoch sees gen too
	s.pubResetEpoch.Store(epoch)
	s.pubGeoEpoch.Store(geo)
	s.orderMu.Unlock()

	slog.Info("Input reset", "session", s.label, "reason", reason, "epoch", epoch, "geoEpoch", geo)
	if h := s.hooks.Load(); announce && h != nil && h.onReset != nil {
		h.onReset(reason)
	}
	err := s.submit(true, s.closeTimeout, func() error {
		if gen > s.discardBelow {
			s.discardBelow = gen
		}
		s.takeMove()
		s.releaseHeld(reason)
		return nil
	})
	if err != nil && !errors.Is(err, errInputClosed) {
		slog.Warn("Releasing held remote input failed", "session", s.label, "reason", reason, "error", err.Error())
	}
}
```

In `Close` (line 290), replace `s.ReleaseAll("closed")` with `s.reset("closed", false, false)`. A
closing session tells no one.

Extend `noteDrop` (from Task 3):

```go
func (s *SafeInput) noteDrop(reason string) {
	s.drops[reason]++
	slog.Debug("Dropped input event", "session", s.label, "reason", reason)
	if !resyncNeeded(reason) {
		return
	}
	now := s.now()
	if !s.lastResync.IsZero() && now.Sub(s.lastResync) < inputResyncInterval {
		return
	}
	s.lastResync = now
	if h := s.hooks.Load(); h != nil && h.onResync != nil {
		h.onResync()
	}
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestSafeInput|TestInputOrder' -race -count=20`
Expected: PASS 20×. The W2a tests still pass:
- `TestSafeInputReleaseAllDiscardsQueuedInput` (`input_safe_test.go:194`): the queued `key_down y`
  is answered `errInputReset` when it is dequeued.
- `TestSafeInputCloseDoesNotHangOnStuckHandler` and `TestSafeInputCloseDoesNotHangWithFullUrgentQueue`:
  `Close` uses the same bounded path.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/input_safe.go agent/internal/remote/desktop/input_safe_order_test.go
git commit -m "feat(agent): reset and geometry epochs stop pre-reset input re-latching keys (#8246)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Route `input-r`, enforce channel rules, idle accounting, capabilities

**Files:**
- Modify: `agent/internal/remote/desktop/session_control.go`:
  - `onViewerDataChannelMessage` 104-112; `handleInputMessage` 115-158; `case "input_capabilities"` 445-446
- Create: `agent/internal/remote/desktop/session_input_reliable_test.go`

**Interfaces:**
- Consumes: `SafeInput.SkipSeq`, `SafeInput.Epochs`, `errInputDropped`, `MaxInputSeq`.
- Produces:
  - `func (s *Session) handleInputMessageFrom(label string, data []byte)`.
    `handleInputMessage(data)` stays as the `"input"` wrapper; existing tests call it.
  - `func inputChannelRejects(label string, ev InputEvent) string`. Empty string = allowed.
  - `func isInputResetFrame(data []byte) bool`
  - `func (s *Session) skipRejectedSeq(label string, ev InputEvent)`
  - `func (s *Session) inputCapabilities() map[string]any`. Adds `reliableInput`, `inputEpoch`
    and `geoEpoch` to `buildInputCapabilities()`, which is unchanged (its W2a test,
    `session_input_test.go:74`, stays).

- [ ] **Step 1: Write the failing tests**

`agent/internal/remote/desktop/session_input_reliable_test.go`:

```go
package desktop

import (
	"testing"
	"time"
)

func sendR(s *Session, raw string)     { s.onViewerDataChannelMessage("input-r", []byte(raw)) }
func sendLossy(s *Session, raw string) { s.onViewerDataChannelMessage("input", []byte(raw)) }

const rHandshake = `{"type":"input_reset","seq":1,"epoch":1}`

func TestInputRCarriesSequencedKeys(t *testing.T) {
	s, inner := newSafeSession(t)
	sendR(s, rHandshake)
	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":1}`)
	if got := lastCall(inner); got != "key_down:a" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}

func TestInputRTrafficResetsIdleWatchdog(t *testing.T) {
	s, _ := newSafeSession(t)
	sendR(s, rHandshake)
	s.lastInputUnixNano.Store(time.Now().Add(-time.Hour).UnixNano())

	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":1}`)

	if idlePolicyStops(s) {
		t.Fatal("keyboard input on input-r must reset the idle watchdog")
	}
}

// input_reset is protocol housekeeping the viewer sends on its own (focus
// loss, handshakes), not operator presence.
func TestInputResetDoesNotResetIdleWatchdog(t *testing.T) {
	s, _ := newSafeSession(t)
	s.lastInputUnixNano.Store(time.Now().Add(-time.Hour).UnixNano())

	sendR(s, rHandshake)

	if !idlePolicyStops(s) {
		t.Fatal("input_reset must not reset the idle watchdog")
	}
}

func TestInputChannelRules(t *testing.T) {
	cases := []struct {
		label string
		ev    InputEvent
		want  string
	}{
		{"input", InputEvent{Type: "key_down", Key: "a"}, ""},
		{"input", InputEvent{Type: "mouse_move", Seq: 2, After: 1}, ""},
		{"input", InputEvent{Type: "key_down", Key: "a", Seq: 2}, "sequenced_discrete_on_lossy_channel"},
		{"input", InputEvent{Type: "input_reset", Seq: 2, Epoch: 1}, "input_reset_on_lossy_channel"},
		{"input-r", InputEvent{Type: "key_down", Key: "a", Seq: 2}, ""},
		{"input-r", InputEvent{Type: "mouse_move", Seq: 2, After: 1}, ""},
		{"input-r", InputEvent{Type: "input_reset", Seq: 2, Epoch: 1}, ""},
		{"input-r", InputEvent{Type: "key_down", Key: "a"}, "unsequenced_on_input_r"},
	}
	for _, tc := range cases {
		if got := inputChannelRejects(tc.label, tc.ev); got != tc.want {
			t.Errorf("inputChannelRejects(%q, %+v) = %q, want %q", tc.label, tc.ev, got, tc.want)
		}
	}
}

func TestWrongChannelEventsAreNotInjected(t *testing.T) {
	s, inner := newSafeSession(t)
	sendR(s, `{"type":"key_down","key":"a"}`)                        // legacy on input-r
	sendLossy(s, `{"type":"key_down","key":"b","seq":2,"epoch":1}`)  // sequenced key on the lossy channel
	sendLossy(s, `{"type":"input_reset","seq":3,"epoch":1}`)         // handshake on the lossy channel
	s.safeInput().sync()
	if c := inner.snapshot(); len(c) != 0 {
		t.Fatalf("wrong-channel events reached the platform handler: %v", c)
	}
	// The lossy input_reset did not open the gate.
	sendR(s, `{"type":"key_down","key":"c","seq":4,"epoch":1}`)
	if c := inner.snapshot(); len(c) != 0 {
		t.Fatalf("gate opened by an input_reset on the lossy channel: %v", c)
	}
}

func TestRejectedInputREventDoesNotFreezeThePointer(t *testing.T) {
	for name, bad := range map[string]string{
		"validation": `{"type":"mouse_scroll","x":1,"y":1,"delta":100000,"seq":2,"epoch":1,"geoEpoch":1}`,
		"type error": `{"type":"key_down","key":"a","x":"oops","seq":2,"epoch":1}`,
	} {
		t.Run(name, func(t *testing.T) {
			s, inner := newSafeSession(t)
			sendR(s, rHandshake)
			sendLossy(s, `{"type":"mouse_move","x":7,"y":7,"seq":3,"after":2,"epoch":1,"geoEpoch":1}`)
			sendR(s, bad)
			s.safeInput().sync()
			if got := lastCall(inner); got != "mouse_move:7,7:" {
				t.Fatalf("pointer frozen behind a rejected event: %v", inner.snapshot())
			}
		})
	}
}

func TestInputCapabilitiesAdvertiseReliableInput(t *testing.T) {
	s, _ := newSafeSession(t)
	body := s.inputCapabilities()
	if body["reliableInput"] != true || body["inputEpoch"] != uint32(1) || body["geoEpoch"] != uint32(1) {
		t.Fatalf("capabilities = %v", body)
	}
	if body["typeText"] != true || body["releasesHeldInput"] != true {
		t.Fatalf("W2a keys missing: %v", body)
	}
	plain := &Session{id: "p", inputHandler: &stubInputHandler{}}
	if _, ok := plain.inputCapabilities()["reliableInput"]; ok {
		t.Fatal("advertised reliableInput without an input worker to honour it")
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestInputR|TestInputReset|TestInputChannelRules|TestWrongChannel|TestRejectedInputR|TestInputCapabilitiesAdvertiseReliable' -race`
Expected: FAIL to compile with `undefined: inputChannelRejects` / `s.inputCapabilities undefined`.

- [ ] **Step 3: Implement**

In `session_control.go`, replace `onViewerDataChannelMessage` (104-112):

```go
// onViewerDataChannelMessage routes an inbound viewer data-channel message by
// label and applies the idle-watchdog policy in one place. Idle is reset on
// operator input only: control-channel traffic (e.g. the viewer's automated
// ~1s viewer_stats heartbeat) is not a signal of operator presence, so letting
// it reset the idle clock would defeat the idle timeout for any open-but-
// unattended viewer (finding #1).
//
// input-r carries a W3 viewer's keys and buttons, so it counts. Otherwise a
// keyboard-only session idles out. input_reset does not count: the viewer sends
// it on its own (focus loss, handshakes), not because the operator acted.
func (s *Session) onViewerDataChannelMessage(label string, data []byte) {
	switch label {
	case "input":
		s.recordInputActivity()
		s.handleInputMessageFrom("input", data)
	case "input-r":
		if !isInputResetFrame(data) {
			s.recordInputActivity()
		}
		s.handleInputMessageFrom("input-r", data)
	case "control":
		s.handleControlMessage(data)
	}
}

func isInputResetFrame(data []byte) bool {
	if len(data) > maxInputMessageBytes {
		return false
	}
	var peek struct {
		Type string `json:"type"`
	}
	return json.Unmarshal(data, &peek) == nil && peek.Type == "input_reset"
}
```

Replace `handleInputMessage` (115-158) with the wrapper and the label-aware body. Keep the comments
inside the existing body (the disabled `clickFlush` block stays verbatim):

```go
// handleInputMessage processes an event from the legacy "input" channel.
func (s *Session) handleInputMessage(data []byte) { s.handleInputMessageFrom("input", data) }

// handleInputMessageFrom processes an input event that arrived on label.
func (s *Session) handleInputMessageFrom(label string, data []byte) {
	// Drop input events early when the handler cannot inject them (e.g. macOS
	// login window without IOHIDSystem). The viewer is notified once via
	// sendInputStatus(); no need to log per-event.
	if !s.inputHandler.InputAvailable() {
		return
	}

	if len(data) > maxInputMessageBytes {
		slog.Warn("Rejected oversized input event", "session", s.id, "channel", label, "size", len(data))
		return
	}

	var event InputEvent
	if err := json.Unmarshal(data, &event); err != nil {
		slog.Warn("Failed to parse input event", "session", s.id, "channel", label, "error", err.Error())
		// A type error still decodes the other fields, seq included.
		s.skipRejectedSeq(label, event)
		return
	}
	if err := ValidateInputEvent(event); err != nil {
		slog.Warn("Rejected invalid input event", "session", s.id, "channel", label, "type", event.Type, "error", err.Error())
		s.skipRejectedSeq(label, event)
		return
	}
	if reason := inputChannelRejects(label, event); reason != "" {
		slog.Debug("Rejected input event on the wrong channel", "session", s.id, "channel", label, "reason", reason)
		s.skipRejectedSeq(label, event)
		return
	}

	// (existing inputActive / clickFlush comment block and statements, unchanged)
	s.inputActive.Store(true)

	if err := s.inputHandler.HandleEvent(event); err != nil {
		if errors.Is(err, errInputReset) || errors.Is(err, errInputClosed) || errors.Is(err, errInputDropped) {
			return // discarded by a release, teardown or the ordering layer; expected
		}
		slog.Warn("Failed to handle input event", "session", s.id, "error", err.Error())
	}
}

// inputChannelRejects enforces which channel may carry what (spec §1). The
// ordering barrier assumes that no sequenced discrete event is lost or
// reordered, so only the reliable input-r may carry them, and input_reset.
// The lossy input channel carries legacy events and sequenced pointer motion.
// input-r is W2b-only, so an unsequenced event there is a viewer bug.
func inputChannelRejects(label string, ev InputEvent) string {
	switch label {
	case "input-r":
		if ev.Seq == 0 {
			return "unsequenced_on_input_r"
		}
	case "input":
		if ev.Type == "input_reset" {
			return "input_reset_on_lossy_channel"
		}
		if ev.Seq > 0 && ev.Type != "mouse_move" {
			return "sequenced_discrete_on_lossy_channel"
		}
	}
	return ""
}

// skipRejectedSeq keeps the ordering barrier moving past a discrete event that
// never reaches the worker. Without it, every later move waits for that seq and
// the pointer freezes until the next key or click.
//
// Only for input-r. It is ordered and reliable, so its seqs arrive in order.
// Skipping a seq that rode the lossy channel could move the barrier past an
// input-r event still in flight. That event would then be dropped as a
// duplicate, and if it were a key_up, the key would stay latched.
func (s *Session) skipRejectedSeq(label string, ev InputEvent) {
	if label != "input-r" || ev.Seq == 0 || ev.Seq > MaxInputSeq || ev.Type == "mouse_move" {
		return
	}
	if si := s.safeInput(); si != nil {
		si.SkipSeq(ev.Seq)
	}
}
```

Below `buildInputCapabilities` (172-178), add:

```go
// inputCapabilities is this session's input_capabilities reply.
//
// reliableInput (W2b) says this agent routes the input-r channel and honours
// seq/after and the reset and geometry epochs. inputEpoch and geoEpoch are
// where a viewer starts. Agents without the input worker never send these
// keys, and a viewer that does not see them stays on the legacy protocol.
func (s *Session) inputCapabilities() map[string]any {
	body := buildInputCapabilities()
	if si := s.safeInput(); si != nil {
		epoch, geo := si.Epochs()
		body["reliableInput"] = true
		body["inputEpoch"] = epoch
		body["geoEpoch"] = geo
	}
	return body
}
```

At line 446, change `s.sendControlJSON(buildInputCapabilities())` to
`s.sendControlJSON(s.inputCapabilities())`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ -race`
Expected: PASS for the whole package, including
`TestInputTrafficResetsIdleWatchdog` / `TestControlTrafficDoesNotResetIdleWatchdog`
(`session_webrtc_test.go:183,203`) and `TestHandleInputMessageDropsOutOfRangeEvent`.

- [ ] **Step 5: Check that the idle exclusion can fail**

`TestInputResetDoesNotResetIdleWatchdog` would also pass if `input-r` were not routed at all.
1. Temporarily delete the `if !isInputResetFrame(data)` guard, so the `input-r` case records
   unconditionally.
2. Re-run that test. Expected: FAIL.
3. Revert.

- [ ] **Step 6: Commit**

```bash
git add agent/internal/remote/desktop/session_control.go agent/internal/remote/desktop/session_input_reliable_test.go
git commit -m "feat(agent): route the reliable input-r channel and count it for idle (#8246)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Channel lifecycle, epoch announcements, geometry transitions, `StartSession` wiring

**Files:**
- Modify: `agent/internal/remote/desktop/session.go:36-163` (add three fields to `Session`)
- Modify: `agent/internal/remote/desktop/session_input.go` (new helpers)
- Modify: `agent/internal/remote/desktop/session_control.go:607-657` (`case "switch_monitor"`
  becomes a call to a new `switchMonitor` method)
- Modify: `agent/internal/remote/desktop/session_capture.go:1085-1116` (`handleDesktopSwitch`)
- Modify: `agent/internal/remote/desktop/session_webrtc.go`: line 127 (after
  `session.cursorStreamEnabled.Store(false)`) and 466-491 (`OnDataChannel`)
- Test: `agent/internal/remote/desktop/session_input_reliable_test.go` (append)
- Test: `agent/internal/remote/desktop/session_desktop_switch_test.go` (append; the file is
  `//go:build !windows`)

**Interfaces:**
- Consumes: `SafeInput.SetHooks`, `SafeInput.ResetGeometry`, `SafeInput.Epochs` (Task 4).
- Produces:
  - `Session.viewerChannels map[string]any` (guarded by `s.mu`)
  - `Session.inputRAttached atomic.Bool`
  - `Session.geometryMu sync.Mutex`: serialises geometry transitions
  - `func (s *Session) acceptViewerChannel(label string, ch any, reliable bool) bool`
  - `func (s *Session) onViewerChannelAttached(label string, ch any)`
  - `func (s *Session) attachViewerChannel(label string, ch any) (replaced bool)`
  - `func (s *Session) isCurrentViewerChannel(label string, ch any) bool`
  - `func (s *Session) viewerChannelMessage(label string, ch any, data []byte)`
  - `func (s *Session) onViewerChannelClosed(label string, ch any)`
  - `func (s *Session) wireInputEpochHooks()`
  - `func (s *Session) inputEpochAnnouncement(reason string) (map[string]any, bool)`
  - `func (s *Session) announceInputEpoch(reason string)`
  - `func (s *Session) resetInputGeometry(reason string)`
  - `func (s *Session) monitorSwitchedMessage(index, width, height int) map[string]any`
  - `func (s *Session) announceCurrentMonitor()`
  - `func (s *Session) currentDisplayIndex() int`
  - `func (s *Session) switchMonitor(index int)`
  - `func isReliableOrdered(ordered bool, maxRetransmits, maxPacketLifeTime *uint16) bool`

**Design notes.**
- **The geometry epoch moves before anything else changes.** Suppose it moved only after the new
  capturer was in place. The viewer could acknowledge the reset from the start of the switch and
  press a button under the old geometry before the bump. That button's old-geometry `mouse_up`
  would then be dropped, leaving the button latched. So `ResetGeometry` releases and moves both
  epochs before `NewScreenCapturer`. Thanks to R1 (Task 4), the epochs have moved by the time it
  returns, even if the worker is wedged.
- **Every change of the input coordinate mapping is a geometry transition (R3).** That covers
  both a monitor switch and a desktop switch (UAC, lock, Winlogon), where the offset becomes 0,0
  or is restored. A transition:
  1. moves both epochs;
  2. commits the new offset;
  3. then announces the geometry with `monitor_switched`.

  Before the announcement, the viewer's clicks carry the old `geoEpoch` and are dropped. They can
  never land under the wrong offset.
- **Geometry transitions are serialised by `Session.geometryMu` (R4, R5).** The capture loop's
  desktop switch and the control channel's monitor switch, including one arriving from a superseded
  control channel, used to interleave their bump, swap and offset writes. This also removes the
  data race on `s.displayIndex` between `session_capture.go:1116` (unlocked read) and
  `session_control.go:632` (locked write). The worker never takes `geometryMu`, and nothing takes
  `geometryMu` while holding `s.mu`. The lock order is `geometryMu` → `s.mu`, plus bounded worker
  waits.
- **On failure, repeat the unchanged monitor.** If the capturer fails, the switch did not happen,
  and the viewer is told its unchanged monitor with the new `geoEpoch` (`announceCurrentMonitor`).
- **`input_epoch` never carries `geoEpoch`.** The geometry epoch travels only with geometry.
- **Superseded channels are muted, not just ignored at close (R5).** Messages arriving on a
  channel that has been replaced are dropped at arrival.
- **An unreliable `input-r` is refused and closed (R6).** It would void the barrier's no-loss and
  in-order assumptions; for example, an overtaking discrete event turns a `key_up` into a duplicate
  drop.

- [ ] **Step 1: Write the failing tests**

Append to `session_input_reliable_test.go` (add `"errors"`, `"reflect"` and `"strings"` to the
imports):

```go
func TestReplacingAViewerChannelReleasesHeldInput(t *testing.T) {
	s, inner := newSafeSession(t)
	a, b := new(int), new(int)
	s.onViewerChannelAttached("input-r", a)
	sendR(s, rHandshake)
	sendR(s, `{"type":"key_down","key":"shift","seq":2,"epoch":1}`)

	s.onViewerChannelAttached("input-r", b)

	waitFor(t, "the replacement to release shift", func() bool { return lastCall(inner) == "key_up:shift" })
	if e, _ := s.safeInput().Epochs(); e != 2 {
		t.Fatalf("epoch = %d, want 2", e)
	}
}

func TestSupersededChannelClosingLateDoesNotResetAgain(t *testing.T) {
	s, inner := newSafeSession(t)
	a, b := new(int), new(int)
	s.onViewerChannelAttached("input-r", a)
	s.onViewerChannelAttached("input-r", b)
	waitFor(t, "the replacement reset", func() bool { e, _ := s.safeInput().Epochs(); return e == 2 })
	sendR(s, `{"type":"input_reset","seq":1,"epoch":2}`)

	s.onViewerChannelClosed("input-r", a) // the old channel's close arrives late
	sendR(s, `{"type":"key_down","key":"a","seq":2,"epoch":2}`)
	if got := lastCall(inner); got != "key_down:a" {
		t.Fatalf("late close of a superseded channel re-gated input: %v", inner.snapshot())
	}

	s.onViewerChannelClosed("input-r", b) // the current one closing does reset
	if e, _ := s.safeInput().Epochs(); e != 3 {
		t.Fatalf("epoch after the current channel closed = %d, want 3", e)
	}
}

func TestSupersededChannelMessagesAreIgnored(t *testing.T) {
	s, inner := newSafeSession(t)
	a, b := new(int), new(int)
	s.onViewerChannelAttached("input", a)
	s.onViewerChannelAttached("input", b)
	waitFor(t, "the replacement reset", func() bool { e, _ := s.safeInput().Epochs(); return e == 2 })

	s.viewerChannelMessage("input", a, []byte(`{"type":"key_down","key":"a"}`))
	s.viewerChannelMessage("input", b, []byte(`{"type":"key_down","key":"b"}`))

	if got := inner.snapshot(); !reflect.DeepEqual(got, []string{"key_down:b"}) {
		t.Fatalf("calls = %v, want only the current channel's key", got)
	}
}

func TestUnreliableInputRIsRefused(t *testing.T) {
	s, inner := newSafeSession(t)
	bad := new(int)
	if s.acceptViewerChannel("input-r", bad, false) {
		t.Fatal("accepted an input-r without reliable ordered delivery")
	}
	if s.inputRAttached.Load() {
		t.Fatal("a refused input-r marked the viewer as W2b")
	}
	s.viewerChannelMessage("input-r", bad, []byte(rHandshake))
	s.viewerChannelMessage("input-r", bad, []byte(`{"type":"key_down","key":"a","seq":2,"epoch":1}`))
	if c := inner.snapshot(); len(c) != 0 {
		t.Fatalf("a refused input-r carried input: %v", c)
	}
	if !s.acceptViewerChannel("input", new(int), false) {
		t.Fatal("the lossy input channel is unreliable by design and must be accepted")
	}
}

func TestInputEpochIsAnnouncedOnlyToViewersThatOpenedInputR(t *testing.T) {
	s, _ := newSafeSession(t)
	if _, ok := s.inputEpochAnnouncement("peer_disconnected"); ok {
		t.Fatal("announced input_epoch to a viewer that never opened input-r")
	}
	s.onViewerChannelAttached("input-r", new(int))
	body, ok := s.inputEpochAnnouncement("peer_disconnected")
	want := map[string]any{"type": "input_epoch", "epoch": uint32(1), "reason": "peer_disconnected"}
	if !ok || !reflect.DeepEqual(body, want) {
		t.Fatalf("announcement = %v (ok=%v), want %v", body, ok, want)
	}
}

func TestMonitorSwitchedMessageCarriesTheNewEpochs(t *testing.T) {
	s, _ := newSafeSession(t)
	s.resetInputGeometry("monitor_switch")
	got := s.monitorSwitchedMessage(1, 1920, 1080)
	want := map[string]any{
		"type": "monitor_switched", "index": 1, "width": 1920, "height": 1080,
		"inputEpoch": uint32(2), "geoEpoch": uint32(2),
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("monitor_switched = %v, want %v", got, want)
	}
}

// R8: announcing must never make a reset, or the worker, wait on Session.mu.
// The test holds s.mu, so a synchronous announcement would block inside
// sendControlJSON and the test would time out. Verify it can fail by removing
// the `go` from either hook in wireInputEpochHooks.
func TestInputEpochAnnouncementsNeverWaitOnTheSession(t *testing.T) {
	s, _ := newSafeSession(t)
	s.onViewerChannelAttached("input-r", new(int))
	s.wireInputEpochHooks()
	si := s.safeInput()
	deadline := safeInputCloseTimeout / 2 // shorter than every internal timeout

	s.mu.Lock()
	defer s.mu.Unlock()

	reset := make(chan struct{})
	go func() { si.ReleaseAll("peer_disconnected"); si.sync(); close(reset) }()
	select {
	case <-reset:
	case <-time.After(deadline):
		t.Fatal("onReset made the reset wait on Session.mu")
	}

	// onResync runs on the worker: gated sequenced input asks for a resync.
	resync := make(chan error, 1)
	go func() { resync <- si.HandleEvent(seqKey("key_down", "a", 1)) }()
	select {
	case err := <-resync:
		if !errors.Is(err, errInputDropped) {
			t.Fatalf("gated key: err=%v, want errInputDropped", err)
		}
	case <-time.After(deadline):
		t.Fatal("onResync made the worker wait on Session.mu")
	}
}

func TestIsReliableOrdered(t *testing.T) {
	zero := uint16(0)
	if !isReliableOrdered(true, nil, nil) {
		t.Fatal("ordered + no limits is reliable")
	}
	for _, c := range []struct {
		ordered    bool
		retx, life *uint16
	}{{false, nil, nil}, {true, &zero, nil}, {true, nil, &zero}} {
		if isReliableOrdered(c.ordered, c.retx, c.life) {
			t.Fatalf("isReliableOrdered(%v,%v,%v) = true", c.ordered, c.retx, c.life)
		}
	}
}

// StartSession and switchMonitor need a real capturer and cannot run in CI.
// This source contract (precedent: session_filedrop_boundary_test.go) pins the
// wiring the unit tests above rely on.
func TestWebRTCSessionWiresTheReliableInputChannel(t *testing.T) {
	read := func(name string) string {
		b, err := desktopSources.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		return string(b)
	}
	// inOrder requires each needle to appear after the previous one; a needle
	// may repeat.
	inOrder := func(file, src string, needles ...string) {
		t.Helper()
		from := 0
		for _, n := range needles {
			i := strings.Index(src[from:], n)
			if i < 0 {
				t.Fatalf("%s: %q missing or out of order (want order %q)", file, n, needles)
			}
			from += i + len(n)
		}
	}
	webrtcSrc := read("session_webrtc.go")
	for _, want := range []string{
		`case "input", "input-r":`,
		"session.acceptViewerChannel(label, dc, reliable)",
		"session.viewerChannelMessage(label, dc, msg.Data)",
		"session.onViewerChannelClosed(label, dc)",
		`session.viewerChannelMessage("control", dc, msg.Data)`,
		`session.onViewerChannelClosed("control", dc)`,
		"session.wireInputEpochHooks()",
	} {
		if !strings.Contains(webrtcSrc, want) {
			t.Errorf("session_webrtc.go is missing %q", want)
		}
	}
	ctl := read("session_control.go")
	inOrder("session_control.go", ctl[strings.Index(ctl, "func (s *Session) switchMonitor("):],
		"s.geometryMu.Lock()",
		`s.resetInputGeometry("monitor_switch")`,
		"NewScreenCapturer(cfg)",
		"s.announceCurrentMonitor()",
		"applyDisplayOffset(s.inputHandler, index",
		"s.monitorSwitchedMessage(index, w, h)",
	)
	capture := read("session_capture.go")
	inOrder("session_capture.go", capture[strings.Index(capture, "func (s *Session) handleDesktopSwitch("):],
		"s.geometryMu.Lock()",
		`s.resetInputGeometry("desktop_switch")`,
		"s.announceCurrentMonitor()",
		"applyDisplayOffset(s.inputHandler, s.currentDisplayIndex()",
		"s.announceCurrentMonitor()",
	)
}
```

If the function-name `strings.Index` returns -1, the slice expression panics. That is the intended
red before `switchMonitor` exists.

Append to `session_desktop_switch_test.go`:

```go
// R3: a desktop switch changes the input offset, so it is a geometry transition.
func TestHandleDesktopSwitchMovesTheGeometryEpoch(t *testing.T) {
	si := NewSafeInput(&workerRecorder{}, "s")
	t.Cleanup(si.Close)
	s := &Session{
		id:           "s",
		inputHandler: si,
		capturer:     &switchingCapturer{staticTestCapturer: staticTestCapturer{img: image.NewRGBA(image.Rect(0, 0, 4, 4))}},
	}

	s.handleDesktopSwitch()

	if r, g := si.Epochs(); r != 2 || g != 2 {
		t.Fatalf("Epochs() after a desktop switch = %d,%d want 2,2", r, g)
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestReplacingAViewer|TestSuperseded|TestUnreliableInputR|TestInputEpochIs|TestMonitorSwitchedMessage|TestInputEpochAnnouncements|TestIsReliableOrdered|TestWebRTCSessionWires|TestHandleDesktopSwitch' -race`
Expected: FAIL to compile with `s.onViewerChannelAttached undefined` and others.

- [ ] **Step 3: Implement**

`session.go`: in `Session`, after `controlDC *webrtc.DataChannel` (line 47), add:

```go
	// viewerChannels maps each viewer data-channel label to the channel now
	// serving it. A replaced channel's messages are ignored and its late close
	// does not reset the stream its successor carries. Guarded by mu.
	viewerChannels map[string]any
	// inputRAttached is set once the viewer opens a reliable input-r: it
	// speaks W2b, so it is sent input_epoch announcements. Viewers that never
	// open it are never sent a control message they predate.
	inputRAttached atomic.Bool
	// geometryMu serialises input geometry transitions (monitor switch,
	// desktop switch): epoch bump, capturer swap, offset commit, announcement.
	// Lock order: geometryMu, then mu. The input worker never takes it.
	geometryMu sync.Mutex
```

`session_input.go`: append (add `"log/slog"` to the imports):

```go
// acceptViewerChannel admits a newly opened input or input-r channel. An
// input-r without reliable ordered delivery is refused: the ordering barrier
// assumes no discrete event on it is lost or overtaken. The caller closes it.
// A W3 viewer falls back to the legacy protocol when input-r closes.
func (s *Session) acceptViewerChannel(label string, ch any, reliable bool) bool {
	if label == "input-r" && !reliable {
		slog.Warn("Refused input-r without reliable ordered delivery", "session", s.id)
		return false
	}
	s.onViewerChannelAttached(label, ch)
	return true
}

// onViewerChannelAttached records a newly opened viewer channel. A second
// channel with a label already in use is a transport replacement (spec §2).
// Input held through the old channel is released off this goroutine, because
// pion's accept loop waits for the OnDataChannel callback before it opens the
// channel (pion/webrtc@v4.2.22 sctptransport.go:358-359).
func (s *Session) onViewerChannelAttached(label string, ch any) {
	if s.attachViewerChannel(label, ch) {
		go s.releaseHeldInput(label + "_channel_replaced")
	}
}

func (s *Session) attachViewerChannel(label string, ch any) (replaced bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.viewerChannels == nil {
		s.viewerChannels = map[string]any{}
	}
	prev, had := s.viewerChannels[label]
	s.viewerChannels[label] = ch
	if label == "input-r" {
		s.inputRAttached.Store(true)
	}
	return had && prev != ch
}

func (s *Session) isCurrentViewerChannel(label string, ch any) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.viewerChannels[label] == ch
}

// viewerChannelMessage routes a message from a specific channel, ignoring
// channels that have been replaced (or were never admitted).
func (s *Session) viewerChannelMessage(label string, ch any, data []byte) {
	if !s.isCurrentViewerChannel(label, ch) {
		slog.Debug("Ignored message on a superseded viewer channel", "session", s.id, "channel", label)
		return
	}
	s.onViewerDataChannelMessage(label, data)
}

// onViewerChannelClosed releases held input only if ch is still the session's
// channel for label. A superseded channel that closes late must not reset a
// stream the viewer has already re-handshaken on its replacement.
//
// If the replacement attaches between this check and the reset below, the
// reset also releases what the replacement pressed and closes its gate. That
// is a spurious reset, which is safe: the viewer is told the new epoch and
// re-handshakes. Skipping the reset instead would strand keys a legacy viewer
// pressed through the closed channel (review item R7, rejected).
func (s *Session) onViewerChannelClosed(label string, ch any) {
	s.mu.Lock()
	current := s.viewerChannels[label] == ch
	if current {
		delete(s.viewerChannels, label)
	}
	s.mu.Unlock()
	if !current {
		slog.Debug("Superseded viewer channel closed", "session", s.id, "channel", label)
		return
	}
	s.onViewerDataChannelClosed(label)
}

// wireInputEpochHooks tells the viewer about agent-side resets. onReset runs on
// the resetting goroutine and onResync on the input worker. Neither may wait on
// Session, so both only spawn.
func (s *Session) wireInputEpochHooks() {
	si := s.safeInput()
	if si == nil {
		return
	}
	si.SetHooks(safeInputHooks{
		onReset:  func(reason string) { go s.announceInputEpoch(reason) },
		onResync: func() { go s.announceInputEpoch("resync") },
	})
}

// inputEpochAnnouncement builds the input_epoch control message. It carries
// the reset epoch only: the geometry epoch travels with geometry, in
// monitor_switched, so a viewer never adopts it before it has the new frame.
func (s *Session) inputEpochAnnouncement(reason string) (map[string]any, bool) {
	si := s.safeInput()
	if si == nil || !s.inputRAttached.Load() {
		return nil, false
	}
	epoch, _ := si.Epochs()
	return map[string]any{"type": "input_epoch", "epoch": epoch, "reason": reason}, true
}

func (s *Session) announceInputEpoch(reason string) {
	if body, ok := s.inputEpochAnnouncement(reason); ok {
		s.sendControlJSON(body)
	}
}

// resetInputGeometry releases held input and moves the reset and geometry
// epochs. Call it with geometryMu held, before the input offset changes.
func (s *Session) resetInputGeometry(reason string) {
	if si := s.safeInput(); si != nil {
		si.ResetGeometry(reason)
		return
	}
	s.releaseHeldInput(reason)
}

func (s *Session) monitorSwitchedMessage(index, width, height int) map[string]any {
	body := map[string]any{"type": "monitor_switched", "index": index, "width": width, "height": height}
	if si := s.safeInput(); si != nil {
		epoch, geo := si.Epochs()
		body["inputEpoch"] = epoch
		body["geoEpoch"] = geo
	}
	return body
}

func (s *Session) currentDisplayIndex() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.displayIndex
}

// announceCurrentMonitor sends monitor_switched for the monitor the session is
// on now, with the current epochs. Used after a geometry transition that kept
// the monitor: a desktop switch, or a monitor switch whose capturer failed.
func (s *Session) announceCurrentMonitor() {
	s.mu.RLock()
	capturer, index := s.capturer, s.displayIndex
	s.mu.RUnlock()
	w, h := 0, 0
	if capturer != nil {
		if bw, bh, err := capturer.GetScreenBounds(); err == nil {
			w, h = bw, bh
		}
	}
	s.sendControlJSON(s.monitorSwitchedMessage(index, w, h))
}

// isReliableOrdered reports whether a data channel delivers every message in
// order, which is what the ordering barrier assumes of input-r.
func isReliableOrdered(ordered bool, maxRetransmits, maxPacketLifeTime *uint16) bool {
	return ordered && maxRetransmits == nil && maxPacketLifeTime == nil
}
```

`session_control.go`: replace the body of `case "switch_monitor":` (607-657) with:

```go
	case "switch_monitor":
		if msg.Value < 0 {
			return
		}
		s.switchMonitor(msg.Value)
```

and add the method, which keeps the old body's comments and moves its statements, with the changes
marked:

```go
// switchMonitor moves capture and input to display index. It is a geometry
// transition, serialised with desktop switches by geometryMu.
func (s *Session) switchMonitor(index int) {
	s.geometryMu.Lock()
	defer s.geometryMu.Unlock()

	slog.Info("Switching monitor", "session", s.id, "display", index)
	// Release held input and move the reset and geometry epochs before
	// anything moves: coordinates in flight belong to the old monitor. (W2b)
	s.resetInputGeometry("monitor_switch")
	s.mu.RLock()
	cfg := s.captureConfig
	s.mu.RUnlock()
	cfg.DisplayIndex = index
	newCap, capErr := NewScreenCapturer(cfg)
	if capErr != nil {
		slog.Warn("Failed to create capturer for monitor", "display", index, "error", capErr.Error())
		// The epochs moved above. Tell the viewer it is still on its old
		// monitor, under the new geoEpoch, or its pointer stays dropped. (W2b)
		s.announceCurrentMonitor()
		return
	}
	// Force a desktop repaint so DXGI has dirty rects for the initial
	// AcquireNextFrame on the new display. Without this, a completely
	// static display (no cursor, no animations) produces zero frames.
	forceDesktopRepaint()
	// Swap capturer and signal the capture loop to reinitialize.
	// The old capturer is NOT closed here — the capture loop closes it
	// after detecting the swap, avoiding a race where Close() is called
	// while captureAndSendFrameGPU is mid-frame on the old capturer.
	s.mu.Lock()
	s.oldCapturers = append(s.oldCapturers, s.capturer)
	s.capturer = newCap
	s.displayIndex = index
	s.captureConfig = cfg
	s.mu.Unlock()
	s.capturerSwapped.Store(true)
	applyDisplayOffset(s.inputHandler, index, &s.cursorOffsetX, &s.cursorOffsetY)
	// Get bounds for viewer notification — encoder dimensions are updated
	// by the capture loop when it detects capturerSwapped, avoiding a race
	// with the encoding goroutine.
	w, h, boundsErr := newCap.GetScreenBounds()
	if boundsErr != nil {
		slog.Warn("Failed to get bounds for new monitor", "display", index, "error", boundsErr.Error())
	}
	// Notify viewer of new resolution and the epochs to use with it. (W2b)
	s.sendControlJSON(s.monitorSwitchedMessage(index, w, h))
}
```

The old body read `s.captureConfig` without the lock (line 614). Reading it under `s.mu.RLock` is
a small fix made while moving the code.

`session_capture.go` `handleDesktopSwitch` (1085-1116):
1. Directly after the `if !ok || !dsn.ConsumeDesktopSwitch() { return }` block, add:

   ```go
   	s.geometryMu.Lock()
   	defer s.geometryMu.Unlock()
   ```

2. Replace `s.releaseHeldInput("desktop_switch")` (1096) with:

   ```go
   	// Key-ups for anything held would land on the other desktop, and the
   	// input offset is about to change: a geometry transition. (W2b)
   	s.resetInputGeometry("desktop_switch")
   ```

3. Secure branch: directly after `s.cursorOffsetY.Store(0)` (before the nudge loop), add
   `s.announceCurrentMonitor()`.
4. Default branch: replace
   `applyDisplayOffset(s.inputHandler, s.displayIndex, &s.cursorOffsetX, &s.cursorOffsetY)` (1116)
   with:

   ```go
   		applyDisplayOffset(s.inputHandler, s.currentDisplayIndex(), &s.cursorOffsetX, &s.cursorOffsetY)
   		s.announceCurrentMonitor()
   ```

   Leave the rest of the function unchanged. `geometryMu` stays held until it returns, including
   the encoder restore. At worst, a monitor switch requested during a desktop switch waits for it.

`session_webrtc.go`:
1. Directly after `session.cursorStreamEnabled.Store(false)` (127), add
   `session.wireInputEpochHooks()`.
2. Replace the `OnDataChannel` callback (466-491) with:

```go
	peerConn.OnDataChannel(func(dc *webrtc.DataChannel) {
		label := dc.Label()
		switch label {
		case "input", "input-r":
			reliable := isReliableOrdered(dc.Ordered(), dc.MaxRetransmits(), dc.MaxPacketLifeTime())
			if !session.acceptViewerChannel(label, dc, reliable) {
				_ = dc.Close()
				return
			}
			if label == "input" {
				session.mu.Lock()
				session.dataChannel = dc
				session.mu.Unlock()
			}
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				session.viewerChannelMessage(label, dc, msg.Data)
			})
			dc.OnClose(func() { session.onViewerChannelClosed(label, dc) })
		case "control":
			session.mu.Lock()
			session.controlDC = dc
			session.mu.Unlock()
			session.onViewerChannelAttached("control", dc)
			dc.OnMessage(func(msg webrtc.DataChannelMessage) {
				session.viewerChannelMessage("control", dc, msg.Data)
			})
			dc.OnClose(func() { session.onViewerChannelClosed("control", dc) })
			dc.OnOpen(func() {
				// Send the current cached desktop state to this viewer so it
				// gets an initial state even if it connected after the watcher
				// quiesced. Non-darwin platforms have no cached state and this
				// is a no-op.
				m.SendDesktopStateTo(sessionID)
			})
		}
	})
```

`label` is a per-callback local, so each closure captures its own value. Calling `dc.Close()` here,
before the channel opens, is handled by pion: `handleOpen` sees the graceful close and closes the
channel (`pion/webrtc@v4.2.22 datachannel.go:337-345`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ -race -count=5`
Expected: PASS. `TestSessionHelpersToleratePlainHandler` (`session_input_test.go:65`) and
`TestHandleDesktopSwitchReleasesHeldInput` (`session_desktop_switch_test.go:29`) still pass. Every
new helper tolerates a plain handler, and `announceCurrentMonitor` is a no-op without a control
channel.

- [ ] **Step 5: Check that the hook test can fail**

1. Temporarily remove the `go` from the `onReset` hook in `wireInputEpochHooks`.
2. Run `-run TestInputEpochAnnouncementsNeverWaitOnTheSession`. Expected: FAIL ("onReset made the
   reset wait…").
3. Restore it, then repeat steps 1–2 for `onResync`. Expected: FAIL ("onResync made the worker
   wait…").
4. Restore it.

- [ ] **Step 6: Cross-OS build checks**

Run every command in Global Constraints → "Cross-OS commands". Expected: no output and exit 0 for
each. The Windows build matters here: `handleDesktopSwitch`'s secure branch calls Windows-only
`nudgeSecureDesktop`.

- [ ] **Step 7: Commit**

```bash
git add agent/internal/remote/desktop/session.go agent/internal/remote/desktop/session_input.go \
  agent/internal/remote/desktop/session_control.go agent/internal/remote/desktop/session_capture.go \
  agent/internal/remote/desktop/session_webrtc.go agent/internal/remote/desktop/session_input_reliable_test.go \
  agent/internal/remote/desktop/session_desktop_switch_test.go
git commit -m "feat(agent): serialised geometry transitions, input epoch announcements, channel replacement (#8246)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Compatibility regression, full verification, PR notes

**Files:**
- Test: `agent/internal/remote/desktop/session_input_reliable_test.go` (append)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the regression test**

```go
// An old viewer (no input-r, no seq) gets exactly W2a behaviour through every
// reset trigger: releases still happen, nothing is ever gated, and no control
// message it predates is sent.
func TestLegacyViewerKeepsWorkingAcrossEveryReset(t *testing.T) {
	s, inner := newSafeSession(t)
	sendLossy(s, `{"type":"key_down","key":"shift"}`)
	s.resetInputGeometry("monitor_switch")
	s.onPeerDisconnected()
	s.onViewerChannelAttached("input", new(int))
	s.onViewerChannelAttached("input", new(int)) // replacement
	waitFor(t, "the replacement reset", func() bool { e, _ := s.safeInput().Epochs(); return e == 4 })

	sendLossy(s, `{"type":"key_down","key":"a"}`)
	sendLossy(s, `{"type":"mouse_move","x":3,"y":4}`)
	sendLossy(s, `{"type":"mouse_down","x":3,"y":4,"button":"left"}`)
	s.safeInput().sync()

	want := []string{"key_down:shift", "key_up:shift", "key_down:a", "mouse_move:3,4:", "mouse_down:3,4:left"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
	if _, ok := s.inputEpochAnnouncement("x"); ok {
		t.Fatal("a legacy viewer would be sent input_epoch")
	}
}
```

- [ ] **Step 2: Run it, then prove it can fail**

1. Run: `cd agent && go test ./internal/remote/desktop/ -run TestLegacyViewerKeepsWorkingAcrossEveryReset -race`.
   Expected: PASS. This is a regression guard; the behaviour is already built.
2. Temporarily change the legacy branch of `inputOrder.discrete` to
   `if o.v2 || o.awaitingReset { return orderDrop, dropLegacyAfterV2 }`.
3. Re-run. Expected: FAIL.
4. Revert.

- [ ] **Step 3: Full verification**

1. `cd agent && go test -race -count=3 ./internal/remote/... ./internal/heartbeat/...` → PASS.
2. `cd agent && go test -race -count=50 ./internal/remote/desktop/ -run 'TestSafeInput|TestInputOrder|TestInputR|TestSession|TestSuperseded|TestReplacing|TestLegacyViewer'`
   → PASS. This flushes out ordering flakes.
3. The four cross-OS commands from Global Constraints → exit 0.
4. `cd agent && CGO_ENABLED=0 go test ./internal/remote/desktop/ ./internal/heartbeat/` → PASS.
   This mirrors the Linux CI job's cgo-off build.
5. Recommended, not gating: run the Windows test binary on the Windows lab VM. CI never runs this
   package on Windows.
   1. Build it: `cd agent && GOOS=windows GOARCH=amd64 go test -c -o /tmp/desktop.test.exe ./internal/remote/desktop/`.
   2. Run it on the VM: `desktop.test.exe -test.run "TestInputOrder|TestSafeInput|TestSession|TestInputR|TestLegacyViewer" -test.count 5`.
   3. The worker owns `LockOSThread`/`SetThreadDesktop` there.

   See memory `devpush_to_remote_vm_gotchas.md` for copying to the lab VM.
6. `git log --oneline origin/feature/8236-viewer-input-clipboard/wave-8238..HEAD` shows the six
   implementation commits on `feature/8236-viewer-input-clipboard/wave-8246`.

- [ ] **Step 4: Commit**

```bash
git add agent/internal/remote/desktop/session_input_reliable_test.go
git commit -m "test(agent): old viewers keep W2a input behaviour across every reset (#8246)" \
  -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: PR description checklist** (do not open the PR before W2a #8251 merges and the
  branch is rebased onto `origin/main`)
  - `Closes #8246`.
  - Paste the "Wire protocol" section above. W3 implements against it.
  - State that WS sessions stay legacy, and that no viewer change ships in this PR.
  - Lab drills owed in W3's sweep, since they need a W3 viewer:
    - pull the network mid-chord;
    - switch monitor mid-drag;
    - force retransmission (e.g. `tc netem loss 20%` on a Linux viewer host) and check that a
      click never lands at an older pointer position.

---

## Race and concurrency analysis

**Goroutines that touch input** (W2a plus W2b):

| Goroutine | Source | Touches |
|---|---|---|
| pion `input` readLoop | `datachannel.go:404-443`, one per channel, synchronous handler | `offerMove` (fire-and-forget), legacy discrete `submit` (waits) |
| pion `input-r` readLoop | same | sequenced discrete `submitJob` (waits), `SkipSeq` (waits) |
| pion `control` readLoop | same | `type_text` → `InjectText`; `switch_monitor` → `switchMonitor` (holds `geometryMu`; `ResetGeometry` bounded); `input_capabilities` → `Epochs()` |
| pion accept loop | `sctptransport.go:358-359`: waits for `OnDataChannel` before opening the channel | `acceptViewerChannel`/`attachViewerChannel` (takes `s.mu` briefly); a replacement reset is spawned with `go` |
| pion state callback | `session_webrtc.go:578-582` | `go onPeerDisconnected()` → `ReleaseAll` |
| capture loop | `session_capture.go:1085-1116` | `handleDesktopSwitch` (holds `geometryMu`; `ResetGeometry` bounded) |
| hook goroutines | spawned by `wireInputEpochHooks` | `announceInputEpoch` → `s.mu.RLock` + `controlDC.SendText` |
| any reset trigger | the callers above | `SafeInput.reset`: moves the epochs under `orderMu`, calls `onReset`, then submits the urgent release |
| **SafeInput worker** | `input_safe.go:77-106` | judges events under `orderMu`; sole owner of `heldInput`, `drops`, `discardBelow`, `lastResync` |

**Why the epoch checks are race-free (with R1).** The reset trigger moves the epoch under `orderMu`.
The worker judges every event under `orderMu`, at injection time, never at submission. Consider
three kinds of event:

| The event was judged… | What happens |
|---|---|
| before the bump | It was injected inside its own job. The release job is submitted after the bump and runs on the same single worker after that job, so it releases whatever the event pressed. |
| after the bump, carrying the old epoch | It is dropped (`errInputDropped`). |
| still queued before the bump (generation `< gen`) when the release job ran | It is answered `errInputReset` when dequeued (R1b). |

Jobs submitted after the bump carry the new generation and survive, in order. That includes a
handshake acknowledging the new epoch.

`TestSafeInputSequencedPressCannotOutliveAReset`, `TestSafeInputEpochsMoveEvenWhenTheWorkerIsWedged`
and `TestSafeInputHandshakeQueuedBehindAResetSurvivesIt` pin this. A submission-time check would
lose the race: the pion goroutine could check, lose the CPU, and enqueue after the release.

**Why the barrier is correct across two channels.** Let `L = lastDiscrete` on the worker. A pending
move `M` with `M.after == L` was sent after discrete event `L` and before any later discrete event.
Pre-flushing it at the start of the next sequenced discrete job `S` (`S > L`) therefore injects it
exactly where the viewer sent it. A move with `M.after == S` waits, then post-flushes immediately
after `S`. A move with `M.after < L` was sent before a discrete event that is already injected; that
event carries its own coordinates, so `M` is dropped (spec §1).

The barrier advances only on the worker, in queue order:
- `discrete()` for sequenced events;
- `SkipSeq` jobs for `input-r` events rejected before the worker.

It therefore never runs ahead of an event still queued. Skips are restricted to `input-r` because
only its seqs arrive in order (see `skipRejectedSeq`).

A move is judged on epoch and geometry **before** the barrier (R2). So a move can never wait on a
barrier that a reset made unreachable.

**Lock graph** (no cycles):
- `geometryMu` → `s.mu`, plus bounded waits on the worker.
  - Held by `switchMonitor` and `handleDesktopSwitch` only.
  - Never taken while holding `s.mu`.
  - Never taken by the worker or the hooks.
- `moveMu` → `orderMu`: `flushMove` judges under both. `orderMu` is a leaf: nothing is called
  while holding it.
- `s.mu` is never held while waiting on the worker:
  - `switchMonitor` takes `s.mu` only around the capturer swap and the config read.
  - `StopWithReason` releases `s.mu` before `doCleanup` (`session.go:523-530`).
  - `attachViewerChannel` and `onViewerChannelClosed` release `s.mu` before any release.
- The worker never takes `s.mu`, and `onReset` never makes its caller wait on it: both hooks only
  spawn (`TestInputEpochAnnouncementsNeverWaitOnTheSession`).
- `SessionManager.SetAtLoginWindow` still holds `m.mu.RLock` across a bounded urgent submit
  (`session.go:299-305`). That is unchanged W2a behaviour, bounded by `safeInputCloseTimeout`.
- Teardown:
  - `doCleanup` takes neither `geometryMu` nor `orderMu`.
  - `Stop` waits for the capture goroutine. That goroutine can wait on `geometryMu` only while a
    `switchMonitor` holds it, which is bounded by `closeTimeout` plus `NewScreenCapturer`.

**Wedged platform handler** (for example, a long `type_text` paste in progress). All new waits use
the W2a bounded paths:
- `ResetGeometry` and `ReleaseAll` wait at most `closeTimeout` for the release job. **The epochs
  have already moved** (R1), so `monitor_switched` and the capabilities reply are correct even when
  the release itself is late.
- `SkipSeq` and sequenced `HandleEvent` wait unbounded, like W2a discrete events. That stalls only
  the `input-r` readLoop, which SCTP back-pressures, and teardown stays bounded by `Close`.
- If the urgent release job could not even be queued (urgent queue full past the timeout), keys
  pressed under the old epoch stay held until one of:
  - the next successful release;
  - the viewer's handshake, which releases in order;
  - `Close`.

  That is the same failure mode as W2a.

**No-strand invariant: proof by case.** Each ordering-layer drop, and why nothing it drops can be
a release of something held:

| Drop reason | Why no held key or button can be stranded |
|---|---|
| `stale_epoch`, `awaiting_reset` | Each epoch bump is followed by a release job that runs after every event judged under the old epoch, and releases what they pressed. Every press injected since was judged under the current epoch, so its release carries it too, unless another reset intervenes, which releases again. |
| `stale_geometry` | The geometry epoch only moves together with a reset (`agentReset(true)`). Same argument. |
| `legacy_after_v2` | v2 latches only on an accepted `input_reset`, whose job releases everything held, including keys pressed by legacy events. |
| `duplicate_seq` | It cannot happen with a well-formed stream: an unreliable `input-r` is refused (R6), and only `input-r` seqs reach `discrete` or `skip`. A viewer that sends non-increasing seqs on purpose can hold keys anyway. |
| `behind_barrier`, `older_move`, move drops | Moves press nothing. |
| `invalid_reset` | `input_reset` presses nothing. |
| superseded-channel messages (R5) | The replacement's reset releases everything the old channel pressed. The old channel's messages are muted from the moment the replacement is recorded, downs and ups alike. |

**Announcements are best-effort; liveness comes from the resync.** `input_epoch` may be:
- lost: sent while ICE was disconnected, or before the control channel opened;
- reordered: two quick resets each spawn a goroutine.

The viewer takes the maximum epoch. Any later sequenced event with a stale epoch triggers a resync
announcement, at most every `inputResyncInterval`. With R2, that includes mouse-only activity. Any
viewer that keeps using the session therefore learns the epoch.

Geometry is not resynced from drops. It is always announced by the transition itself, after the
offset is committed, so it never runs ahead of the geometry.

---

## Spec ambiguities resolved here

1. **Agent → viewer epoch notification.** The spec names `input_reset{epoch}` but no announcement.
   Chosen: a new `input_epoch{epoch, reason}` control message, sent only to viewers that opened
   `input-r`; plus `inputEpoch`/`geoEpoch` in `input_capabilities` and `monitor_switched`.
2. **Viewer-initiated `input_reset`.** The spec says resets "jump the queue". Chosen: that applies
   to agent-side resets. A viewer's `input_reset` releases **in order**, behind what it already
   sent, and does not bump the epoch. A bump would force a round trip on every focus loss.
3. **How a sequenced stream starts.** Chosen: it opens with `input_reset{inputEpoch}`. Before that,
   unsequenced input keeps exact W2a semantics. After it, unsequenced input is dropped.
4. **Geometry epoch scope and timing.**
   - **Scope.** The spec ties the geometry epoch to monitor switches. Chosen: every change of the
     input coordinate mapping. That includes desktop switches (UAC, lock, Winlogon), whose offset
     change would otherwise let a click land under the wrong offset (R3).
   - **Timing.** Bumped with the reset at the *start* of the transition, under `geometryMu`.
   - **Announcement.** Only via `monitor_switched`, after the offset commit. On a failed or
     same-monitor transition it repeats the current monitor.
   - Key events ignore geometry.
5. **Barrier liveness.** Every discrete seq handled, whatever its fate, advances the barrier.
   Events rejected before the worker advance it through `SkipSeq`, only for `input-r`. Moves are
   judged on epoch first (R2).
6. **"Transport replacement"** means a second data channel with an existing label on the same peer
   connection. It resets. The superseded channel is muted, and its late close does not reset. (A new
   peer connection is a new `Session` and starts fresh.)
7. **"Input revocation" and "view-only activation" triggers.**
   - Revocation already stops the session, and `doCleanup` calls `closeInput`
     (`session.go:586-589`).
   - View-only is viewer-local (W5); the viewer sends `input_reset` when entering it.
   - Neither needs new agent code.
8. **Idle.** `input-r` counts, except `input_reset`.
9. **`input-r` opened unreliable** (viewer bug). The agent closes it and does not route it (R6). The
   viewer falls back to legacy on close (W3 obligation 6).

---

## Review amendments (2026-10-08, independent Codex review, gpt-6-astra, `xhigh`, read-only)

Codex reviewed the first draft of this plan against the W2a code. Each finding was re-checked
against the code before it was accepted. The tasks above already include every accepted fix; this
section records why.

| # | Sev | Finding | Verdict | Fold-in |
|---|---|---|---|---|
| R1 | High | A geometry reset that times out (worker wedged, e.g. a long paste) leaves `monitor_switched` announcing the old `geoEpoch`. The late job bumps it, the viewer's pointer is dropped as stale-geometry for good, and nothing asks for a resync. | **Confirmed.** The draft bumped inside the urgent job (`submit(true, closeTimeout, …)` returns on timeout, `input_safe.go:172-206`). | The epochs move synchronously under `orderMu` at the trigger (Task 4 `reset`). New test `TestSafeInputEpochsMoveEvenWhenTheWorkerIsWedged`. |
| R1b | — | Found while fixing R1: W2a's eager `discardQueued` would also discard a handshake queued after the bump but before the urgent job ran. A mouse-only viewer would then be stuck. | **Confirmed by reasoning.** | Lazy discard by reset generation (`safeInputJob.gen`, `discardBelow`). New test `TestSafeInputHandshakeQueuedBehindAResetSurvivesIt`. |
| R2 | High | `move()` waited on `after > lastDiscrete` before checking the epoch. A reset discards queued discrete events without advancing the barrier. With a lost announcement, a mouse-only viewer's moves wait forever and never ask for a resync. | **Confirmed.** | Epoch and geometry are checked before the barrier wait (Task 2). New tests `TestInputOrderStaleEpochMoveDoesNotWaitOnADiscardedBarrier` and `TestSafeInputStaleMoveAsksForResync`. |
| R3 | High | A desktop switch releases (and announces) before `handleDesktopSwitch` moves the offset (`session_capture.go:1096` vs `1101/1116`). A W3 viewer could acknowledge and click under the old offset. | **Confirmed.** The window is small, but it is real if the worker is slow. | A desktop switch is a geometry transition: `resetInputGeometry` before the offset, `announceCurrentMonitor` after it (Task 6). New test `TestHandleDesktopSwitchMovesTheGeometryEpoch`. |
| R4 | High | The capture loop's desktop switch and the control channel's monitor switch interleave their offset writes, and `s.displayIndex` is read unlocked at `session_capture.go:1116` against a locked write at `session_control.go:632`. | **Confirmed.** Pre-existing in W2a and earlier; it breaks W2b's geometry guarantee. | `Session.geometryMu` serialises both transitions; `currentDisplayIndex()` reads under `s.mu` (Task 6). |
| R5 | High | Replacing the control channel leaves both channels' handlers live (separate pion readLoops). Two monitor switches can then interleave under one geometry epoch. | **Confirmed.** | `geometryMu` serialisation. Superseded channels are muted at arrival (`viewerChannelMessage`). New test `TestSupersededChannelMessagesAreIgnored`. |
| R6 | Med | Accepting an unordered or partially reliable `input-r` voids the barrier proof. An overtaking discrete event makes a later `key_up` a `duplicate_seq` drop, leaving the key latched. The draft's "no worse than legacy" claim was false. | **Confirmed.** | Such an `input-r` is refused and closed. W3 falls back on close (Task 6 `acceptViewerChannel`, `TestUnreliableInputRIsRefused`; W3 obligation 6). |
| R7 | Med | `onViewerChannelClosed` checks then unlocks. If a replacement attaches in between, the old close's reset hits the new stream. | **Rejected as a safety issue.** The outcome is one spurious reset, which is safe: no latch, no stale injection, and the viewer re-handshakes. The suggested generation guard would skip the reset, and so strand keys a legacy viewer pressed through the closed channel. | Recorded in the `onViewerChannelClosed` comment. |
| R8 | Med | The hook non-blocking test passed with a synchronous announcement (no lock contention, nil DC). | **Confirmed.** | Rewritten as `TestInputEpochAnnouncementsNeverWaitOnTheSession`: it holds `s.mu`, uses a deadline below every internal timeout, and has a can-fail step for both hooks (Task 6 Step 5). |
| R9 | Low | The Task 3 overtaking mutation would have failed for the wrong reason: a `len(s.jobs)==1` timeout, and `injectMoveNow` dropping a waiting move. | **Confirmed.** | The mutation now deletes the barrier-wait line in `inputOrder.move` (Task 3 Step 5). |

Codex also checked, and found no problems with:
- ordinary legacy, WS and W3-fallback compatibility;
- compilation of the proposed tests;
- data races in the proposed tests;
- new lock cycles between the worker, `Session.mu` and `moveMu`.

**Follow-up outside this wave** (to file when the PR opens): `handleDesktopSwitch` continues to use
the capturer it snapshotted before the swap for its encoder-restore logic (`session_capture.go:1086-1130`).
That is pre-existing. `geometryMu` now orders it against monitor switches, but whether the encoder
restore should re-read `s.capturer` is a capture-pipeline question, not an input one.

---

## Self-review

- **Spec coverage.**
  - `input-r` → Tasks 5–6.
  - `seq`/`after` barrier → Tasks 2–3.
  - Reset epoch, queue drain and gating → Tasks 2 and 4.
  - `input_reset` → Tasks 2–3 and 5.
  - Geometry epoch → Tasks 2, 4 and 6.
  - Further reset triggers (transport replacement) → Task 6.
  - Idle on `input-r` → Task 5.
  - Advertised via `input_capabilities` → Task 5.
  - Backward compatibility, both directions → the matrix plus Tasks 1, 4 and 7.
  - W2a items (tracker, worker, normalizer, `key_press` modifiers) are already shipped and
    untouched.
- **Placeholder scan.** No TBD/TODO. Every code step shows its code.
- **Type consistency.**
  - `Seq`, `After` are `uint64`; `Epoch`, `GeoEpoch` are `uint32`. `Epochs()` returns `uint32`,
    and the tests compare against `uint32(…)`.
  - Reset generations are `uint64`, so they cannot wrap in practice; wire epochs wrap to 1, never
    to 0.
  - `inputOrder.agentReset(geometry bool)` is called only by `SafeInput.reset`, under `orderMu`.
  - `judgeDiscrete`, `judgeMove` and `skipOrder` are the only other `inputOrder` callers.
  - `onViewerChannelAttached`, `onViewerChannelClosed`, `isCurrentViewerChannel` and
    `viewerChannelMessage` all take `(label string, ch any …)`.
  - `announceCurrentMonitor` is the only name. The draft's `announceUnchangedMonitor` was renamed.
- **Review Focus.** Each of the five lines names a test in its owning task.
