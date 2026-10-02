package main

import (
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// TestUpdatesTakeTrustInputsFromACheckedReload: the update-signing keys,
// signing-key requirement and backup server the watchdog updates with are
// read from the config at update time, through the loader's trust check —
// never from what it loaded at start. If that read is refused, nothing is
// downloaded.
func TestUpdatesTakeTrustInputsFromACheckedReload(t *testing.T) {
	journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = journal.Close() }()
	tokens := &tokenHolder{}
	tokens.Replace("tok")

	orig := updateTrustConfigFn
	t.Cleanup(func() { updateTrustConfigFn = orig })
	reloads := 0
	updateTrustConfigFn = func() (*config.Config, error) {
		reloads++
		return nil, fmt.Errorf("%w: agent.yaml is owned by another account", config.ErrConfigDirUntrusted)
	}
	serverURL := func() string {
		t.Error("an update was attempted with a config the loader refused")
		return "https://example.invalid"
	}

	for name, update := range map[string]func() error{
		"agent":    func() error { return doUpdateAgent("2.0.0", serverURL, tokens, journal) },
		"watchdog": func() error { return doUpdateWatchdog("2.0.0", serverURL, tokens, journal) },
	} {
		err := update()
		if !errors.Is(err, config.ErrConfigDirUntrusted) {
			t.Errorf("%s update: err = %v, want the refusal", name, err)
		}
		if err != nil && !strings.Contains(err.Error(), "refusing to update") {
			t.Errorf("%s update: err = %v, want it to say the update was refused", name, err)
		}
	}
	if reloads != 2 {
		t.Errorf("config re-read %d times, want once per update", reloads)
	}
}
