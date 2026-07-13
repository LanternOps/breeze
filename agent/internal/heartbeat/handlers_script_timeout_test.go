package heartbeat

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
)

// TestHelperCommandTimeout is part of the issue #2387 hardening: the IPC wait
// deadline derived from a server-supplied timeoutSeconds must be clamped to
// the same bounds the local script executor applies, so a huge payload value
// cannot park a worker-pool goroutine (and its command payload)
// near-indefinitely on the IPC wait.
func TestHelperCommandTimeout(t *testing.T) {
	const grace = 5 * time.Second

	tests := []struct {
		name           string
		timeoutSeconds int
		want           time.Duration
	}{
		{"zero falls back to executor default", 0, time.Duration(executor.DefaultTimeout)*time.Second + grace},
		{"negative falls back to executor default", -30, time.Duration(executor.DefaultTimeout)*time.Second + grace},
		{"small value passes through", 10, 10*time.Second + grace},
		{"typical script timeout passes through", 300, 300*time.Second + grace},
		{"exactly max passes through", executor.MaxTimeout, time.Duration(executor.MaxTimeout)*time.Second + grace},
		{"above max clamps to executor max", executor.MaxTimeout + 1, time.Duration(executor.MaxTimeout)*time.Second + grace},
		{"huge server-supplied value clamps to executor max", 86400 * 365, time.Duration(executor.MaxTimeout)*time.Second + grace},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := helperCommandTimeout(tt.timeoutSeconds); got != tt.want {
				t.Fatalf("helperCommandTimeout(%d) = %s, want %s", tt.timeoutSeconds, got, tt.want)
			}
		})
	}
}
