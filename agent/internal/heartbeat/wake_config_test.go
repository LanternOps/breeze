package heartbeat

import (
	"context"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/biosconfig"
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

// firmware_writes is a bounded list of vendor names from a closed set: only a
// vendor whose write path ships in this agent (Dell) is recognised. Anything
// else, including an absent key (an older API), grants nothing.
func TestParseWakeFirmwareWrites(t *testing.T) {
	for name, tc := range map[string]struct {
		raw  map[string]any
		want biosconfig.VendorSet
	}{
		"snake dell":       {map[string]any{"enabled": true, "firmware_writes": []any{"dell"}}, biosconfig.VendorDell},
		"camel dell":       {map[string]any{"enabled": true, "firmwareWrites": []any{"Dell"}}, biosconfig.VendorDell},
		"absent":           {map[string]any{"enabled": true}, 0},
		"empty":            {map[string]any{"enabled": true, "firmware_writes": []any{}}, 0},
		"no write path":    {map[string]any{"enabled": true, "firmware_writes": []any{"hp", "lenovo", "surface"}}, 0},
		"not a list":       {map[string]any{"enabled": true, "firmware_writes": "dell"}, 0},
		"objects":          {map[string]any{"enabled": true, "firmware_writes": []any{map[string]any{"name": "dell"}}}, 0},
		"mixed":            {map[string]any{"enabled": true, "firmware_writes": []any{1.0, nil, "dell"}}, biosconfig.VendorDell},
		"past entry bound": {map[string]any{"enabled": true, "firmware_writes": []any{"x", "x", "x", "x", "x", "x", "x", "x", "dell"}}, 0},
	} {
		s, ok := parseWakeSettings(tc.raw)
		if !ok || s.FirmwareWrites != tc.want {
			t.Errorf("%s: got %v ok=%v, want %v", name, s.FirmwareWrites, ok, tc.want)
		}
		if s.Observe != 0 {
			t.Errorf("%s: firmware_writes must not grant observation", name)
		}
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

// countingFirmware is a Dell adapter whose BIOS reads wrong and unprotected,
// and which counts every Apply.
type countingFirmware struct{ applies atomic.Int32 }

func (f *countingFirmware) Vendor() string { return "dell" }
func (f *countingFirmware) Read(context.Context) ([]biosconfig.Setting, error) {
	return []biosconfig.Setting{
		{Name: "WakeOnLan", Value: "Disabled", Allowed: []string{"Disabled", "LanOnly"}},
		{Name: "DeepSleepCtrl", Value: "S4AndS5", Allowed: []string{"Disabled", "S5Only", "S4AndS5"}},
	}, nil
}
func (f *countingFirmware) Protection(context.Context) (biosconfig.Protection, error) {
	return biosconfig.ProtectionNone, nil
}
func (f *countingFirmware) Apply(context.Context, string, string) error { f.applies.Add(1); return nil }

// Production wiring must use the machine's own BitLocker readers (no seam
// override), so the activation test below exercises the real gate order.
func TestProductionWakeWiringUsesSystemBitLockerReaders(t *testing.T) {
	h := &Heartbeat{config: &config.Config{AgentID: "agent-1"}}
	opts := h.wakeOptions()
	if opts.BitLockerState != nil || opts.BitLockerProtectors != nil {
		t.Fatal("production wiring must not override the BitLocker readers")
	}
}

// With firmware_writes ["dell"], configure_settings true, a wrong and
// unprotected Dell BIOS, the inactive build calls neither the firmware adapter
// nor the BitLocker guard.
func TestProductionWakeWiringNeverWritesFirmwareBeforeActivation(t *testing.T) {
	h := &Heartbeat{config: &config.Config{AgentID: "agent-1"}}
	opts := h.wakeOptions()
	var uploads, blReads atomic.Int32
	fw := &countingFirmware{}
	opts.Writer = &countingWakeWriter{}
	opts.FirstDelay = 0
	opts.StatePath = filepath.Join(t.TempDir(), wakeconfig.StateFileName)
	opts.Reread = func(context.Context) (*wakeconfig.WindowsReadings, error) { return badWakeReadings(), nil }
	opts.BitLockerState = func() (string, error) { blReads.Add(1); return "off", nil }
	opts.BitLockerProtectors = func(context.Context) (string, error) { blReads.Add(1); return "", nil }
	opts.Collect = func(ctx context.Context) (wakeconfig.Inputs, error) {
		return wakeconfig.Inputs{OS: "windows", Manufacturer: "Dell Inc.", Model: "OptiPlex 7060", Windows: badWakeReadings(),
			Firmware: wakeconfig.ReadFirmware(ctx, fw), FirmwareAdapter: fw}, nil
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
	if n := fw.applies.Load(); n != 0 {
		t.Fatalf("inactive build made %d firmware writes", n)
	}
	if n := blReads.Load(); n != 0 {
		t.Fatalf("inactive build read BitLocker %d times", n)
	}
}

// The production wiring must not write while the activation switch is off, even
// when a server delivers configure_settings true and every setting reads wrong.
func TestProductionWakeWiringNeverWritesBeforeActivation(t *testing.T) {
	h := &Heartbeat{config: &config.Config{AgentID: "agent-1"}}
	opts := h.wakeOptions()
	if opts.Reread == nil || opts.BootID == nil {
		t.Fatal("production wiring must supply Reread and BootID")
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
