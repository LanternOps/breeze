package main

import (
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

func TestWatchdogUnitDefaultDescriptionIsGolden(t *testing.T) {
	if n := strings.Count(watchdogUnit, "\nDescription="); n != 1 {
		t.Fatalf("watchdogUnit has %d Description= lines, want exactly 1", n)
	}
	if !strings.Contains(watchdogUnit, "\nDescription=Breeze RMM Agent Watchdog\n") {
		t.Fatalf("watchdogUnit default description is no longer %q", "Breeze RMM Agent Watchdog")
	}
}

func TestCurrentWatchdogUnitWithoutBrandingIsEmbedded(t *testing.T) {
	restore := branding.SetForTest(branding.Values{})
	defer restore()
	if got := currentWatchdogUnit(); got != watchdogUnit {
		t.Fatal("currentWatchdogUnit() must equal watchdogUnit when no branding is set")
	}
}

func TestCurrentWatchdogUnitBrandedChangesOnlyDescription(t *testing.T) {
	restore := branding.SetForTest(branding.Values{WatchdogServiceDescription: "Example MSP Watchdog"})
	defer restore()
	got := currentWatchdogUnit()
	want := strings.Replace(watchdogUnit, "\nDescription=Breeze RMM Agent Watchdog\n", "\nDescription=Example MSP Watchdog\n", 1)
	if got != want {
		t.Fatal("branded unit differs from the embedded one in more than the Description= line")
	}
}

func TestCurrentWatchdogUnitInvalidBrandFallsBack(t *testing.T) {
	restore := branding.SetForTest(branding.Values{WatchdogServiceDescription: "Example\nExecStart=/bin/sh"})
	defer restore()
	if got := currentWatchdogUnit(); got != watchdogUnit {
		t.Fatal("an invalid brand must fall back to the embedded unit")
	}
}
