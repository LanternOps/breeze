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
