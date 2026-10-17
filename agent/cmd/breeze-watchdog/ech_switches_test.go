package main

import (
	"errors"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ech"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// TestWatchdogFailoverHonoursBootECHSwitchWhenReloadFails: the operator set
// `ech: false`. The watchdog boots on that config, and at the failover-window
// start the config re-read fails. The failover client's dialer must still be
// plain-only: the switches come from the boot config, not only from a reload
// that succeeded.
func TestWatchdogFailoverHonoursBootECHSwitchWhenReloadFails(t *testing.T) {
	// A fresh shared dialer with both switches on, as at process start.
	t.Cleanup(ech.SetSharedForTest(ech.New(ech.Options{LocalEnabled: true, ServerEnabled: true})))

	stubWatchdogConfigWait(t, func(int) (*config.Config, error) {
		return &config.Config{AgentID: "a", ServerURL: "https://boot.example", ECH: false, ECHServerEnabled: true}, nil
	})
	origReload := failoverReloadConfigFn
	t.Cleanup(func() { failoverReloadConfigFn = origReload })
	failoverReloadConfigFn = func() (*config.Config, error) { return nil, errors.New("yaml: bad indentation") }

	cfg, err := bootWatchdogConfig(make(chan struct{}))
	if err != nil || cfg == nil {
		t.Fatalf("bootWatchdogConfig = %+v, %v", cfg, err)
	}
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	t.Cleanup(func() { _ = journal.Close() })

	if got := resolveFailoverBaseURL(cfg, journal); got != "https://boot.example" {
		t.Fatalf("failover base URL = %q, want the boot server_url after a failed reload", got)
	}
	if ech.SharedEnabledForTest() {
		t.Fatal("failover dialer has ECH enabled although the boot config says ech: false and the reload failed")
	}
}

// TestWatchdogFailoverReloadRefreshesECHSwitches: a successful re-read at the
// failover-window start still applies the on-disk switches (here the server
// kill switch, flipped since boot).
func TestWatchdogFailoverReloadRefreshesECHSwitches(t *testing.T) {
	t.Cleanup(ech.SetSharedForTest(ech.New(ech.Options{LocalEnabled: true, ServerEnabled: true})))
	origReload := failoverReloadConfigFn
	t.Cleanup(func() { failoverReloadConfigFn = origReload })
	failoverReloadConfigFn = func() (*config.Config, error) {
		return &config.Config{ServerURL: "https://promoted.example", ECH: true, ECHServerEnabled: false}, nil
	}
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatalf("new journal: %v", err)
	}
	t.Cleanup(func() { _ = journal.Close() })

	if got := resolveFailoverBaseURL(&config.Config{ServerURL: "https://boot.example"}, journal); got != "https://promoted.example" {
		t.Fatalf("failover base URL = %q, want the reloaded server_url", got)
	}
	if ech.SharedEnabledForTest() {
		t.Fatal("reloaded ech_server_enabled: false was not applied")
	}
}
