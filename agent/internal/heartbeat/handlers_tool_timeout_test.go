package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// #3112: executeToolViaHelper used a hardcoded 15s per attempt, so the whole
// helper round-trip was capped near 30s regardless of the budget the API was
// willing to wait for. These pin the deadline derivation itself — the piece that
// decides how long the device is prepared to work — rather than the IPC plumbing
// around it, which needs a live helper to exercise.
func TestHelperToolTimeoutFromPayload(t *testing.T) {
	const grace = 5 * time.Second

	tests := []struct {
		name    string
		payload map[string]any
		want    time.Duration
	}{
		{
			name:    "server budget is honoured",
			payload: map[string]any{"timeoutSeconds": 120},
			want:    120*time.Second + grace,
		},
		{
			// The regression this issue is about: 120s from the API must not be
			// silently reduced to the old ~30s ceiling.
			name:    "server budget well above the old hardcoded ceiling",
			payload: map[string]any{"timeoutSeconds": 120},
			want:    120*time.Second + grace,
		},
		{
			// An older API sends nothing. Preserve the previous ~30s total rather
			// than inheriting the script executor's 300s default.
			name:    "absent budget falls back to the tool default, not the script default",
			payload: map[string]any{},
			want:    defaultHelperToolTimeoutSeconds*time.Second + grace,
		},
		{
			name:    "float64 from JSON decoding is accepted",
			payload: map[string]any{"timeoutSeconds": float64(90)},
			want:    90*time.Second + grace,
		},
		{
			// #2387 clamping still applies through this path.
			name:    "absurd budget clamps to the executor maximum",
			payload: map[string]any{"timeoutSeconds": 86400 * 365},
			want:    time.Duration(executor.MaxTimeout)*time.Second + grace,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := helperCommandTimeout(tools.GetPayloadInt(tt.payload, "timeoutSeconds", defaultHelperToolTimeoutSeconds))
			if got != tt.want {
				t.Fatalf("timeout = %s, want %s", got, tt.want)
			}
		})
	}
}

// The default must stay under the old two-attempt ceiling so an agent talking to
// an API that does not yet publish a budget is no worse off than before.
func TestDefaultHelperToolTimeoutIsNotWorseThanTheOldCeiling(t *testing.T) {
	const oldCeiling = 30 * time.Second
	if got := helperCommandTimeout(defaultHelperToolTimeoutSeconds); got > oldCeiling+5*time.Second {
		t.Fatalf("default total %s exceeds the pre-fix ceiling %s", got, oldCeiling)
	}
	if minHelperAttemptTimeout >= helperCommandTimeout(defaultHelperToolTimeoutSeconds) {
		t.Fatalf("attempt floor %s must be smaller than the default budget", minHelperAttemptTimeout)
	}
}
