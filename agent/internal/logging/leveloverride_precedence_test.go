package logging

import (
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// The file only adds or replaces an override; its absence must never clear
// one (that is what keeps an in-memory-only override alive when the write
// failed).
func TestRefreshWithAbsentFileKeepsInMemoryOverride(t *testing.T) {
	s := NewShipper(ShipperConfig{
		ServerURL:         func() string { return "http://localhost:0" },
		AuthToken:         testToken("tok"),
		MinLevel:          "warn",
		LevelOverridePath: filepath.Join(t.TempDir(), LevelOverrideFileName),
	})
	now := time.Now()
	s.setLevelOverride(slog.LevelDebug, now.Add(10*time.Minute), now)
	s.refreshLevelOverride()
	if !s.ShouldShip(slog.LevelDebug) {
		t.Fatal("absent override file cleared a live in-memory override")
	}
}

// A newer command whose write failed must not be displaced by an older,
// still-active file on the next poll.
func TestRefreshDoesNotReplaceNewerInMemoryOverrideWithStaleFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	now := time.Now()
	writeOverrideFile(t, path, LevelOverride{Level: "error", ExpiresAt: now.Add(20 * time.Minute), SetAt: now.Add(-time.Minute)})

	s := NewShipper(ShipperConfig{
		ServerURL:         func() string { return "http://localhost:0" },
		AuthToken:         testToken("tok"),
		MinLevel:          "warn",
		LevelOverridePath: path,
	})
	s.setLevelOverride(slog.LevelDebug, now.Add(10*time.Minute), now)
	s.refreshLevelOverride()
	if !s.ShouldShip(slog.LevelDebug) {
		t.Fatal("stale override file replaced a newer in-memory override")
	}
}

// Helper propagation end to end: the agent's ApplyShipperLevelOverride writes
// the file, and a second, independent shipper (the helper) picks up both the
// first override and a later replacement with a shorter expiry.
func TestOverridePropagatesFromWriterToSecondShipper(t *testing.T) {
	prev := levelOverridePollInterval
	levelOverridePollInterval = 10 * time.Millisecond
	t.Cleanup(func() { levelOverridePollInterval = prev })

	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	agent := installTestShipper(t, slog.LevelWarn)
	agent.overridePath = path

	helper := NewShipper(ShipperConfig{
		ServerURL:         func() string { return "http://localhost:0" },
		AuthToken:         testToken("tok"),
		MinLevel:          "warn",
		LevelOverridePath: path,
	})
	helper.Start()
	defer helper.Stop()

	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for !cond() {
			if time.Now().After(deadline) {
				t.Fatalf("helper never picked up %s", what)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}

	if _, err := ApplyShipperLevelOverride("debug", time.Hour); err != nil {
		t.Fatal(err)
	}
	waitFor("the debug override", func() bool { return helper.ShouldShip(slog.LevelDebug) })

	// Make sure the replacement's SetAt is strictly newer.
	time.Sleep(2 * time.Millisecond)
	if _, err := ApplyShipperLevelOverride("error", 5*time.Minute); err != nil {
		t.Fatal(err)
	}
	waitFor("the replacement error override", func() bool { return !helper.ShouldShip(slog.LevelWarn) })
}

func TestApplyShipperLevelOverrideAcceptsExactlyTheBound(t *testing.T) {
	installTestShipper(t, slog.LevelWarn)
	if _, err := ApplyShipperLevelOverride("debug", MaxLevelOverrideDuration); err != nil {
		t.Fatalf("exactly MaxLevelOverrideDuration rejected: %v", err)
	}
}

// A read error is reported once per bad spell, not once per process: after a
// good read, a later bad file must be reported again.
func TestOverrideReadWarningRearmsAfterGoodRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), LevelOverrideFileName)
	s := NewShipper(ShipperConfig{
		ServerURL:         func() string { return "http://localhost:0" },
		AuthToken:         testToken("tok"),
		MinLevel:          "warn",
		LevelOverridePath: path,
	})
	writeRaw := func(content string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	writeRaw("garbage")
	s.refreshLevelOverride()
	if !s.overrideReadErrLogged.Load() {
		t.Fatal("first bad read not reported")
	}
	writeOverrideFile(t, path, LevelOverride{Level: "info", ExpiresAt: time.Now().Add(time.Minute), SetAt: time.Now()})
	s.refreshLevelOverride()
	if s.overrideReadErrLogged.Load() {
		t.Fatal("warning latch not re-armed after a good read")
	}
}
