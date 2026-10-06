package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
)

// Golden: the root command help text today. Without branding it must not change.
func TestWatchdogRootCmdShortDefaultIsGolden(t *testing.T) {
	if rootCmd.Short != "Breeze RMM Agent Watchdog" {
		t.Fatalf("rootCmd.Short = %q, want %q", rootCmd.Short, "Breeze RMM Agent Watchdog")
	}
}

func TestWatchdogRootShortWithoutBranding(t *testing.T) {
	restore := branding.SetForTest(branding.Values{})
	defer restore()
	if got := watchdogRootShort(); got != "Breeze RMM Agent Watchdog" {
		t.Fatalf("watchdogRootShort() = %q, want the default", got)
	}
}

func TestWatchdogRootShortUsesBrand(t *testing.T) {
	restore := branding.SetForTest(branding.Values{WatchdogCLIShort: "Example MSP Watchdog"})
	defer restore()
	if got := watchdogRootShort(); got != "Example MSP Watchdog" {
		t.Fatalf("watchdogRootShort() = %q, want the brand", got)
	}
}
