package main

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/branding"
	"github.com/breeze-rmm/agent/internal/winsvcinstall"
)

// Golden: what `service install` registers with the Windows SCM today. Without
// branding it must not change.
func TestWatchdogServiceSpecDefaultIsGolden(t *testing.T) {
	restore := branding.SetForTest(branding.Values{})
	defer restore()
	want := winsvcinstall.Spec{
		Name:        "BreezeWatchdog",
		DisplayName: "Breeze RMM Watchdog",
		Description: "Breeze Agent Watchdog - monitors and recovers the agent process",
		Args:        []string{"run"},
	}
	if got := watchdogServiceSpec("BreezeWatchdog"); !reflect.DeepEqual(got, want) {
		t.Fatalf("watchdogServiceSpec() = %+v, want %+v", got, want)
	}
}

func TestWatchdogServiceSpecUsesBrand(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		WatchdogServiceDisplayName: "Example MSP Watchdog",
		WatchdogServiceDescription: "Example MSP watchdog",
	})
	defer restore()
	got := watchdogServiceSpec("BreezeWatchdog")
	if got.DisplayName != "Example MSP Watchdog" || got.Description != "Example MSP watchdog" {
		t.Fatalf("watchdogServiceSpec() did not use the brand: %+v", got)
	}
}

func TestWatchdogServiceSpecNeverBrandsTheNameOrArgs(t *testing.T) {
	restore := branding.SetForTest(branding.Values{
		WatchdogServiceDisplayName: "Example MSP Watchdog",
		WatchdogServiceDescription: "Example MSP watchdog",
	})
	defer restore()
	got := watchdogServiceSpec("BreezeWatchdog")
	if got.Name != "BreezeWatchdog" {
		t.Fatalf("Name = %q, want BreezeWatchdog", got.Name)
	}
	if !reflect.DeepEqual(got.Args, []string{"run"}) {
		t.Fatalf("Args = %v, want [run]", got.Args)
	}
}
