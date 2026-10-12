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
	keys    map[string]heldKey // by heldKeyID
	buttons map[string]struct{}
	lastX   int
	lastY   int
	goos    string // runtime.GOOS; a field so tests can pick the platform
}

func newHeldInput() *heldInput {
	return &heldInput{keys: map[string]heldKey{}, buttons: map[string]struct{}{}, goos: runtime.GOOS}
}

// heldKey is what a key_down named: the normalised key name and, from a W2c
// viewer, the physical key code. The release carries both, so the platform
// handler resolves it to the same physical key it pressed (on Windows, a
// right Ctrl pressed by scancode is not released as VK_CONTROL).
type heldKey struct {
	name string
	code string
}

// heldKeyID is the record's identity: the code when there is one, so that
// ShiftLeft and ShiftRight are two held keys, else the key name.
func heldKeyID(name, code string) string {
	if code != "" {
		return "code:" + code
	}
	return name
}

// heldInputToggleCodes are the DOM codes of the toggle keys.
var heldInputToggleCodes = map[string]struct{}{"CapsLock": {}, "NumLock": {}, "ScrollLock": {}}

func isToggleKey(name, code string) bool {
	if _, ok := heldInputToggleKeys[name]; ok {
		return true
	}
	_, ok := heldInputToggleCodes[code]
	return ok
}

// nameHeld reports whether any held key has this logical name, whichever
// physical key (code) pressed it.
func (h *heldInput) nameHeld(name string) bool {
	for _, k := range h.keys {
		if k.name == name {
			return true
		}
	}
	return false
}

// Toggle keys change state on press. They are never "held", and releasing
// them would be a bogus key_up.
var heldInputToggleKeys = map[string]struct{}{"capslock": {}, "numlock": {}, "scrolllock": {}}

// filterableModifier reports whether a modifier means the same key held via
// key_down as bundled in a key_press. "meta" does on Linux (Super both ways)
// but not on Windows, where bundled meta is injected as Ctrl (Mac Cmd → Ctrl)
// and held meta is the Win key. macOS holds modifiers only in sequenced
// sessions (W2c running mask); its key_press ORs the held mask back in, so
// filtering there changes nothing either way.
func (h *heldInput) filterableModifier(name string) bool {
	switch name {
	case "ctrl", "alt", "shift":
		return true
	case "meta":
		return h.goos == "linux"
	}
	return false
}

// heldKeyName normalises case only. Whitespace is a key: " " is space, and
// trimming it would record a name no platform handler can release.
func heldKeyName(key string) string {
	k := strings.ToLower(key)
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
		if h.filterableModifier(name) && h.nameHeld(name) {
			continue
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
		if isToggleKey(name, ev.Code) || err != nil {
			return
		}
		h.keys[heldKeyID(name, ev.Code)] = heldKey{name: name, code: ev.Code}
	case "key_up":
		delete(h.keys, heldKeyID(heldKeyName(ev.Key), ev.Code))
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
	ids := make([]string, 0, len(h.keys))
	for id := range h.keys {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		k := h.keys[id]
		out = append(out, InputEvent{Type: "key_up", Key: k.name, Code: k.code})
	}
	h.keys = map[string]heldKey{}
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
