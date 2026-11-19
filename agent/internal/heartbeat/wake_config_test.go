package heartbeat

import (
	"context"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
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
	// A firmware write or a setting name in the payload must have no effect:
	// only `enabled` and the boolean `configure_settings` are read, and the
	// settings type has nowhere to carry the rest.
	s, ok := parseWakeSettings(map[string]any{
		"enabled": true, "configure_settings": true,
		"firmware_writes": []any{map[string]any{"name": "WakeOnLan", "value": "LanOnly"}},
		"fast_startup":    "disable",
	})
	if !ok || s != (wakeconfig.Settings{Enabled: true, ConfigureSettings: true}) {
		t.Fatalf("got %+v ok=%v", s, ok)
	}
}

func TestParseWakeConfigureSettings(t *testing.T) {
	for raw, want := range map[string]map[string]any{
		"snake":  {"enabled": true, "configure_settings": true},
		"camel":  {"enabled": true, "configureSettings": true},
		"absent": {"enabled": true},
		"string": {"enabled": true, "configure_settings": "true"},
		"number": {"enabled": true, "configure_settings": 1.0},
		"null":   {"enabled": true, "configure_settings": nil},
	} {
		s, ok := parseWakeSettings(want)
		wantConfigure := raw == "snake" || raw == "camel"
		if !ok || !s.Enabled || s.ConfigureSettings != wantConfigure {
			t.Fatalf("%s: got %+v ok=%v", raw, s, ok)
		}
	}
}

type countingWakeWriter struct{ n atomic.Int32 }

func (w *countingWakeWriter) Write(context.Context, wakeconfig.Op) error { w.n.Add(1); return nil }

// The production wiring must not write while the activation switch is off, even
// when a server delivers configure_settings true and every setting reads wrong.
func TestProductionWakeWiringNeverWritesBeforeActivation(t *testing.T) {
	h := &Heartbeat{config: &config.Config{AgentID: "agent-1"}}
	opts := h.wakeOptions()
	if opts.Reread == nil || opts.BootTime == nil {
		t.Fatal("production wiring must supply Reread and BootTime")
	}
	var uploads atomic.Int32
	w := &countingWakeWriter{}
	opts.Writer = w
	opts.FirstDelay = 0
	opts.StatePath = filepath.Join(t.TempDir(), wakeconfig.StateFileName)
	opts.Reread = func(context.Context) (*wakeconfig.WindowsReadings, error) { return badWakeReadings(), nil }
	opts.Collect = func(context.Context) (wakeconfig.Inputs, error) {
		return wakeconfig.Inputs{OS: "windows", Manufacturer: "Dell Inc.", Model: "OptiPlex 7060", Windows: badWakeReadings()}, nil
	}
	opts.Upload = func(context.Context, wakeconfig.Snapshot) error { uploads.Add(1); return nil }
	h.wake = wakeconfig.New(opts)
	h.applyWakeOnLanFromUpdate(map[string]any{"wake_on_lan_settings": map[string]any{
		"enabled": true, "configure_settings": true, "firmware_writes": []any{"dell"},
	}})
	h.wake.Start(context.Background())
	defer h.wake.Stop()
	deadline := time.Now().Add(5 * time.Second)
	for uploads.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if uploads.Load() == 0 {
		t.Fatal("no cycle ran")
	}
	if n := w.n.Load(); n != 0 {
		t.Fatalf("inactive build made %d writes", n)
	}
}

func badWakeReadings() *wakeconfig.WindowsReadings {
	return &wakeconfig.WindowsReadings{FastStartup: "enabled", Adapters: []wakeconfig.AdapterReading{
		{MAC: "aa:bb:cc:dd:ee:01", MagicPacket: "disabled", EEE: "enabled", ShutdownWake: "disabled"},
	}}
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
