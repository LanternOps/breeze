package collectors

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

func TestInferSessionType(t *testing.T) {
	tests := []struct {
		name     string
		input    sessionbroker.DetectedSession
		expected string
	}{
		{
			name: "local_console",
			input: sessionbroker.DetectedSession{
				Username: "alice",
				IsRemote: false,
				Display:  "x11",
			},
			expected: "console",
		},
		{
			name: "remote_gui",
			input: sessionbroker.DetectedSession{
				Username: "bob",
				IsRemote: true,
				Display:  "windows",
			},
			expected: "rdp",
		},
		{
			name: "remote_tty",
			input: sessionbroker.DetectedSession{
				Username: "carol",
				IsRemote: true,
				Display:  "",
			},
			expected: "ssh",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := inferSessionType(tt.input); got != tt.expected {
				t.Fatalf("inferSessionType() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestMapDetectedState(t *testing.T) {
	tests := map[string]string{
		"active":       "active",
		"online":       "active",
		"idle":         "idle",
		"locked":       "locked",
		"closing":      "disconnected",
		"disconnected": "disconnected",
		"unknown":      "away",
	}

	for input, expected := range tests {
		if got := mapDetectedState(input); got != expected {
			t.Fatalf("mapDetectedState(%q) = %q, want %q", input, got, expected)
		}
	}
}
