package patching

import (
	"errors"
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
