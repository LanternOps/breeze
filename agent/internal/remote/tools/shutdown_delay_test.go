package tools

import (
	"strings"
	"testing"
)

// ShutdownDelayMinutes is the single source of truth for the `delay` field
// shared by reboot, shutdown, and safe-mode reboot.
//
// These tests exercise the parse/clamp helper directly and deliberately never
// call Reboot/Shutdown/RebootToSafeMode: those run the host's `shutdown`
// binary, and a regression of this very fix would turn a malformed-input test
// case into an actual reboot of whatever machine ran the suite. The handlers
// call this helper first and return early on its error, so the destructive
// path is covered here without a test being able to schedule a reboot.
// handleRebootSafeMode in the heartbeat package covers the handler wiring on
// non-Windows hosts, where the safe-mode tool is an inert stub.
func TestShutdownDelayMinutes_ValidAndClamped(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    int
	}{
		// Absent means "immediately" — the documented default, preserved.
		{"absent", map[string]any{}, 0},
		{"explicit null", map[string]any{"delay": nil}, 0},

		// Ordinary values across the accepted types.
		{"int 15", map[string]any{"delay": 15}, 15},
		{"int64 15", map[string]any{"delay": int64(15)}, 15},
		{"float64 15 (the encoding/json shape)", map[string]any{"delay": float64(15)}, 15},
		{"explicit zero", map[string]any{"delay": 0}, 0},

		// The issue #3373 case: a JSON-string delay now schedules 15 minutes
		// instead of collapsing to an immediate reboot.
		{"numeric string 15", map[string]any{"delay": "15"}, 15},
		{"numeric string 1440", map[string]any{"delay": "1440"}, 1440},

		// Range clamping is unchanged behaviour; only the type is now strict.
		{"at max", map[string]any{"delay": 1440}, 1440},
		{"over max clamps down", map[string]any{"delay": 5000}, 1440},
		{"over max as string clamps down", map[string]any{"delay": "5000"}, 1440},
		{"negative clamps to zero", map[string]any{"delay": -5}, 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ShutdownDelayMinutes(tt.payload)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("ShutdownDelayMinutes(%#v) = %d, want %d", tt.payload, got, tt.want)
			}
		})
	}
}

// A malformed delay must fail the command. Returning 0 would mean "reboot this
// machine right now" — the most destructive possible reading of an input the
// agent could not understand.
func TestShutdownDelayMinutes_MalformedIsAnError(t *testing.T) {
	tests := []struct {
		name string
		raw  any
	}{
		{"non-numeric string", "soon"},
		{"empty string", ""},
		{"string with unit word", "15 minutes"},
		{"string with unit suffix", "15m"},
		{"decimal string", "15.5"},
		{"bool", true},
		{"non-integral float", 15.5},
		{"object", map[string]any{"minutes": 15}},
		{"array", []any{15}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ShutdownDelayMinutes(map[string]any{"delay": tt.raw})
			if err == nil {
				t.Fatalf("delay %#v returned %d with no error; a malformed delay must never resolve to an immediate reboot", tt.raw, got)
			}
			if got != 0 {
				t.Errorf("error path returned %d, want the zero value", got)
			}
			// An operator reading the failed command result needs to know
			// which field was rejected.
			if !strings.Contains(err.Error(), "delay") {
				t.Errorf("error %q does not name the delay field", err)
			}
		})
	}
}
