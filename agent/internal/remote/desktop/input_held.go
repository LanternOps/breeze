package desktop

import (
	"runtime"
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
	keys    map[string]struct{}
	buttons map[string]struct{}
	lastX   int
	lastY   int
	goos    string // runtime.GOOS; a field so tests can pick the platform
}

func newHeldInput() *heldInput {
	return &heldInput{keys: map[string]struct{}{}, buttons: map[string]struct{}{}, goos: runtime.GOOS}
}

// Toggle keys change state on press. They are never "held", and releasing
// them would be a bogus key_up.
var heldInputToggleKeys = map[string]struct{}{"capslock": {}, "numlock": {}, "scrolllock": {}}

// filterableModifier reports whether a modifier means the same key held via
// key_down as bundled in a key_press. "meta" does on Linux (Super both ways)
// but not on Windows, where bundled meta is injected as Ctrl (Mac Cmd → Ctrl)
// and held meta is the Win key. macOS never holds modifiers at all.
func (h *heldInput) filterableModifier(name string) bool {
	switch name {
	case "ctrl", "alt", "shift":
		return true
	case "meta":
		return h.goos == "linux"
	}
	return false
}

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
		if h.filterableModifier(name) {
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
