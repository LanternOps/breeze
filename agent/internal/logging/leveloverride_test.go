package logging

import (
	"bytes"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func writeOverrideFile(t *testing.T, path string, o LevelOverride) {
	t.Helper()
	if err := WriteLevelOverride(path, o); err != nil {
		t.Fatalf("WriteLevelOverride: %v", err)
	}
}

func TestReadLevelOverride(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	dir := t.TempDir()

	tests := []struct {
		name    string
		content string // raw file content; "" means no file
		wantOK  bool
		wantErr bool
		want    string
	}{
		{name: "absent", content: "", wantOK: false},
		{
			name:    "active",
			content: `{"level":"debug","expiresAt":"2026-09-30T12:30:00Z"}`,
			wantOK:  true, want: "debug",
		},
		{
			name:    "expired",
			content: `{"level":"debug","expiresAt":"2026-09-30T11:59:59Z"}`,
			wantOK:  false,
		},
		{
			// A clock rolled back, or a hand-edited file, must not pin a
			// verbose level beyond the bound.
			name:    "beyond max bound",
			content: `{"level":"debug","expiresAt":"2026-10-02T12:00:00Z"}`,
			wantOK:  false, wantErr: true,
		},
		{
			name:    "invalid level",
			content: `{"level":"trace","expiresAt":"2026-09-30T12:30:00Z"}`,
			wantOK:  false, wantErr: true,
		},
		{name: "garbage", content: `not json`, wantOK: false, wantErr: true},
	}

	for i, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := filepath.Join(dir, "override-"+string(rune('a'+i))+".json")
			if tt.content != "" {
				if err := os.WriteFile(path, []byte(tt.content), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			got, ok, err := ReadLevelOverride(path, now)
			if ok != tt.wantOK {
				t.Fatalf("ok = %v, want %v (err=%v)", ok, tt.wantOK, err)
			}
			if (err != nil) != tt.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tt.wantErr)
			}
			if ok && got.Level != tt.want {
				t.Fatalf("level = %q, want %q", got.Level, tt.want)
			}
		})
	}
}

func TestWriteLevelOverrideIsReadableAndRoundTrips(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	expires := time.Now().Add(10 * time.Minute).UTC().Truncate(time.Second)
	writeOverrideFile(t, path, LevelOverride{Level: "info", ExpiresAt: expires})

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var decoded LevelOverride
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("file is not JSON: %v", err)
	}
	if decoded.Level != "info" || !decoded.ExpiresAt.Equal(expires) {
		t.Fatalf("round trip mismatch: %+v", decoded)
	}
	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		// Helpers run as the logged-in user on macOS/Linux and must be able
		// to read the override the root agent wrote.
		if info.Mode().Perm() != 0o644 {
			t.Fatalf("mode = %v, want 0644", info.Mode().Perm())
		}
	}
}

// A restarted process must come back at the override level, not at the
// configured base (#7416 part 1).
func TestShipperStartAppliesPersistedOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	writeOverrideFile(t, path, LevelOverride{Level: "debug", ExpiresAt: time.Now().Add(10 * time.Minute)})

	s := NewShipper(ShipperConfig{
		ServerURL:         func() string { return "http://localhost:0" },
		AuthToken:         testToken("tok"),
		MinLevel:          "warn",
		LevelOverridePath: path,
	})
	s.Start()
	defer s.Stop()

	if !s.ShouldShip(slog.LevelDebug) {
		t.Fatal("persisted debug override was not applied at start")
	}
}

func TestShipperIgnoresExpiredPersistedOverride(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	if err := os.WriteFile(path, []byte(`{"level":"debug","expiresAt":"2000-01-01T00:00:00Z"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	s := NewShipper(ShipperConfig{
		ServerURL:         func() string { return "http://localhost:0" },
		AuthToken:         testToken("tok"),
		MinLevel:          "warn",
		LevelOverridePath: path,
	})
	s.Start()
	defer s.Stop()

	if s.ShouldShip(slog.LevelInfo) {
		t.Fatal("expired override must not lower the ship floor")
	}
	if !s.ShouldShip(slog.LevelWarn) {
		t.Fatal("base level must still apply")
	}
}

// A process that is already running (the desktop helper) must pick up an
// override written after it started (#7416 part 2).
func TestShipperPollsOverrideFile(t *testing.T) {
	prev := levelOverridePollInterval
	levelOverridePollInterval = 10 * time.Millisecond
	t.Cleanup(func() { levelOverridePollInterval = prev })

	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	s := NewShipper(ShipperConfig{
		ServerURL:         func() string { return "http://localhost:0" },
		AuthToken:         testToken("tok"),
		MinLevel:          "warn",
		LevelOverridePath: path,
	})
	s.Start()
	defer s.Stop()

	if s.ShouldShip(slog.LevelDebug) {
		t.Fatal("no override yet")
	}
	writeOverrideFile(t, path, LevelOverride{Level: "debug", ExpiresAt: time.Now().Add(10 * time.Minute)})

	deadline := time.Now().Add(2 * time.Second)
	for !s.ShouldShip(slog.LevelDebug) {
		if time.Now().After(deadline) {
			t.Fatal("override written after start was never picked up")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestShipperOverrideExpiresInMemory(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	s := NewShipper(ShipperConfig{ServerURL: func() string { return "http://localhost:0" }, AuthToken: testToken("tok"), MinLevel: "warn"})
	s.now = func() time.Time { return now }

	s.setLevelOverride(slog.LevelDebug, now.Add(time.Minute), now)
	if !s.ShouldShip(slog.LevelDebug) {
		t.Fatal("override not active")
	}
	now = now.Add(time.Minute)
	if s.ShouldShip(slog.LevelDebug) {
		t.Fatal("override still active at its expiry instant")
	}
	if !s.ShouldShip(slog.LevelWarn) {
		t.Fatal("base level lost after expiry")
	}
}

// SetMinLevel (dev builds, desktop_debug) sets the BASE; an active override
// still wins until it expires, and expiry reverts to that base rather than a
// hard-coded "warn".
func TestShipperOverrideRevertsToConfiguredBase(t *testing.T) {
	now := time.Date(2026, 9, 30, 12, 0, 0, 0, time.UTC)
	s := NewShipper(ShipperConfig{ServerURL: func() string { return "http://localhost:0" }, AuthToken: testToken("tok"), MinLevel: "warn"})
	s.now = func() time.Time { return now }
	s.SetMinLevel("info")

	s.setLevelOverride(slog.LevelError, now.Add(time.Minute), now)
	if s.ShouldShip(slog.LevelInfo) {
		t.Fatal("override (error) should win over base (info) while active")
	}
	now = now.Add(2 * time.Minute)
	if !s.ShouldShip(slog.LevelInfo) {
		t.Fatal("expiry should revert to the configured base (info), not warn")
	}
}

func TestApplyShipperLevelOverridePersistsAndApplies(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	shipper := installTestShipper(t, slog.LevelWarn)
	shipper.overridePath = path

	st, err := ApplyShipperLevelOverride("debug", 30*time.Minute)
	if err != nil {
		t.Fatalf("ApplyShipperLevelOverride: %v", err)
	}
	if st.Level != "debug" || st.BaseLevel != "warn" || !st.Persisted {
		t.Fatalf("unexpected status: %+v", st)
	}
	if !shipper.ShouldShip(slog.LevelDebug) {
		t.Fatal("override not applied in memory")
	}
	got, ok, err := ReadLevelOverride(path, time.Now())
	if err != nil || !ok || got.Level != "debug" {
		t.Fatalf("override not persisted: ok=%v err=%v got=%+v", ok, err, got)
	}
	if d := time.Until(st.ExpiresAt); d < 29*time.Minute || d > 31*time.Minute {
		t.Fatalf("expiresAt %v not ~30m out", st.ExpiresAt)
	}
}

func TestApplyShipperLevelOverrideRejectsUnbounded(t *testing.T) {
	installTestShipper(t, slog.LevelWarn)
	for _, d := range []time.Duration{0, -time.Minute, MaxLevelOverrideDuration + time.Minute} {
		if _, err := ApplyShipperLevelOverride("debug", d); err == nil {
			t.Fatalf("duration %v accepted; overrides must be bounded", d)
		}
	}
}

func TestApplyShipperLevelOverrideReportsPersistFailure(t *testing.T) {
	shipper := installTestShipper(t, slog.LevelWarn)
	// A directory that does not exist: the write fails, but the running
	// process still applies the level — and says it was not persisted.
	shipper.overridePath = filepath.Join(t.TempDir(), "missing", LevelOverrideFileName)

	st, err := ApplyShipperLevelOverride("info", time.Minute)
	if err != nil {
		t.Fatalf("in-memory apply should still succeed: %v", err)
	}
	if st.Persisted || st.PersistError == "" {
		t.Fatalf("persist failure not reported: %+v", st)
	}
	if !shipper.ShouldShip(slog.LevelInfo) {
		t.Fatal("override not applied in memory")
	}
}

func TestApplyShipperLevelOverrideNoShipper(t *testing.T) {
	shipperMu.Lock()
	prev := globalShipper
	globalShipper = nil
	shipperMu.Unlock()
	t.Cleanup(func() {
		shipperMu.Lock()
		globalShipper = prev
		shipperMu.Unlock()
	})
	if _, err := ApplyShipperLevelOverride("debug", time.Minute); !errors.Is(err, ErrShipperNotInitialized) {
		t.Fatalf("err = %v, want ErrShipperNotInitialized", err)
	}
}

// The local handler runs at log_level (default info). Without consulting the
// shipper, slog drops Debug records in Enabled before the shipping handler
// ever sees them, so a "debug" override could never ship a debug line.
func TestShippingHandlerShipsBelowLocalLevelWhenShipperWantsIt(t *testing.T) {
	var buf bytes.Buffer
	handler := &shippingHandler{
		base: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}),
	}
	shipper := installTestShipper(t, slog.LevelDebug)

	slog.New(handler).Debug("ice candidate gathered", "candidate", "host")

	select {
	case entry := <-shipper.buffer:
		if entry.Level != "debug" {
			t.Fatalf("expected debug entry, got %q", entry.Level)
		}
	default:
		t.Fatal("debug record was not shipped although the shipper floor is debug")
	}
	if buf.Len() != 0 {
		t.Fatalf("debug record leaked to the info-level local handler: %q", buf.String())
	}
}

func TestShippingHandlerStillDropsBelowBothLevels(t *testing.T) {
	var buf bytes.Buffer
	handler := &shippingHandler{
		base: slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}),
	}
	shipper := installTestShipper(t, slog.LevelWarn)

	if handler.Enabled(t.Context(), slog.LevelDebug) {
		t.Fatal("debug should be disabled when both local and ship floors are above it")
	}
	slog.New(handler).Debug("noise")
	select {
	case entry := <-shipper.buffer:
		t.Fatalf("unexpected shipped entry: %+v", entry)
	default:
	}
}

// Regression: InitShipper used to hold shipperMu while Start ran, and Start
// logs when it applies a persisted override. That record goes through the
// package's own shippingHandler, whose Handle read-locks shipperMu — so a
// restart with a live override deadlocked at startup. Uses the real default
// logger (the package's rootHandler), not a test handler.
func TestInitShipperWithLiveOverrideDoesNotDeadlock(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	writeOverrideFile(t, path, LevelOverride{Level: "debug", ExpiresAt: time.Now().Add(10 * time.Minute), SetAt: time.Now()})
	t.Cleanup(StopShipper)

	done := make(chan struct{})
	go func() {
		defer close(done)
		InitShipper(ShipperConfig{
			ServerURL:         func() string { return "http://localhost:0" },
			AuthToken:         testToken("tok"),
			MinLevel:          "warn",
			LevelOverridePath: path,
		})
		// A second init (re-enrolment) must not deadlock either.
		InitShipper(ShipperConfig{
			ServerURL:         func() string { return "http://localhost:0" },
			AuthToken:         testToken("tok"),
			MinLevel:          "warn",
			LevelOverridePath: path,
		})
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("InitShipper deadlocked with a live override file")
	}

	shipperMu.RLock()
	s := globalShipper
	shipperMu.RUnlock()
	if s == nil || !s.ShouldShip(slog.LevelDebug) {
		t.Fatal("override not applied by InitShipper")
	}
}
