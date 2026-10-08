package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

// A build made with a raw -ldflags -X skips build-edition.sh, so the Spec must
// not trust the value: an invalid brand falls back to today's text.
func TestWatchdogServiceSpecIgnoresInvalidBrand(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		WatchdogServiceDisplayName: `Acme "Pro"`,
		WatchdogServiceDescription: "bad\nvalue",
	})
	defer restore()
	got := watchdogServiceSpec("BreezeWatchdog")
	if got.DisplayName != "Breeze RMM Watchdog" {
		t.Fatalf("DisplayName = %q, want the default", got.DisplayName)
	}
	if got.Description != "Breeze Agent Watchdog - monitors and recovers the agent process" {
		t.Fatalf("Description = %q, want the default", got.Description)
	}
}
