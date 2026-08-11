package tools

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// ParsePayloadInt exists to separate "the caller omitted this field" from "the
// caller sent garbage" — a distinction GetPayloadInt collapses. Issue #3373:
// a reboot carrying the JSON string "15" was read as 0 and rebooted the device
// immediately.
func TestParsePayloadInt_Accepted(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want int
	}{
		// Types encoding/json and hand-built Go payloads actually produce.
		{"int", int(15), 15},
		{"int zero", int(0), 0},
		{"int negative", int(-5), -5},
		{"int64", int64(15), 15},
		{"float64 whole", float64(15), 15},
		{"float64 zero", float64(0), 0},
		{"float64 negative whole", float64(-5), -5},

		// The #3373 case: a numeric string must parse, not silently default.
		{"numeric string", "15", 15},
		{"numeric string zero", "0", 0},
		{"numeric string negative", "-5", -5},
		{"numeric string with surrounding space", "  15  ", 15},
		{"numeric string explicit plus", "+15", 15},

		// json.Number appears when a decoder is configured with UseNumber.
		{"json.Number", json.Number("15"), 15},
		{"json.Number negative", json.Number("-5"), -5},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePayloadInt(map[string]any{"delay": tt.raw}, "delay", 999)
			if err != nil {
				t.Fatalf("ParsePayloadInt(%#v): unexpected error %v", tt.raw, err)
			}
			if got != tt.want {
				t.Errorf("ParsePayloadInt(%#v) = %d, want %d", tt.raw, got, tt.want)
			}
		})
	}
}

// An absent key is a meaningful statement the default can stand in for; a
// present-but-malformed value is not.
func TestParsePayloadInt_AbsentUsesDefault(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
	}{
		{"empty payload", map[string]any{}},
		{"nil payload", nil},
		{"other keys only", map[string]any{"reason": "patching"}},
		{"explicit JSON null", map[string]any{"delay": nil}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePayloadInt(tt.payload, "delay", 42)
			if err != nil {
				t.Fatalf("unexpected error for absent key: %v", err)
			}
			if got != 42 {
				t.Errorf("got %d, want the default 42", got)
			}
		})
	}
}

// Every value here previously became the default (0 for a reboot delay, i.e.
// "reboot now") with no signal to the caller.
func TestParsePayloadInt_MalformedIsAnError(t *testing.T) {
	tests := []struct {
		name string
		raw  any
	}{
		{"non-numeric string", "soon"},
		{"empty string", ""},
		{"whitespace-only string", "   "},
		{"decimal string", "15.5"},
		{"string with unit suffix", "15m"},
		{"hex-ish string", "0x0F"},
		{"bool true", true},
		{"bool false", false},
		{"object", map[string]any{"minutes": 15}},
		{"array", []any{15}},
		{"non-integral float", float64(15.5)},
		{"NaN", math.NaN()},
		{"positive infinity", math.Inf(1)},
		{"negative infinity", math.Inf(-1)},
		{"float beyond int range", 1e300},
		{"float below int range", -1e300},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePayloadInt(map[string]any{"delay": tt.raw}, "delay", 999)
			if err == nil {
				t.Fatalf("ParsePayloadInt(%#v) returned %d with no error; a malformed value must not silently default", tt.raw, got)
			}
			// The message has to name the offending field — an operator
			// reading a failed command result needs to know which one.
			if !strings.Contains(err.Error(), "delay") {
				t.Errorf("error %q does not name the field", err)
			}
		})
	}
}

// The exact payload from the issue title, asserted end to end.
func TestParsePayloadInt_Issue3373JSONStringDelay(t *testing.T) {
	var payload map[string]any
	if err := json.Unmarshal([]byte(`{"delay": "15"}`), &payload); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	got, err := ParsePayloadInt(payload, "delay", 0)
	if err != nil {
		t.Fatalf("a numeric string delay must parse, got error %v", err)
	}
	if got != 15 {
		t.Errorf("delay = %d, want 15 (0 would mean an immediate reboot)", got)
	}
}

// GetPayloadInt stays lenient for the many callers that clamp or treat 0 as
// "use a default", but must accept everything ParsePayloadInt accepts.
func TestGetPayloadInt_LenientButSameAcceptSet(t *testing.T) {
	tests := []struct {
		name string
		raw  any
		want int
	}{
		// Newly accepted: previously these fell through to the default.
		{"numeric string", "50", 50},
		{"json.Number", json.Number("50"), 50},

		// Still accepted, unchanged.
		{"int", int(50), 50},
		{"int64", int64(50), 50},
		{"float64", float64(50), 50},

		// Still swallowed: malformed falls back to the default.
		{"non-numeric string", "lots", 7},
		{"bool", true, 7},
		{"non-integral float", 1.5, 7},
		{"object", map[string]any{}, 7},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := GetPayloadInt(map[string]any{"limit": tt.raw}, "limit", 7); got != tt.want {
				t.Errorf("GetPayloadInt(%#v) = %d, want %d", tt.raw, got, tt.want)
			}
		})
	}
}

func TestGetPayloadInt_AbsentUsesDefault(t *testing.T) {
	if got := GetPayloadInt(map[string]any{}, "limit", 7); got != 7 {
		t.Errorf("got %d, want 7", got)
	}
	if got := GetPayloadInt(map[string]any{"limit": nil}, "limit", 7); got != 7 {
		t.Errorf("null: got %d, want 7", got)
	}
}

// Bounds are enforced by round-trip/range checks rather than an unchecked
// conversion, whose result Go leaves implementation-defined on overflow.
func TestParsePayloadInt_IntBoundaries(t *testing.T) {
	maxInt := int(math.MaxInt)
	minInt := int(math.MinInt)

	for _, tt := range []struct {
		name string
		raw  any
		want int
	}{
		{"max int", maxInt, maxInt},
		{"min int", minInt, minInt},
		{"min int as int64", int64(math.MinInt), minInt},
		{"min int as float64", float64(math.MinInt), minInt},
	} {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ParsePayloadInt(map[string]any{"n": tt.raw}, "n", 0)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}

	// 2^63 is exactly one past max int on a 64-bit build and must be rejected
	// rather than wrapping to a negative delay.
	if _, err := ParsePayloadInt(map[string]any{"n": -float64(math.MinInt)}, "n", 0); err == nil {
		t.Error("float64 one past max int must be rejected")
	}

	// strconv.Atoi reports a range error rather than saturating.
	if _, err := ParsePayloadInt(map[string]any{"n": "99999999999999999999999"}, "n", 0); err == nil {
		t.Error("out-of-range numeric string must be rejected")
	}
}
