package tools

import (
	"math"
	"strings"
	"testing"
)

// GetPayloadInt now accepts numeric strings (issue #3373), so every value that
// narrows to a smaller integer type after passing through it must be
// range-checked first: an out-of-range pid wrapped through int32 would target a
// DIFFERENT process than the one the operator named.
func TestParsePayloadPID(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    int32
		wantErr string
	}{
		{"valid", map[string]any{"pid": 1234}, 1234, ""},
		{"valid numeric string", map[string]any{"pid": "1234"}, 1234, ""},
		{"at int32 max", map[string]any{"pid": math.MaxInt32}, math.MaxInt32, ""},
		{"absent is required", map[string]any{}, 0, "required"},
		{"zero is required", map[string]any{"pid": 0}, 0, "required"},
		{"negative", map[string]any{"pid": -5}, 0, "out of range"},
		{"beyond int32 would wrap", map[string]any{"pid": int64(math.MaxInt32) + 1}, 0, "out of range"},
		{"far beyond int32", map[string]any{"pid": int64(1) << 40}, 0, "out of range"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parsePayloadPID(tt.payload, "pid")
			if tt.wantErr != "" {
				if err == nil {
					t.Fatalf("parsePayloadPID(%#v) = %d, want error containing %q", tt.payload, got, tt.wantErr)
				}
				if !strings.Contains(err.Error(), tt.wantErr) {
					t.Errorf("error %q does not contain %q", err, tt.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tt.want {
				t.Errorf("got %d, want %d", got, tt.want)
			}
		})
	}
}

// An incident-response process_kill with a pid beyond int32 must be rejected
// before the int32 narrowing, not wrapped onto some other process.
func TestExecuteProcessKillRejectsOutOfRangePID(t *testing.T) {
	result := ExecuteContainment(map[string]any{
		"actionType": "process_kill",
		"parameters": map[string]any{
			"pid": int64(math.MaxInt32) + 2,
		},
	})
	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
	if !strings.Contains(result.Error, "out of range") {
		t.Errorf("error %q should report the out-of-range pid", result.Error)
	}
}

// The terminal clamp is unchanged behaviour, restructured so the bound checks
// guard the value that is actually converted (CodeQL barrier-guard shape).
func TestNormalizeTerminalSize(t *testing.T) {
	tests := []struct {
		name               string
		cols, rows         int
		wantCols, wantRows uint16
	}{
		{"defaults pass through", 80, 24, 80, 24},
		{"below minimums clamp up", 1, -3, minTerminalCols, minTerminalRows},
		{"above maximums clamp down", 100000, 70000, maxTerminalCols, maxTerminalRows},
		{"at bounds", maxTerminalCols, minTerminalRows, maxTerminalCols, minTerminalRows},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			cols, rows := normalizeTerminalSize(tt.cols, tt.rows)
			if cols != tt.wantCols || rows != tt.wantRows {
				t.Errorf("normalizeTerminalSize(%d, %d) = (%d, %d), want (%d, %d)",
					tt.cols, tt.rows, cols, rows, tt.wantCols, tt.wantRows)
			}
		})
	}
}
