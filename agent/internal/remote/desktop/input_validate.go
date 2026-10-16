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

	// MaxInputCodeBytes caps the W2c `code` field (DOM KeyboardEvent.code).
	// The longest standard code is "MediaTrackPrevious" (18 bytes).
	MaxInputCodeBytes = 32

	// MaxInputSeq is the largest integer a JavaScript number holds exactly.
	// A larger seq cannot have come from a well-behaved viewer.
	MaxInputSeq = 1<<53 - 1
)

var validInputTypes = map[string]struct{}{
	"mouse_move": {}, "mouse_click": {}, "mouse_down": {}, "mouse_up": {},
	"mouse_scroll": {}, "key_press": {}, "key_down": {}, "key_up": {},
	"input_reset": {},
}

var validInputButtons = map[string]struct{}{
	"": {}, "left": {}, "right": {}, "middle": {},
	"back": {}, "forward": {}, // W2c
}

// ValidateInputEvent rejects an event a well-behaved viewer never sends. The
// viewer is untrusted: without this, the WebRTC path handed SendInput an
// unbounded scroll delta and arbitrary coordinates.
func ValidateInputEvent(ev InputEvent) error {
	if _, ok := validInputTypes[ev.Type]; !ok {
		return fmt.Errorf("invalid event type")
	}
	if absInt(ev.X) > MaxInputCoordinateAbs || absInt(ev.Y) > MaxInputCoordinateAbs {
		return fmt.Errorf("coordinate out of range")
	}
	if absInt(ev.Delta) > MaxInputScrollDelta || absInt(ev.DeltaX) > MaxInputScrollDelta {
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
		// Empty only: " " is the space key, which the viewer's keystroke
		// fallback paste sends.
		if ev.Key == "" {
			return fmt.Errorf("key is required for keyboard events")
		}
	}
	if ev.Code != "" {
		switch ev.Type {
		case "key_press", "key_down", "key_up":
		default:
			return fmt.Errorf("code on a non-keyboard event")
		}
		if !validInputCode(ev.Code) {
			return fmt.Errorf("invalid key code")
		}
	}
	if len(ev.Modifiers) > MaxInputModifiers {
		return fmt.Errorf("too many modifiers")
	}
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
	return nil
}

// validInputCode accepts the shape of a DOM KeyboardEvent.code: ASCII letters
// and digits, bounded. Whether an agent injects that code is decided later
// against a fixed table; an unknown code falls back to the key name.
func validInputCode(code string) bool {
	if len(code) > MaxInputCodeBytes {
		return false
	}
	for i := 0; i < len(code); i++ {
		c := code[i]
		if (c < 'a' || c > 'z') && (c < 'A' || c > 'Z') && (c < '0' || c > '9') {
			return false
		}
	}
	return true
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}
