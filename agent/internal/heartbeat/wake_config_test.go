package heartbeat

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/wakeconfig"
)

func TestParseWakeSettingsShapes(t *testing.T) {
	for _, raw := range []any{
		map[string]any{"enabled": true, "configure_settings": false, "firmware_writes": []any{}},
		map[string]any{"enabled": true, "configureSettings": false, "firmwareWrites": []any{}},
		map[string]any{"enabled": true},
	} {
		s, ok := parseWakeSettings(raw)
		if !ok || !s.Enabled {
			t.Fatalf("%v -> %+v %v", raw, s, ok)
		}
	}
	if s, ok := parseWakeSettings(map[string]any{"enabled": false}); !ok || s.Enabled {
		t.Fatalf("disabled: %+v %v", s, ok)
	}
}

func TestApplyWakeSettingsIgnoresUnknownFields(t *testing.T) {
	// A firmware write or configure request in the payload must have no effect:
	// only `enabled` is read and the settings type has nowhere to carry the rest.
	s, ok := parseWakeSettings(map[string]any{
		"enabled": true, "configure_settings": true,
		"firmware_writes": []any{map[string]any{"name": "WakeOnLan", "value": "LanOnly"}},
		"fast_startup":    "disable",
	})
	if !ok || s != (wakeconfig.Settings{Enabled: true}) {
		t.Fatalf("got %+v ok=%v", s, ok)
	}
}

type wakeApplyRecorder struct {
	mu    sync.Mutex
	calls []wakeconfig.Settings
}

func (r *wakeApplyRecorder) add(s wakeconfig.Settings) {
	r.mu.Lock()
	r.calls = append(r.calls, s)
	r.mu.Unlock()
}
func (r *wakeApplyRecorder) n() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.calls) }

func TestApplyWakeSettingsAbsentBlockMeansNoChange(t *testing.T) {
	rec := &wakeApplyRecorder{}
	h := &Heartbeat{wakeApply: rec.add}
	h.applyWakeOnLanFromUpdate(map[string]any{"workload_inventory_settings": map[string]any{}})
	if rec.n() != 0 {
		t.Fatalf("absent block applied %d times", rec.n())
	}
	h.applyWakeOnLanFromUpdate(map[string]any{"wake_on_lan_settings": map[string]any{"enabled": true}})
	h.applyWakeOnLanFromUpdate(map[string]any{"wakeOnLanSettings": map[string]any{"enabled": false}})
	if rec.n() != 2 || !rec.calls[0].Enabled || rec.calls[1].Enabled {
		t.Fatalf("calls: %+v", rec.calls)
	}
}

func TestApplyWakeSettingsInvalidIgnored(t *testing.T) {
	rec := &wakeApplyRecorder{}
	h := &Heartbeat{wakeApply: rec.add}
	for _, raw := range []any{"x", nil, 3.0, map[string]any{}, map[string]any{"enabled": "yes"}, map[string]any{"enabled": nil}} {
		h.applyWakeOnLanFromUpdate(map[string]any{"wake_on_lan_settings": raw})
	}
	if rec.n() != 0 {
		t.Fatalf("invalid payloads applied: %+v", rec.calls)
	}
}

func TestApplyWakeSettingsDoesNotBlockWithRealManager(t *testing.T) {
	m := wakeconfig.New(wakeconfig.Options{
		Collect: func(context.Context) (wakeconfig.Inputs, error) {
			return wakeconfig.Inputs{}, wakeconfig.ErrUnsupported
		},
		Upload: func(context.Context, wakeconfig.Snapshot) error { return nil },
	})
	h := &Heartbeat{wake: m}
	done := make(chan struct{})
	go func() {
		for i := 0; i < 500; i++ {
			h.applyWakeOnLanSettings(map[string]any{"enabled": i%2 == 0})
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("applying wake settings blocked")
	}
}
