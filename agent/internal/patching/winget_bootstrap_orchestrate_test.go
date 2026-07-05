package patching

import (
	"errors"
	"strings"
	"testing"
)

func TestEnsureWinget_AlreadyPresent(t *testing.T) {
	res := EnsureWinget(EnsureDeps{
		Locate:        func() (string, string, error) { return `C:\wg\winget.exe`, "1.22.0.0", nil },
		AppxAvailable: func() bool { return true },
		Provision:     func() error { t.Fatal("should not provision"); return nil },
	})
	if !res.Available || res.WingetPath == "" {
		t.Fatalf("want available, got %+v", res)
	}
}

func TestEnsureWinget_ProvisionsThenSucceeds(t *testing.T) {
	calls := 0
	res := EnsureWinget(EnsureDeps{
		Locate: func() (string, string, error) {
			calls++
			if calls == 1 {
				return "", "", errWingetNotFound
			}
			return `C:\wg\winget.exe`, "1.22.0.0", nil
		},
		AppxAvailable: func() bool { return true },
		Provision:     func() error { return nil },
	})
	if !res.Available {
		t.Fatalf("want available after provision, got %+v", res)
	}
}

func TestEnsureWinget_UnavailableNoStack(t *testing.T) {
	res := EnsureWinget(EnsureDeps{
		Locate:        func() (string, string, error) { return "", "", errWingetNotFound },
		AppxAvailable: func() bool { return false },
		Provision:     func() error { t.Fatal("should not provision"); return nil },
	})
	if res.Available || res.Reason == "" {
		t.Fatalf("want unavailable with reason, got %+v", res)
	}
}

func TestEnsureWinget_ProvisionFails(t *testing.T) {
	res := EnsureWinget(EnsureDeps{
		Locate:        func() (string, string, error) { return "", "", errWingetNotFound },
		AppxAvailable: func() bool { return true },
		Provision:     func() error { return errors.New("dism boom") },
	})
	if res.Available || res.Reason == "" {
		t.Fatalf("want unavailable, got %+v", res)
	}
}

func TestEnsureWinget_ProvisionFailsFallsBackToExisting(t *testing.T) {
	// An outdated-but-present winget triggers a provisioning attempt; when
	// that fails, the located install must still be used — old winget beats
	// nothing (same rationale as decideBootstrap's no-Appx-stack fallback).
	res := EnsureWinget(EnsureDeps{
		Locate:        func() (string, string, error) { return `C:\wg\winget.exe`, "1.2.0.0", nil },
		AppxAvailable: func() bool { return true },
		Provision:     func() error { return errors.New("dism boom") },
	})
	if !res.Available || res.WingetPath != `C:\wg\winget.exe` || res.Version != "1.2.0.0" {
		t.Fatalf("want fallback to existing install, got %+v", res)
	}
	// The provisioning failure must be recorded on Reason (even though the
	// result stays Available) so the caller can log it at Warn — a fleet stuck
	// on stale winget after repeated failed upgrades must not be invisible.
	if res.Reason == "" {
		t.Fatalf("want provisioning failure recorded on Reason, got empty; %+v", res)
	}
	if !strings.Contains(res.Reason, "dism boom") {
		t.Fatalf("want Reason to contain provisioning error %q, got %q", "dism boom", res.Reason)
	}
}
