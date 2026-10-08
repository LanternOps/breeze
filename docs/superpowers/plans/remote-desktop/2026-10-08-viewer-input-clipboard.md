---
tracking_issue: LanternOps/breeze#8236
---

# Remote Viewer Input — W2a Agent Held-Input Safety Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The agent never leaves a key or mouse button held down on the customer's machine. When a
viewer vanishes, a channel closes, the monitor switches, or the input desktop changes, the agent
releases everything it pressed.

**Architecture:** A `SafeInput` decorator wraps every session's platform `InputHandler`. One worker
goroutine owns all injection for that session: input events, pasted text, display offsets, and
releases. That fixes the Windows thread-affinity problem and the unsynchronised macOS handler fields.
A `heldInput` record, touched only by the worker, tracks what is down. `ReleaseAll` jumps the queue,
discards queued input, and injects the releases. The WebRTC input path gets the same validation
bounds as the WebSocket relay. No wire-protocol change: this benefits every viewer, old and new.

**Tech Stack:** Go 1.x agent, pion/webrtc v4. Platform handlers: `input_windows.go` (SendInput),
`input_darwin.go` (CGEvent), `input_linux.go` (XTEST).

**Spec:** `docs/superpowers/specs/remote-desktop/2026-10-07-viewer-input-clipboard-convenience-design.md`
§2 "Agent held-state tracker". Gotchas K3, M4, M5, K5 (agent half).

**Scope of this plan:** wave W2a only.
- **W2b** (later plan) is the protocol work: the `input-r` reliable channel, `seq`/`after`, reset
  and geometry epochs, `input_reset`, and idle accounting on `input-r`.
- **W2c** (later plan) is key and pointer coverage: `code` → scancode, extended keys,
  back/forward, horizontal wheel, Num/Caps sync, and the macOS flags mask.

## Global Constraints

- Ships to customer machines. Full rigor: TDD, `go test -race`, and Windows + Linux cross-compile vet
  before every commit that touches `agent/`.
- No wire-protocol change except one additive `input_capabilities` key: `"releasesHeldInput": true`.
  Old viewers ignore unknown keys.
- Never log key names, typed text, or clipboard content above `Debug`. Counts and reasons only.
- Existing tests that build `&Session{inputHandler: stub}` without a `SafeInput` must keep passing.
  Every new Session helper falls back to the raw handler.
- Validation bounds are copied verbatim from the WebSocket relay (`heartbeat/handlers_desktop.go`):
  - coordinates `|v| ≤ 100000`;
  - scroll delta `|d| ≤ 120`;
  - key length ≤ 64 bytes;
  - at most 8 modifiers;
  - buttons `"", left, right, middle`.
- Only `ctrl`, `alt`, and `shift` are filtered out of a `key_press` when already held. `meta` is
  ambiguous on Windows: in `key_press` it is injected as Ctrl, as a held key it is the Win key.

## Review Focus

1. **Worker stuck inside a long `type_text` while the viewer disconnects.** `ReleaseAll` and
   `Close` must return within `inputCloseTimeout` and not deadlock teardown. Covered in Task 3
   (`TestSafeInputCloseDoesNotHangOnStuckHandler`).
2. **`Close` twice, or `ReleaseAll`/`HandleEvent` after `Close`.** No panic, no block, and
   `errInputClosed` is returned. Covered in Task 3.
3. **macOS modifier `key_down` fails** (that agent cannot hold modifiers). It must not be tracked
   as held, so a following `key_press` keeps its modifiers. Covered in Task 2
   (`TestHeldInputDoesNotTrackFailedPress`).
4. **Key names in different case** (`"Shift"` down, `"shift"` up). The release must match the
   press. Covered in Task 2.
5. **A flood of `mouse_move` during a slow discrete job.** Moves coalesce to one, memory stays
   bounded, and a move sent before a `mouse_down` is injected before it. Covered in Task 3.

---

### Task 1: Shared input validation on the WebRTC path

**Files:**
- Create: `agent/internal/remote/desktop/input_validate.go`
- Create: `agent/internal/remote/desktop/input_validate_test.go`
- Modify: `agent/internal/remote/desktop/session_control.go` (`handleInputMessage`, after `json.Unmarshal`)
- Modify: `agent/internal/heartbeat/handlers_desktop.go:19-24`. The constants become aliases of the
  desktop ones, so there is one source of truth.

**Interfaces:**
- Produces: `func ValidateInputEvent(ev InputEvent) error`, plus exported constants
  `MaxInputCoordinateAbs = 100000`, `MaxInputScrollDelta = 120`, `MaxInputKeyBytes = 64` and
  `MaxInputModifiers = 8`.

- [ ] **Step 1: Write the failing test**

```go
package desktop

import (
	"strings"
	"testing"
)

func TestValidateInputEvent(t *testing.T) {
	cases := []struct {
		name    string
		ev      InputEvent
		wantErr bool
	}{
		{"move ok", InputEvent{Type: "mouse_move", X: 10, Y: 20}, false},
		{"negative coords ok (secondary monitor left of primary)", InputEvent{Type: "mouse_move", X: -1920, Y: 0}, false},
		{"unknown type", InputEvent{Type: "file_drop"}, true},
		{"x too large", InputEvent{Type: "mouse_move", X: MaxInputCoordinateAbs + 1}, true},
		{"y too negative", InputEvent{Type: "mouse_move", Y: -MaxInputCoordinateAbs - 1}, true},
		{"scroll ok", InputEvent{Type: "mouse_scroll", Delta: -3}, false},
		{"scroll too large", InputEvent{Type: "mouse_scroll", Delta: MaxInputScrollDelta + 1}, true},
		{"scroll too negative", InputEvent{Type: "mouse_scroll", Delta: -MaxInputScrollDelta - 1}, true},
		{"button ok", InputEvent{Type: "mouse_down", Button: "right"}, false},
		{"button empty ok", InputEvent{Type: "mouse_down"}, false},
		{"button unknown", InputEvent{Type: "mouse_down", Button: "back"}, true},
		{"key ok", InputEvent{Type: "key_down", Key: "a"}, false},
		{"key missing", InputEvent{Type: "key_down"}, true},
		{"key blank", InputEvent{Type: "key_up", Key: "  "}, true},
		{"key too long", InputEvent{Type: "key_press", Key: strings.Repeat("a", MaxInputKeyBytes+1)}, true},
		{"too many modifiers", InputEvent{Type: "key_press", Key: "a", Modifiers: make([]string, MaxInputModifiers+1)}, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateInputEvent(tc.ev)
			if (err != nil) != tc.wantErr {
				t.Fatalf("ValidateInputEvent(%+v) err=%v, wantErr=%v", tc.ev, err, tc.wantErr)
			}
		})
	}
}

func TestHandleInputMessageDropsOutOfRangeEvent(t *testing.T) {
	handler := &stubInputHandler{}
	session := &Session{id: "session-1", inputHandler: handler}

	session.handleInputMessage([]byte(`{"type":"mouse_scroll","x":1,"y":1,"delta":100000}`))

	if len(handler.events) != 0 {
		t.Fatalf("out-of-range scroll reached the platform handler: %+v", handler.events)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestValidateInputEvent|TestHandleInputMessageDropsOutOfRangeEvent' -race`
Expected: FAIL to compile with `undefined: ValidateInputEvent`. After a stub exists, the
`delta:100000` event reaches the handler.

- [ ] **Step 3: Write minimal implementation**

`agent/internal/remote/desktop/input_validate.go`:

```go
package desktop

import (
	"fmt"
	"strings"
)

// Bounds shared by every path that carries viewer input to a platform
// handler. The WebSocket relay (heartbeat/handlers_desktop.go) parses and
// canonicalises loosely typed JSON first; the WebRTC input channel decodes
// straight into InputEvent and is checked here. One set of numbers for both.
const (
	MaxInputCoordinateAbs = 100000
	MaxInputScrollDelta   = 120
	MaxInputKeyBytes      = 64
	MaxInputModifiers     = 8
)

var validInputTypes = map[string]struct{}{
	"mouse_move": {}, "mouse_click": {}, "mouse_down": {}, "mouse_up": {},
	"mouse_scroll": {}, "key_press": {}, "key_down": {}, "key_up": {},
}

var validInputButtons = map[string]struct{}{"": {}, "left": {}, "right": {}, "middle": {}}

// ValidateInputEvent rejects an event a well-behaved viewer never sends. The
// viewer is untrusted: without this, the WebRTC path handed SendInput an
// unbounded scroll delta and arbitrary coordinates (spec gotcha M4).
func ValidateInputEvent(ev InputEvent) error {
	if _, ok := validInputTypes[ev.Type]; !ok {
		return fmt.Errorf("invalid event type")
	}
	if absInt(ev.X) > MaxInputCoordinateAbs || absInt(ev.Y) > MaxInputCoordinateAbs {
		return fmt.Errorf("coordinate out of range")
	}
	if absInt(ev.Delta) > MaxInputScrollDelta {
		return fmt.Errorf("scroll delta out of range")
	}
	if _, ok := validInputButtons[strings.ToLower(ev.Button)]; !ok {
		return fmt.Errorf("invalid mouse button")
	}
	if len(ev.Key) > MaxInputKeyBytes {
		return fmt.Errorf("key too long")
	}
	switch ev.Type {
	case "key_press", "key_down", "key_up":
		if strings.TrimSpace(ev.Key) == "" {
			return fmt.Errorf("key is required for keyboard events")
		}
	}
	if len(ev.Modifiers) > MaxInputModifiers {
		return fmt.Errorf("too many modifiers")
	}
	return nil
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
```

If `absInt` already exists in the package (`grep -n "func absInt" agent/internal/remote/desktop/*.go`),
delete the copy above.

In `session_control.go` `handleInputMessage`, directly after the `json.Unmarshal` error branch:

```go
	if err := ValidateInputEvent(event); err != nil {
		slog.Warn("Rejected invalid input event", "session", s.id, "type", event.Type, "error", err.Error())
		return
	}
```

In `heartbeat/handlers_desktop.go`, replace the values of the four matching constants:

```go
	maxDesktopCoordinateAbs = desktop.MaxInputCoordinateAbs
	maxDesktopScrollDelta   = desktop.MaxInputScrollDelta
	maxDesktopKeyBytes      = desktop.MaxInputKeyBytes
	maxDesktopModifiers     = desktop.MaxInputModifiers
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ ./internal/heartbeat/ -race`
Expected: PASS (including all pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/input_validate.go agent/internal/remote/desktop/input_validate_test.go agent/internal/remote/desktop/session_control.go agent/internal/heartbeat/handlers_desktop.go
git commit -m "fix(agent): validate WebRTC desktop input with the WS relay's bounds (#8238)"
```

---

### Task 2: `heldInput` — the record of what the agent has pressed

**Files:**
- Create: `agent/internal/remote/desktop/input_held.go`
- Create: `agent/internal/remote/desktop/input_held_test.go`

**Interfaces:**
- Produces (unexported, worker-goroutine-only):
  - `newHeldInput() *heldInput`;
  - `(*heldInput).prepare(ev InputEvent) InputEvent`;
  - `(*heldInput).observe(ev InputEvent, err error)`;
  - `(*heldInput).releases() []InputEvent`;
  - `(*heldInput).count() int`.

- [ ] **Step 1: Write the failing test**

```go
package desktop

import (
	"errors"
	"reflect"
	"testing"
)

func TestHeldInputReleasesEverythingHeld(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "a"}, nil)
	h.observe(InputEvent{Type: "mouse_down", X: 40, Y: 50, Button: "left"}, nil)
	h.observe(InputEvent{Type: "mouse_move", X: 60, Y: 70}, nil)

	got := h.releases()
	want := []InputEvent{
		// Buttons first: a shift-drag must end as a shift-drag.
		{Type: "mouse_up", X: 60, Y: 70, Button: "left"},
		{Type: "key_up", Key: "a"},
		{Type: "key_up", Key: "shift"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("releases:\n got %+v\nwant %+v", got, want)
	}
	if again := h.releases(); len(again) != 0 {
		t.Fatalf("second releases() should be empty, got %+v", again)
	}
}

func TestHeldInputForgetsReleasedKeys(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "Shift"}, nil)
	h.observe(InputEvent{Type: "key_up", Key: "shift"}, nil)
	h.observe(InputEvent{Type: "mouse_down", Button: ""}, nil) // "" means left
	h.observe(InputEvent{Type: "mouse_up", Button: "left"}, nil)
	if n := h.count(); n != 0 {
		t.Fatalf("count = %d, want 0", n)
	}
}

func TestHeldInputDoesNotTrackFailedPress(t *testing.T) {
	// The macOS agent rejects a standalone modifier key_down. It is not held
	// on the remote, so it must not be released or filtered later.
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, errors.New("unknown key"))
	if n := h.count(); n != 0 {
		t.Fatalf("count = %d, want 0", n)
	}
	ev := h.prepare(InputEvent{Type: "key_press", Key: "a", Modifiers: []string{"shift"}})
	if !reflect.DeepEqual(ev.Modifiers, []string{"shift"}) {
		t.Fatalf("modifiers = %v, want [shift]", ev.Modifiers)
	}
}

func TestHeldInputDoesNotTrackLockKeys(t *testing.T) {
	h := newHeldInput()
	for _, k := range []string{"capslock", "numlock", "scrolllock"} {
		h.observe(InputEvent{Type: "key_down", Key: k}, nil)
	}
	if n := h.count(); n != 0 {
		t.Fatalf("lock keys are toggles, not held: count = %d", n)
	}
}

func TestHeldInputPrepareDropsHeldModifiersFromKeyPress(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "control"}, nil)
	h.observe(InputEvent{Type: "key_down", Key: "meta"}, nil)

	ev := h.prepare(InputEvent{Type: "key_press", Key: "a", Modifiers: []string{"ctrl", "shift", "alt", "meta"}})

	// ctrl and shift are already down: re-pressing them inside key_press would
	// release them on the way out (spec K5). alt is not held, so it stays.
	// meta stays: in key_press the Windows agent injects it as Ctrl, while a
	// held meta is the Win key, so they are not the same key.
	if want := []string{"alt", "meta"}; !reflect.DeepEqual(ev.Modifiers, want) {
		t.Fatalf("modifiers = %v, want %v", ev.Modifiers, want)
	}
}

func TestHeldInputPrepareLeavesOtherEventsAlone(t *testing.T) {
	h := newHeldInput()
	h.observe(InputEvent{Type: "key_down", Key: "shift"}, nil)
	in := InputEvent{Type: "key_down", Key: "a", Modifiers: []string{"shift"}}
	if got := h.prepare(in); !reflect.DeepEqual(got, in) {
		t.Fatalf("prepare changed a non-key_press event: %+v", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/ -run TestHeldInput -race`
Expected: FAIL to compile, `undefined: newHeldInput`.

- [ ] **Step 3: Write minimal implementation**

`agent/internal/remote/desktop/input_held.go`:

```go
package desktop

import (
	"sort"
	"strings"
)

// heldInput records the keys and mouse buttons the agent has pressed on the
// remote machine and not yet released, so they can all be released when the
// viewer can no longer send the releases itself (spec gotcha K3).
//
// Only the SafeInput worker goroutine touches it; it is not safe for
// concurrent use.
type heldInput struct {
	keys        map[string]struct{}
	buttons     map[string]struct{}
	lastX       int
	lastY       int
}

func newHeldInput() *heldInput {
	return &heldInput{keys: map[string]struct{}{}, buttons: map[string]struct{}{}}
}

// Toggle keys change state on press. They are never "held", and releasing
// them would be a bogus key_up.
var heldInputToggleKeys = map[string]struct{}{"capslock": {}, "numlock": {}, "scrolllock": {}}

// Modifiers that mean the same key whether held via key_down or bundled in a
// key_press. "meta" is excluded: bundled, the Windows agent injects it as Ctrl
// (Mac Cmd → Ctrl); held, it is the Win key.
var heldInputFilterableModifiers = map[string]struct{}{"ctrl": {}, "alt": {}, "shift": {}}

func heldKeyName(key string) string {
	k := strings.ToLower(strings.TrimSpace(key))
	if k == "control" {
		return "ctrl"
	}
	return k
}

func heldButtonName(button string) string {
	b := strings.ToLower(strings.TrimSpace(button))
	if b == "" {
		return "left"
	}
	return b
}

// prepare rewrites an event before injection. A key_press whose modifiers are
// already held loses those modifiers: the platform handler would press them
// again and release them on the way out, leaving the operator's still-held
// Shift released on the remote (spec gotcha K5).
func (h *heldInput) prepare(ev InputEvent) InputEvent {
	if ev.Type != "key_press" || len(ev.Modifiers) == 0 {
		return ev
	}
	kept := make([]string, 0, len(ev.Modifiers))
	for _, m := range ev.Modifiers {
		name := heldKeyName(m)
		if _, filterable := heldInputFilterableModifiers[name]; filterable {
			if _, held := h.keys[name]; held {
				continue
			}
		}
		kept = append(kept, m)
	}
	ev.Modifiers = kept
	return ev
}

// observe updates the record after the platform handler ran ev. A press that
// failed is not held on the remote and is not recorded; a release always
// clears the record, whatever the handler returned.
func (h *heldInput) observe(ev InputEvent, err error) {
	switch ev.Type {
	case "mouse_move", "mouse_click", "mouse_down", "mouse_up", "mouse_scroll":
		h.lastX, h.lastY = ev.X, ev.Y
	}
	switch ev.Type {
	case "key_down":
		name := heldKeyName(ev.Key)
		if _, toggle := heldInputToggleKeys[name]; toggle || err != nil {
			return
		}
		h.keys[name] = struct{}{}
	case "key_up":
		delete(h.keys, heldKeyName(ev.Key))
	case "mouse_down":
		if err == nil {
			h.buttons[heldButtonName(ev.Button)] = struct{}{}
		}
	case "mouse_up":
		delete(h.buttons, heldButtonName(ev.Button))
	}
}

// releases returns the events that release everything held, buttons first
// (so a shift-drag ends as a shift-drag), then clears the record.
func (h *heldInput) releases() []InputEvent {
	out := make([]InputEvent, 0, len(h.buttons)+len(h.keys))
	for _, b := range sortedSetKeys(h.buttons) {
		out = append(out, InputEvent{Type: "mouse_up", X: h.lastX, Y: h.lastY, Button: b})
	}
	for _, k := range sortedSetKeys(h.keys) {
		out = append(out, InputEvent{Type: "key_up", Key: k})
	}
	h.keys = map[string]struct{}{}
	h.buttons = map[string]struct{}{}
	return out
}

func (h *heldInput) count() int { return len(h.keys) + len(h.buttons) }

func sortedSetKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ -run TestHeldInput -race -v`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/input_held.go agent/internal/remote/desktop/input_held_test.go
git commit -m "feat(agent): record keys and buttons held on the remote (#8238)"
```

---

### Task 3: `SafeInput` — one worker owns all injection

**Files:**
- Create: `agent/internal/remote/desktop/input_safe.go`
- Create: `agent/internal/remote/desktop/input_safe_test.go`

**Interfaces:**
- Consumes: `heldInput` from Task 2, and `InjectText(handler InputHandler, text string) error` from
  `input_text.go`.
- Produces:
  - `func NewSafeInput(inner InputHandler, label string) *SafeInput`. It implements `InputHandler`.
  - `(*SafeInput).ReleaseAll(reason string)`.
  - `(*SafeInput).InjectText(text string) error`.
  - `(*SafeInput).Close()`.
  - `var errInputClosed`, `var errInputReset`.

- [ ] **Step 1: Write the failing test**

`agent/internal/remote/desktop/input_safe_test.go`:

```go
package desktop

import (
	"errors"
	"reflect"
	"strconv"
	"sync"
	"testing"
	"time"
)

// recordingHandler is a thread-safe InputHandler that records every call in
// order. block, when non-nil, stalls HandleEvent until closed.
type recordingHandler struct {
	stubInputHandler
	mu      sync.Mutex
	calls   []string
	failKey string
	block   chan struct{}
	texts   []string
}

func (h *recordingHandler) HandleEvent(ev InputEvent) error {
	if h.block != nil {
		<-h.block
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	switch ev.Type {
	case "key_press":
		h.calls = append(h.calls, ev.Type+":"+ev.Key+":"+joinMods(ev.Modifiers))
	case "key_down", "key_up":
		h.calls = append(h.calls, ev.Type+":"+ev.Key)
	default:
		h.calls = append(h.calls, ev.Type+":"+itoa(ev.X)+","+itoa(ev.Y)+":"+ev.Button)
	}
	if ev.Key != "" && ev.Key == h.failKey {
		return errors.New("unknown key")
	}
	return nil
}

func (h *recordingHandler) SetDisplayOffset(x, y int) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.calls = append(h.calls, "offset:"+itoa(x)+","+itoa(y))
}

func (h *recordingHandler) TypeText(text string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.texts = append(h.texts, text)
	return nil
}

func (h *recordingHandler) snapshot() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.calls...)
}

func joinMods(m []string) string {
	out := ""
	for i, s := range m {
		if i > 0 {
			out += "+"
		}
		out += s
	}
	return out
}

func itoa(v int) string { return strconv.Itoa(v) }

func TestSafeInputReleaseAllReleasesHeldInput(t *testing.T) {
	inner := &recordingHandler{}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	mustHandle(t, s, InputEvent{Type: "key_down", Key: "shift"})
	mustHandle(t, s, InputEvent{Type: "mouse_down", X: 5, Y: 6, Button: "left"})
	s.ReleaseAll("test")

	want := []string{"key_down:shift", "mouse_down:5,6:left", "mouse_up:5,6:left", "key_up:shift"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputKeyPressKeepsHeldModifiersDown(t *testing.T) {
	inner := &recordingHandler{}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	mustHandle(t, s, InputEvent{Type: "key_down", Key: "shift"})
	mustHandle(t, s, InputEvent{Type: "key_press", Key: "a", Modifiers: []string{"shift"}})

	want := []string{"key_down:shift", "key_press:a:"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputCloseReleasesAndIsIdempotent(t *testing.T) {
	inner := &recordingHandler{}
	s := NewSafeInput(inner, "t")
	mustHandle(t, s, InputEvent{Type: "key_down", Key: "ctrl"})

	s.Close()
	s.Close()

	if got := inner.snapshot(); got[len(got)-1] != "key_up:ctrl" {
		t.Fatalf("Close did not release ctrl: %v", got)
	}
	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "a"}); !errors.Is(err, errInputClosed) {
		t.Fatalf("HandleEvent after Close: err=%v, want errInputClosed", err)
	}
	s.ReleaseAll("after close") // must not block or panic
}

func TestSafeInputCloseDoesNotHangOnStuckHandler(t *testing.T) {
	inner := &recordingHandler{block: make(chan struct{})}
	defer close(inner.block)
	s := NewSafeInput(inner, "t")
	s.closeTimeout = 100 * time.Millisecond

	go func() { _ = s.HandleEvent(InputEvent{Type: "key_down", Key: "a"}) }() // wedges the worker
	time.Sleep(20 * time.Millisecond)

	done := make(chan struct{})
	go func() { s.Close(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Close blocked on a wedged platform handler")
	}
}

func TestSafeInputMovesCoalesceAndKeepOrderWithDiscreteEvents(t *testing.T) {
	inner := &recordingHandler{block: make(chan struct{})}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	// Wedge the worker on a discrete event, flood moves, then a mouse_down.
	go func() { _ = s.HandleEvent(InputEvent{Type: "key_down", Key: "x"}) }()
	time.Sleep(20 * time.Millisecond)
	for i := 1; i <= 1000; i++ {
		_ = s.HandleEvent(InputEvent{Type: "mouse_move", X: i, Y: i})
	}
	downDone := make(chan error, 1)
	go func() { downDone <- s.HandleEvent(InputEvent{Type: "mouse_down", X: 1000, Y: 1000, Button: "left"}) }()
	time.Sleep(20 * time.Millisecond)
	close(inner.block)
	if err := <-downDone; err != nil {
		t.Fatal(err)
	}

	want := []string{"key_down:x", "mouse_move:1000,1000:", "mouse_down:1000,1000:left"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputReleaseAllDiscardsQueuedInput(t *testing.T) {
	inner := &recordingHandler{block: make(chan struct{})}
	s := NewSafeInput(inner, "t")
	defer s.Close()

	go func() { _ = s.HandleEvent(InputEvent{Type: "key_down", Key: "x"}) }()
	time.Sleep(20 * time.Millisecond)
	queued := make(chan error, 1)
	go func() { queued <- s.HandleEvent(InputEvent{Type: "key_down", Key: "y"}) }()
	time.Sleep(20 * time.Millisecond)

	released := make(chan struct{})
	go func() { s.ReleaseAll("test"); close(released) }()
	time.Sleep(20 * time.Millisecond)
	close(inner.block)
	<-released

	if err := <-queued; !errors.Is(err, errInputReset) {
		t.Fatalf("queued key_down: err=%v, want errInputReset", err)
	}
	for _, c := range inner.snapshot() {
		if c == "key_down:y" {
			t.Fatalf("queued key_down ran after ReleaseAll: %v", inner.snapshot())
		}
	}
}

func TestSafeInputReturnsPlatformErrors(t *testing.T) {
	inner := &recordingHandler{failKey: "bogus"}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	if err := s.HandleEvent(InputEvent{Type: "key_down", Key: "bogus"}); err == nil {
		t.Fatal("expected the platform error to reach the caller")
	}
}

func TestSafeInputDisplayOffsetIsOrderedWithInput(t *testing.T) {
	inner := &recordingHandler{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	mustHandle(t, s, InputEvent{Type: "mouse_down", X: 1, Y: 1, Button: "left"})
	s.SetDisplayOffset(1920, 0)
	mustHandle(t, s, InputEvent{Type: "mouse_up", X: 2, Y: 2, Button: "left"})
	want := []string{"mouse_down:1,1:left", "offset:1920,0", "mouse_up:2,2:left"}
	if got := inner.snapshot(); !reflect.DeepEqual(got, want) {
		t.Fatalf("calls:\n got %v\nwant %v", got, want)
	}
}

func TestSafeInputInjectTextUsesInnerTextTyper(t *testing.T) {
	inner := &recordingHandler{}
	s := NewSafeInput(inner, "t")
	defer s.Close()
	if err := s.InjectText("hello"); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(inner.texts, []string{"hello"}) {
		t.Fatalf("texts = %v", inner.texts)
	}
}

func mustHandle(t *testing.T, s *SafeInput, ev InputEvent) {
	t.Helper()
	if err := s.HandleEvent(ev); err != nil {
		t.Fatalf("HandleEvent(%+v): %v", ev, err)
	}
	if ev.Type == "mouse_move" {
		s.sync() // moves are asynchronous
	}
}
```

`block` is closed exactly once and never reassigned. A closed channel never blocks, and writing
the field while the worker reads it would be a data race.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/ -run TestSafeInput -race`
Expected: FAIL to compile, `undefined: NewSafeInput`.

- [ ] **Step 3: Write minimal implementation**

`agent/internal/remote/desktop/input_safe.go`:

```go
package desktop

import (
	"errors"
	"log/slog"
	"sync"
	"time"
)

var (
	errInputClosed = errors.New("input handler closed")
	errInputReset  = errors.New("input discarded by a release")
)

const (
	safeInputQueueDepth   = 64
	safeInputCloseTimeout = 2 * time.Second
)

// SafeInput wraps a platform InputHandler so that one worker goroutine owns
// every injection for a session (spec §2):
//
//   - Windows binds SendInput to the thread's desktop. The platform handler
//     calls LockOSThread/SetThreadDesktop on whichever goroutine first injects,
//     and pion delivers each data channel's messages on its own goroutine, so
//     input, pasted text and offsets used to land on different threads (M5).
//   - The macOS handler's drag state has no lock; one goroutine needs none.
//   - It records what is held and releases it all on ReleaseAll/Close, so a
//     viewer that vanishes mid-chord cannot leave Shift down on the customer's
//     machine (K3).
//
// Discrete events are synchronous: HandleEvent returns the platform handler's
// error, as before. mouse_move is fire-and-forget and coalesced: only the
// newest pending move is injected, after every discrete event sent before it.
type SafeInput struct {
	inner InputHandler
	label string

	jobs   chan safeInputJob
	urgent chan safeInputJob
	wake   chan struct{}
	done   chan struct{}
	exited chan struct{}

	closeOnce    sync.Once
	closeTimeout time.Duration

	moveMu      sync.Mutex
	pendingMove *InputEvent

	held *heldInput // worker goroutine only
}

type safeInputJob struct {
	run    func() error
	result chan error // buffered(1); nil for fire-and-forget
}

var _ InputHandler = (*SafeInput)(nil)

func NewSafeInput(inner InputHandler, label string) *SafeInput {
	s := &SafeInput{
		inner:        inner,
		label:        label,
		jobs:         make(chan safeInputJob, safeInputQueueDepth),
		urgent:       make(chan safeInputJob, 4),
		wake:         make(chan struct{}, 1),
		done:         make(chan struct{}),
		exited:       make(chan struct{}),
		closeTimeout: safeInputCloseTimeout,
		held:         newHeldInput(),
	}
	go s.loop()
	return s
}

func (s *SafeInput) loop() {
	defer close(s.exited)
	for {
		// Releases and other urgent work never wait behind queued input.
		select {
		case j := <-s.urgent:
			s.run(j)
			continue
		default:
		}
		select {
		case <-s.done:
			s.failQueued(errInputClosed)
			return
		case j := <-s.urgent:
			s.run(j)
		case j := <-s.jobs:
			s.run(j)
		case <-s.wake:
			// Every queued discrete job is older than the pending move: a
			// discrete submit flushes the move slot into the queue first.
			s.runQueued()
			if mv := s.takeMove(); mv != nil {
				if err := s.inject(*mv); err != nil {
					slog.Debug("Mouse move injection failed", "session", s.label, "error", err.Error())
				}
			}
		}
	}
}

func (s *SafeInput) run(j safeInputJob) {
	err := j.run()
	if j.result != nil {
		j.result <- err
	}
}

func (s *SafeInput) runQueued() {
	for {
		select {
		case j := <-s.jobs:
			s.run(j)
		default:
			return
		}
	}
}

// failQueued answers every queued job with err without running it.
func (s *SafeInput) failQueued(err error) {
	for {
		select {
		case j := <-s.jobs:
			if j.result != nil {
				j.result <- err
			}
		case j := <-s.urgent:
			if j.result != nil {
				j.result <- err
			}
		default:
			return
		}
	}
}

func (s *SafeInput) inject(ev InputEvent) error {
	ev = s.held.prepare(ev)
	err := s.inner.HandleEvent(ev)
	s.held.observe(ev, err)
	return err
}

func (s *SafeInput) takeMove() *InputEvent {
	s.moveMu.Lock()
	defer s.moveMu.Unlock()
	mv := s.pendingMove
	s.pendingMove = nil
	return mv
}

// submit queues run and waits for its result. timeout 0 waits as long as
// the worker lives.
func (s *SafeInput) submit(urgent bool, timeout time.Duration, run func() error) error {
	select {
	case <-s.done:
		return errInputClosed
	default:
	}
	job := safeInputJob{run: run, result: make(chan error, 1)}
	q := s.jobs
	if urgent {
		q = s.urgent
	} else if mv := s.takeMove(); mv != nil {
		// Keep pointer motion that arrived before this event ahead of it.
		move := *mv
		if err := s.enqueue(q, safeInputJob{run: func() error { return s.inject(move) }}); err != nil {
			return err
		}
	}
	if err := s.enqueue(q, job); err != nil {
		return err
	}
	var expire <-chan time.Time
	if timeout > 0 {
		t := time.NewTimer(timeout)
		defer t.Stop()
		expire = t.C
	}
	select {
	case err := <-job.result:
		return err
	case <-s.exited:
		return errInputClosed
	case <-expire:
		return errors.New("input worker did not respond")
	}
}

func (s *SafeInput) enqueue(q chan safeInputJob, j safeInputJob) error {
	select {
	case q <- j:
		return nil
	case <-s.done:
		return errInputClosed
	}
}

// sync waits until every job submitted so far, and any pending move, has run.
// Tests use it to observe asynchronous moves.
func (s *SafeInput) sync() { _ = s.submit(false, 0, func() error { return nil }) }

// HandleEvent injects ev on the worker. Discrete events wait for the platform
// handler and return its error; mouse_move returns immediately.
func (s *SafeInput) HandleEvent(ev InputEvent) error {
	if ev.Type == "mouse_move" {
		select {
		case <-s.done:
			return errInputClosed
		default:
		}
		s.moveMu.Lock()
		s.pendingMove = &ev
		s.moveMu.Unlock()
		select {
		case s.wake <- struct{}{}:
		default:
		}
		return nil
	}
	return s.submit(false, 0, func() error { return s.inject(ev) })
}

// ReleaseAll releases every key and button the agent holds on the remote and
// discards input queued before it, which would otherwise press keys again
// right after they were released. Safe to call at any time, including after
// Close; it never blocks longer than the close timeout.
func (s *SafeInput) ReleaseAll(reason string) {
	err := s.submit(true, s.closeTimeout, func() error {
		s.discardQueued()
		s.takeMove()
		releases := s.held.releases()
		for _, ev := range releases {
			if err := s.inner.HandleEvent(ev); err != nil {
				slog.Debug("Release injection failed", "session", s.label, "type", ev.Type, "error", err.Error())
			}
		}
		if len(releases) > 0 {
			slog.Info("Released held remote input", "session", s.label, "reason", reason, "count", len(releases))
		}
		return nil
	})
	if err != nil && !errors.Is(err, errInputClosed) {
		slog.Warn("Releasing held remote input failed", "session", s.label, "reason", reason, "error", err.Error())
	}
}

func (s *SafeInput) discardQueued() {
	for {
		select {
		case j := <-s.jobs:
			if j.result != nil {
				j.result <- errInputReset
			}
		default:
			return
		}
	}
}

// InjectText types text on the worker, so it never interleaves with keys.
func (s *SafeInput) InjectText(text string) error {
	return s.submit(false, 0, func() error { return InjectText(s.inner, text) })
}

// Close releases everything held and stops the worker. Idempotent, and
// bounded by the close timeout even if the platform handler is wedged.
func (s *SafeInput) Close() {
	s.closeOnce.Do(func() {
		s.ReleaseAll("closed")
		close(s.done)
		select {
		case <-s.exited:
		case <-time.After(s.closeTimeout):
			slog.Warn("Input worker did not exit", "session", s.label)
		}
	})
}

func (s *SafeInput) SetDisplayOffset(x, y int) {
	_ = s.submit(false, 0, func() error { s.inner.SetDisplayOffset(x, y); return nil })
}

func (s *SafeInput) SetAtLoginWindow(atLoginWindow bool) {
	_ = s.submit(true, s.closeTimeout, func() error { s.inner.SetAtLoginWindow(atLoginWindow); return nil })
}

func (s *SafeInput) InputAvailable() bool { return s.inner.InputAvailable() }

func (s *SafeInput) SendMouseMove(x, y int) error {
	return s.HandleEvent(InputEvent{Type: "mouse_move", X: x, Y: y})
}
func (s *SafeInput) SendMouseClick(x, y int, button string) error {
	return s.HandleEvent(InputEvent{Type: "mouse_click", X: x, Y: y, Button: button})
}
func (s *SafeInput) SendMouseDown(x, y int, button string) error {
	return s.HandleEvent(InputEvent{Type: "mouse_down", X: x, Y: y, Button: button})
}
func (s *SafeInput) SendMouseUp(x, y int, button string) error {
	return s.HandleEvent(InputEvent{Type: "mouse_up", X: x, Y: y, Button: button})
}
func (s *SafeInput) SendMouseScroll(x, y int, delta int) error {
	return s.HandleEvent(InputEvent{Type: "mouse_scroll", X: x, Y: y, Delta: delta})
}
func (s *SafeInput) SendKeyPress(key string, modifiers []string) error {
	return s.HandleEvent(InputEvent{Type: "key_press", Key: key, Modifiers: modifiers})
}
func (s *SafeInput) SendKeyDown(key string) error {
	return s.HandleEvent(InputEvent{Type: "key_down", Key: key})
}
func (s *SafeInput) SendKeyUp(key string) error {
	return s.HandleEvent(InputEvent{Type: "key_up", Key: key})
}
```

Design notes for the implementer:
- `stubInputHandler` (in `session_control_test.go`) is not thread-safe. Tests use
  `recordingHandler`.
- `TestSafeInputCloseDoesNotHangOnStuckHandler` reads `s.closeTimeout`, which is why that field
  exists rather than using the constant directly.
- `ReleaseAll` running inside a job and calling `discardQueued` happens on the worker goroutine.
  No other goroutine receives from `s.jobs`, so there is no race.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ -run TestSafeInput -race -count=20`
Expected: PASS 20×. The repetition flushes out ordering races.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/input_safe.go agent/internal/remote/desktop/input_safe_test.go
git commit -m "feat(agent): one input worker per session that can release everything it pressed (#8238)"
```

---

### Task 4: Wire `SafeInput` into WebRTC sessions and every release trigger

**Files:**
- Create: `agent/internal/remote/desktop/session_input.go`
- Create: `agent/internal/remote/desktop/session_input_test.go`
- Modify: `agent/internal/remote/desktop/session_webrtc.go`:
  - `:118`, session construction;
  - `OnDataChannel`, add an `OnClose` for each channel;
  - `PeerConnectionStateDisconnected` case.
- Modify: `agent/internal/remote/desktop/session.go`, `doCleanup` (first statement in the `Do`).
- Modify: `agent/internal/remote/desktop/session_control.go`:
  - `handleInputMessage` error log;
  - `handleTypeText` (`InjectText` → `s.injectText`);
  - `switch_monitor` (release before the swap);
  - `buildInputCapabilities`.
- Modify: `agent/internal/remote/desktop/session_capture.go`, `handleDesktopSwitch` (release after
  `ConsumeDesktopSwitch` returns true).
- Modify: `agent/internal/remote/desktop/session_type_text_test.go:141`, the expected capabilities
  JSON.

**Interfaces:**
- Consumes: `NewSafeInput`, `(*SafeInput).ReleaseAll`, `.InjectText`, `.Close`, `errInputReset`,
  `errInputClosed`.
- Produces:
  - `(*Session).releaseHeldInput(reason string)`;
  - `(*Session).closeInput()`;
  - `(*Session).injectText(text string) error`;
  - `(*Session).onViewerDataChannelClosed(label string)`;
  - `(*Session).onPeerDisconnected()`.

  All of them are no-ops, or fall back to the raw handler, when `s.inputHandler` is not a
  `*SafeInput`.

- [ ] **Step 1: Write the failing test**

`agent/internal/remote/desktop/session_input_test.go`:

```go
package desktop

import (
	"encoding/json"
	"testing"
)

func newSafeSession(t *testing.T) (*Session, *recordingHandler) {
	t.Helper()
	inner := &recordingHandler{}
	si := NewSafeInput(inner, "session-1")
	t.Cleanup(si.Close)
	return &Session{id: "session-1", inputHandler: si}, inner
}

func lastCall(h *recordingHandler) string {
	c := h.snapshot()
	if len(c) == 0 {
		return ""
	}
	return c[len(c)-1]
}

func TestSessionReleasesHeldKeyWhenInputChannelCloses(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleInputMessage([]byte(`{"type":"key_down","key":"shift"}`))

	s.onViewerDataChannelClosed("input")

	if got := lastCall(inner); got != "key_up:shift" {
		t.Fatalf("last call = %q, want key_up:shift (all: %v)", got, inner.snapshot())
	}
}

func TestSessionReleasesHeldButtonOnPeerDisconnect(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleInputMessage([]byte(`{"type":"mouse_down","x":3,"y":4,"button":"left"}`))

	s.onPeerDisconnected()

	if got := lastCall(inner); got != "mouse_up:3,4:left" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}

func TestSessionCleanupReleasesHeldInput(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleInputMessage([]byte(`{"type":"key_down","key":"ctrl"}`))

	s.doCleanup()

	if got := lastCall(inner); got != "key_up:ctrl" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}

func TestSessionTypeTextGoesThroughTheWorker(t *testing.T) {
	s, inner := newSafeSession(t)
	s.handleControlMessage([]byte(`{"type":"type_text","text":"hi"}`))
	if len(inner.texts) != 1 || inner.texts[0] != "hi" {
		t.Fatalf("texts = %v", inner.texts)
	}
}

func TestSessionHelpersToleratePlainHandler(t *testing.T) {
	// Existing tests build sessions around plain stubs; the helpers must not panic.
	s := &Session{id: "s", inputHandler: &stubInputHandler{}}
	s.releaseHeldInput("test")
	s.onViewerDataChannelClosed("input")
	s.onPeerDisconnected()
	s.closeInput()
}

func TestInputCapabilitiesAdvertiseHeldInputRelease(t *testing.T) {
	var body map[string]any
	raw, _ := json.Marshal(buildInputCapabilities())
	_ = json.Unmarshal(raw, &body)
	if body["releasesHeldInput"] != true {
		t.Fatalf("capabilities = %s", raw)
	}
}
```

Add a desktop-switch test in `session_capture_test.go`. It uses that file's existing fake capturer
pattern; read the top of the file and make a fake whose `ConsumeDesktopSwitch` returns true once
and whose `OnSecureDesktop` returns true:

```go
func TestHandleDesktopSwitchReleasesHeldInput(t *testing.T) {
	inner := &recordingHandler{}
	si := NewSafeInput(inner, "s")
	t.Cleanup(si.Close)
	s := &Session{id: "s", inputHandler: si, capturer: &switchingCapturer{secure: true}}
	_ = si.HandleEvent(InputEvent{Type: "key_down", Key: "alt"})

	s.handleDesktopSwitch()

	found := false
	for _, c := range inner.snapshot() {
		if c == "key_up:alt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("desktop switch did not release alt: %v", inner.snapshot())
	}
}
```

`switchingCapturer` must implement `ScreenCapturer` + `DesktopSwitchNotifier`. If
`handleDesktopSwitch` calls `nudgeSecureDesktop`/`forceDesktopRepaint`, those are no-ops off
Windows. Run this test on darwin/linux only (`//go:build !windows` in a new file
`session_desktop_switch_test.go`) if they are not.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/ -run 'TestSession|TestInputCapabilities|TestHandleDesktopSwitchReleasesHeldInput' -race`
Expected: FAIL to compile, `s.onViewerDataChannelClosed undefined`.

- [ ] **Step 3: Write minimal implementation**

`agent/internal/remote/desktop/session_input.go`:

```go
package desktop

// Session-side entry points to the SafeInput worker. Each falls back to the
// raw handler (or does nothing) when the session was built around a plain
// InputHandler, as many tests do.

func (s *Session) safeInput() *SafeInput {
	si, _ := s.inputHandler.(*SafeInput)
	return si
}

// releaseHeldInput releases every key and button this session holds on the
// remote machine. Called whenever the viewer may no longer be able to send
// its own releases.
func (s *Session) releaseHeldInput(reason string) {
	if si := s.safeInput(); si != nil {
		si.ReleaseAll(reason)
	}
}

func (s *Session) closeInput() {
	if si := s.safeInput(); si != nil {
		si.Close()
	}
}

func (s *Session) injectText(text string) error {
	if si := s.safeInput(); si != nil {
		return si.InjectText(text)
	}
	return InjectText(s.inputHandler, text)
}

// onViewerDataChannelClosed: a closed input or control channel means the
// viewer can no longer deliver key-ups.
func (s *Session) onViewerDataChannelClosed(label string) {
	s.releaseHeldInput(label + "_channel_closed")
}

// onPeerDisconnected releases immediately rather than after the 20 s ICE
// grace: ending an in-progress drag is better than a latched Shift for 20 s
// on the customer's machine, and the viewer re-presses whatever is still
// physically held.
func (s *Session) onPeerDisconnected() {
	s.releaseHeldInput("peer_disconnected")
}
```

Wiring edits:

1. `session_webrtc.go` session construction:
   ```go
   inputHandler: NewSafeInput(NewInputHandler(m.config.DesktopContext), sessionID),
   ```
2. `session_webrtc.go` `OnDataChannel`. In both the `"input"` and `"control"` cases, add after the
   `OnMessage` registration:
   ```go
   label := dc.Label()
   dc.OnClose(func() { session.onViewerDataChannelClosed(label) })
   ```
3. `session_webrtc.go`, `case webrtc.PeerConnectionStateDisconnected:`. Add before the
   `slog.Warn`:
   ```go
   // Off the pion callback goroutine: the release waits on the input worker.
   go session.onPeerDisconnected()
   ```
4. `session.go` `doCleanup`. Make this the first statement inside `s.cleanupOnce.Do(func() {`:
   ```go
   // Before anything else is torn down: nothing this session pressed may
   // stay pressed on the customer's machine.
   s.closeInput()
   ```
5. `session_control.go` `handleInputMessage`. Replace the trailing `HandleEvent` error log with:
   ```go
   if err := s.inputHandler.HandleEvent(event); err != nil {
       if errors.Is(err, errInputReset) || errors.Is(err, errInputClosed) {
           return // discarded by a release or teardown; expected
       }
       slog.Warn("Failed to handle input event", "session", s.id, "error", err.Error())
   }
   ```
   Add the `errors` import.
6. `session_control.go` `handleTypeText`. Change `InjectText(s.inputHandler, msg.Text)` to
   `s.injectText(msg.Text)`.
7. `session_control.go` `case "switch_monitor":`. Directly after the `slog.Info("Switching monitor", ...)`
   line, add:
   ```go
   // Coordinates of a drag in progress belong to the old monitor.
   s.releaseHeldInput("monitor_switch")
   ```
8. `session_capture.go` `handleDesktopSwitch`. After the `if !ok || !dsn.ConsumeDesktopSwitch() { return }`
   block, add:
   ```go
   // Key-ups for anything held would land on the other desktop.
   s.releaseHeldInput("desktop_switch")
   ```
9. `session_control.go` `buildInputCapabilities`. Add `"releasesHeldInput": true` and extend the
   doc comment: "releasesHeldInput says this agent releases everything it pressed when the viewer
   disconnects, so a viewer need not replay releases across a reconnect."
10. `session_type_text_test.go:141`. Update the expected JSON to
   `{"releasesHeldInput":true,"type":"input_capabilities","typeText":true}`. `json.Marshal` sorts
   map keys.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ -race -count=3`
Expected: PASS (all package tests).

Run: `cd agent && GOOS=windows GOARCH=amd64 go vet ./internal/remote/desktop/ && GOOS=linux GOARCH=amd64 go vet ./internal/remote/desktop/`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/
git commit -m "fix(agent): release held keys and buttons on viewer disconnect, channel close, monitor and desktop switch (#8238)"
```

---

### Task 5: WebSocket fallback sessions get the same worker

**Files:**
- Modify: `agent/internal/remote/desktop/ws_manager.go:101` (wrap the handler)
- Modify: `agent/internal/remote/desktop/ws_stream.go`, `Stop()`: release and close the worker after
  `close(s.done)`.
- Test: `agent/internal/remote/desktop/ws_stream_input_test.go`

**Interfaces:**
- Consumes: `NewSafeInput`, `(*SafeInput).Close`.

- [ ] **Step 1: Write the failing test**

```go
package desktop

import "testing"

func TestWsStreamStopReleasesHeldInput(t *testing.T) {
	inner := &recordingHandler{}
	s := newWsStreamSession("ws-1", nil, NewSafeInput(inner, "ws-1"), nil, StreamConfig{})
	s.skipWallpaper = true

	if err := s.HandleInput(InputEvent{Type: "key_down", Key: "shift"}); err != nil {
		t.Fatal(err)
	}
	s.Stop()

	if got := lastCall(inner); got != "key_up:shift" {
		t.Fatalf("last call = %q (all: %v)", got, inner.snapshot())
	}
}
```

If `Stop()` dereferences a nil capturer, it already guards with `if s.capturer != nil`; keep it.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd agent && go test ./internal/remote/desktop/ -run TestWsStreamStopReleasesHeldInput -race`
Expected: FAIL. The last call is `key_down:shift`, because `Stop` releases nothing.

- [ ] **Step 3: Write minimal implementation**

`ws_manager.go`, at the existing `inputHandler = NewInputHandler("user_session")`:

```go
		inputHandler = NewSafeInput(NewInputHandler("user_session"), id)
```

(Check the surrounding code: if `id` is not in scope there, use the session id variable that is.)

`ws_stream.go` `Stop()`, directly after `close(s.done)`:

```go
	// Nothing this stream pressed may stay pressed after it ends.
	if si, ok := s.inputHandler.(*SafeInput); ok {
		si.Close()
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd agent && go test ./internal/remote/desktop/ ./internal/heartbeat/ -race`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agent/internal/remote/desktop/ws_manager.go agent/internal/remote/desktop/ws_stream.go agent/internal/remote/desktop/ws_stream_input_test.go
git commit -m "fix(agent): WebSocket desktop sessions release held input on stop (#8238)"
```

---

### Task 6: Full verification and spec status

- [ ] **Step 1:** `cd agent && go test -race ./internal/remote/... ./internal/heartbeat/...` → PASS.
- [ ] **Step 2:** Cross-compile and vet:
  - `GOOS=windows GOARCH=amd64 go vet ./...`
  - `GOOS=linux GOARCH=amd64 go vet ./...`
  - `GOOS=darwin CGO_ENABLED=0 go vet ./internal/remote/desktop/`

  Expected: no output.
- [ ] **Step 3:** In the spec, mark W2 as split into W2a (this plan), W2b and W2c in the Waves table,
  and add a one-line pointer to this plan.
- [ ] **Step 4:** Commit: `docs(spec): W2 split into W2a/W2b/W2c (#8236)`.

Lab gate (owed before merge; record results on the PR):
1. Windows target. Hold Shift in the viewer, kill the viewer process. Typing locally on the target
   gives lowercase letters within 1 s. Before this change, Shift stayed latched until the session
   ended.
2. Drag a window, pull the viewer's network cable mid-drag. The button is released immediately,
   not after 20 s.
3. Start a UAC prompt while holding Alt. Alt is not latched on the secure desktop.
