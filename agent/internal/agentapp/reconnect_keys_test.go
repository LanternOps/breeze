package agentapp

import (
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/logging"
)

// Not parallel: applyRetryAfterSettings swaps process-wide switches.
func TestAgentAppPassesReconnectKeys(t *testing.T) {
	t.Cleanup(func() {
		httputil.SetLoopRetryAfter(true)
		logging.SetLoopRetryAfter(true)
	})

	for _, tc := range []struct {
		seconds int
		want    time.Duration
	}{
		{0, 0},
		{30, 30 * time.Second},
		{300, 300 * time.Second},
	} {
		cfg := config.Default()
		cfg.WsFirstReconnectWindowSeconds = tc.seconds
		got := wsReconnectConfig(cfg)
		if got == nil {
			t.Fatalf("window %d: nil pointer, want ptr(%v) (nil would mean the websocket default, hiding an explicit 0)", tc.seconds, tc.want)
		}
		if *got != tc.want {
			t.Errorf("window %d: got %v, want %v", tc.seconds, *got, tc.want)
		}
	}

	cfg := config.Default()
	cfg.LoopRetryAfter = false
	applyRetryAfterSettings(cfg)
	if httputil.LoopRetryAfterEnabled() {
		t.Error("loop_retry_after=false must disable httputil loop-level Retry-After")
	}

	cfg.LoopRetryAfter = true
	applyRetryAfterSettings(cfg)
	if !httputil.LoopRetryAfterEnabled() {
		t.Error("loop_retry_after=true must enable httputil loop-level Retry-After")
	}
}
