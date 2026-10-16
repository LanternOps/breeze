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
		{"button unknown", InputEvent{Type: "mouse_down", Button: "thumb"}, true},
		// W2c: back/forward (XBUTTON1/2, macOS other 3/4, X11 8/9).
		{"button back ok", InputEvent{Type: "mouse_down", Button: "back"}, false},
		{"button forward ok", InputEvent{Type: "mouse_up", Button: "forward"}, false},
		{"button forward click ok", InputEvent{Type: "mouse_click", Button: "Forward"}, false},
		// W2c: deltaX shares the vertical bound; delta may be 0 beside it.
		{"deltaX ok", InputEvent{Type: "mouse_scroll", DeltaX: -4}, false},
		{"deltaX at bound ok", InputEvent{Type: "mouse_scroll", DeltaX: MaxInputScrollDelta}, false},
		{"deltaX too large", InputEvent{Type: "mouse_scroll", DeltaX: MaxInputScrollDelta + 1}, true},
		{"deltaX too negative", InputEvent{Type: "mouse_scroll", DeltaX: -MaxInputScrollDelta - 1}, true},
		// W2c: code is DOM KeyboardEvent.code — ASCII letters and digits only.
		{"code ok", InputEvent{Type: "key_down", Key: "control", Code: "ControlRight"}, false},
		{"unknown code ok (falls back to key)", InputEvent{Type: "key_down", Key: "a", Code: "Lang9"}, false},
		{"code at length cap ok", InputEvent{Type: "key_down", Key: "a", Code: strings.Repeat("K", MaxInputCodeBytes)}, false},
		{"code too long", InputEvent{Type: "key_down", Key: "a", Code: strings.Repeat("K", MaxInputCodeBytes+1)}, true},
		{"code with punctuation", InputEvent{Type: "key_down", Key: "a", Code: "Key A"}, true},
		{"code with non-ascii", InputEvent{Type: "key_down", Key: "a", Code: "KeyÄ"}, true},
		{"code with NUL", InputEvent{Type: "key_down", Key: "a", Code: "Key\x00"}, true},
		{"code on a pointer event", InputEvent{Type: "mouse_down", Code: "KeyA"}, true},
		{"numLock on key event ok", InputEvent{Type: "key_down", Key: "a", NumLock: boolPtr(true)}, false},
		{"key ok", InputEvent{Type: "key_down", Key: "a"}, false},
		{"key missing", InputEvent{Type: "key_down"}, true},
		{"key empty", InputEvent{Type: "key_up", Key: ""}, true},
		// The viewer's keystroke-fallback paste sends a space as the key " ".
		{"space key ok", InputEvent{Type: "key_press", Key: " "}, false},
		{"key too long", InputEvent{Type: "key_press", Key: strings.Repeat("a", MaxInputKeyBytes+1)}, true},
		{"input_reset ok", InputEvent{Type: "input_reset", Seq: 1, Epoch: 1}, false},
		{"input_reset needs seq", InputEvent{Type: "input_reset", Epoch: 1}, true},
		{"input_reset needs epoch", InputEvent{Type: "input_reset", Seq: 1}, true},
		{"sequenced move ok", InputEvent{Type: "mouse_move", Seq: 5, After: 4}, false},
		{"sequenced move before any discrete event ok", InputEvent{Type: "mouse_move", Seq: 1, After: 0}, false},
		{"move cannot depend on a later event", InputEvent{Type: "mouse_move", Seq: 5, After: 5}, true},
		{"seq beyond a JS safe integer", InputEvent{Type: "key_down", Key: "a", Seq: MaxInputSeq + 1}, true},
		{"after beyond a JS safe integer", InputEvent{Type: "mouse_move", Seq: 1, After: MaxInputSeq + 1}, true},
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
