package heartbeat

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestParseGUIUserUIDs(t *testing.T) {
	t.Parallel()

	output := "501 /System/Library/CoreServices/loginwindow\nbaduid /System/Library/CoreServices/loginwindow\n502 other\n501 /System/Library/CoreServices/loginwindow\n"
	uids := parseGUIUserUIDs(output)
	if len(uids) != 1 || uids[0] != "501" {
		t.Fatalf("parseGUIUserUIDs = %+v, want [501]", uids)
	}

	// uid 0 (root) should be excluded — its loginwindow process is the system
	// login UI, not a GUI user session.
	outputWithRoot := "0 /System/Library/CoreServices/loginwindow\n501 /System/Library/CoreServices/loginwindow\n"
	uids2 := parseGUIUserUIDs(outputWithRoot)
	if len(uids2) != 1 || uids2[0] != "501" {
		t.Fatalf("parseGUIUserUIDs with root = %+v, want [501]", uids2)
	}
}

func TestValidateDesktopSessionID(t *testing.T) {
	t.Parallel()

	if err := validateDesktopSessionID("desktop-1.ok"); err != nil {
		t.Fatalf("validateDesktopSessionID(valid) error = %v", err)
	}
	if err := validateDesktopSessionID("../bad"); err == nil {
		t.Fatal("expected invalid session id to be rejected")
	}
}

func TestHandleDesktopStreamStartRejectsInvalidSessionID(t *testing.T) {
	t.Parallel()

	result := handleDesktopStreamStart(&Heartbeat{}, Command{
		ID:   "desktop-stream-invalid",
		Type: tools.CmdDesktopStreamStart,
		Payload: map[string]any{
			"sessionId": "../bad",
		},
	})

	if result.Status != "failed" || !strings.Contains(result.Error, "invalid sessionId") {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestHandleDesktopConfigRejectsInvalidSessionID(t *testing.T) {
	t.Parallel()

	result := handleDesktopConfig(&Heartbeat{}, Command{
		ID:   "desktop-config-invalid",
		Type: tools.CmdDesktopConfig,
		Payload: map[string]any{
			"sessionId": "../bad",
			"quality":   float64(80),
		},
	})

	if result.Status != "failed" || !strings.Contains(result.Error, "invalid sessionId") {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestHandleDesktopInputRejectsInvalidSessionID(t *testing.T) {
	t.Parallel()

	result := handleDesktopInput(&Heartbeat{}, Command{
		ID:   "desktop-input-invalid-session",
		Type: tools.CmdDesktopInput,
		Payload: map[string]any{
			"sessionId": "../bad",
			"event": map[string]any{
				"type": "mouse_move",
			},
		},
	})

	if result.Status != "failed" || !strings.Contains(result.Error, "invalid sessionId") {
		t.Fatalf("unexpected result: %+v", result)
	}
}

func TestNormalizeDesktopInputEventCanonicalizesModifiers(t *testing.T) {
	t.Parallel()

	event, err := normalizeDesktopInputEvent(map[string]any{
		"type":      "key_press",
		"key":       "A",
		"modifiers": []any{"Control", "cmd", "ctrl", "shift"},
	})
	if err != nil {
		t.Fatalf("normalizeDesktopInputEvent error = %v", err)
	}

	if got, want := strings.Join(event.Modifiers, ","), "ctrl,meta,shift"; got != want {
		t.Fatalf("modifiers = %q, want %q", got, want)
	}
}

func TestNormalizeDesktopInputEventRejectsInvalidFields(t *testing.T) {
	t.Parallel()

	cases := []map[string]any{
		{"type": "shell_exec"},
		{"type": "mouse_click", "button": "side"},
		{"type": "mouse_scroll", "delta": float64(1000)},
		{"type": "key_press", "key": strings.Repeat("a", maxDesktopKeyBytes+1)},
		{"type": "key_press", "key": "a", "modifiers": []any{"ctrl", strings.Repeat("x", maxDesktopModifierBytes+1)}},
		{"type": "mouse_move", "x": float64(maxDesktopCoordinateAbs + 1)},
	}

	for _, payload := range cases {
		if _, err := normalizeDesktopInputEvent(payload); err == nil {
			t.Fatalf("expected payload to be rejected: %+v", payload)
		}
	}
}
