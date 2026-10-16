package heartbeat

import (
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// #7970: configUpdate.unifi_collectors_assigned=true wakes the UniFi collector
// loop. The update in each case carries ONLY the hint, so a handler placed
// below applyConfigUpdate's policy-probe early return would never fire.
func TestApplyConfigUpdateUnifiCollectorHint(t *testing.T) {
	cases := []struct {
		name   string
		update map[string]any
		want   int32
	}{
		{"snake_case true wakes", map[string]any{"unifi_collectors_assigned": true}, 1},
		{"camelCase true wakes", map[string]any{"unifiCollectorsAssigned": true}, 1},
		{"false does not wake", map[string]any{"unifi_collectors_assigned": false}, 0},
		{"non-bool is ignored", map[string]any{"unifi_collectors_assigned": "true"}, 0},
		{"absent (older server) does not wake", map[string]any{"backup_server_url": ""}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h := &Heartbeat{config: config.Default()}
			var wakes atomic.Int32
			h.SetUnifiCollectorWake(func() { wakes.Add(1) })
			h.applyConfigUpdate(tc.update)
			if got := wakes.Load(); got != tc.want {
				t.Fatalf("wakes = %d, want %d", got, tc.want)
			}
		})
	}
}

// Support mode starts no collector loop and registers no wake; the hint must
// then be a no-op rather than a nil-func panic.
func TestApplyConfigUpdateUnifiCollectorHintWithoutWake(t *testing.T) {
	h := &Heartbeat{config: config.Default()}
	h.applyConfigUpdate(map[string]any{"unifi_collectors_assigned": true})
	h.SetUnifiCollectorWake(nil)
	h.applyConfigUpdate(map[string]any{"unifi_collectors_assigned": true})
}
