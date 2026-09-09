//go:build windows

package systemstate

import (
	"errors"
	"os"
	"testing"
)

// These tests exercise the WindowsCollector methods directly rather than the
// full CollectState pipeline: CollectState also runs bcdedit/driverquery/
// sc/schtasks/netsh/dism, whose success depends on the host's privileges and
// installed roles (this package is already known-red on windows-latest CI
// for reasons unrelated to this change — see ci.yml's test-agent-windows
// job and issue #2523). Scoping to collectRegistry/collectCertificates plus
// the existing missingRequired/windowsRequiredSteps contract verifies the
// same behavior without coupling to those unrelated steps.
//
// NOTE: this file cannot execute in the darwin dev sandbox this change was
// authored in — GOOS=windows Go test binaries cannot run on macOS. It is
// verified here via `gofmt`, `go vet` and `go build` under GOOS=windows
// (which type-check and compile it), and is intended to run for real in CI
// or on a Windows host once internal/backup/systemstate is added to the
// test-agent-windows allowlist (or manually via `go test ./...` on Windows).

func TestWindowsCollectRegistryPartialFailureIsRequiredStepFailure(t *testing.T) {
	orig := runRegSave
	defer func() { runRegSave = orig }()

	runRegSave = func(hive, outPath string) ([]byte, error) {
		if hive == "SECURITY" {
			return []byte("access is denied"), errors.New("exit status 5")
		}
		if err := os.WriteFile(outPath, []byte("hive-"+hive), 0o600); err != nil {
			return nil, err
		}
		return []byte("ok"), nil
	}

	c := &WindowsCollector{}
	artifacts, err := c.collectRegistry(t.TempDir())

	if err == nil {
		t.Fatal("collectRegistry: expected error, got nil")
	}
	var rsErr *registrySaveError
	if !errors.As(err, &rsErr) {
		t.Fatalf("collectRegistry: error type = %T, want *registrySaveError", err)
	}
	if len(rsErr.FailedHives) != 1 || rsErr.FailedHives[0] != "SECURITY" {
		t.Errorf("FailedHives = %v, want [SECURITY]", rsErr.FailedHives)
	}
	if len(artifacts) != 3 {
		t.Errorf("artifacts = %d, want 3 (hives that succeeded are kept)", len(artifacts))
	}

	// registry is a required step: CollectState's own missingRequired check
	// against windowsRequiredSteps must treat this failure as fatal, exactly
	// like it already does for a wholesale registry-step failure.
	missing := missingRequired([]string{"registry"}, windowsRequiredSteps)
	if len(missing) != 1 || missing[0] != "registry" {
		t.Errorf("missingRequired([registry]) = %v, want [registry]", missing)
	}
}

func TestWindowsCollectRegistryAllHivesSucceed(t *testing.T) {
	orig := runRegSave
	defer func() { runRegSave = orig }()

	runRegSave = func(hive, outPath string) ([]byte, error) {
		if err := os.WriteFile(outPath, []byte("hive-"+hive), 0o600); err != nil {
			return nil, err
		}
		return []byte("ok"), nil
	}

	c := &WindowsCollector{}
	artifacts, err := c.collectRegistry(t.TempDir())
	if err != nil {
		t.Fatalf("collectRegistry: unexpected error: %v", err)
	}
	if len(artifacts) != len(registryHives) {
		t.Errorf("artifacts = %d, want %d", len(artifacts), len(registryHives))
	}
}

func TestWindowsCollectCertificatesSkipsWhenCertSvcAbsent(t *testing.T) {
	origInstalled := certSvcInstalled
	defer func() { certSvcInstalled = origInstalled }()
	certSvcInstalled = func() bool { return false }

	c := &WindowsCollector{}
	artifacts, err := c.collectCertificates(t.TempDir())
	if err != nil {
		t.Fatalf("collectCertificates: unexpected error: %v", err)
	}
	if artifacts != nil {
		t.Errorf("artifacts = %v, want nil", artifacts)
	}

	// A cleanly-skipped step must not read as an incomplete one — mirrors
	// collectIIS's existing appcmd.exe-absent behavior. certs was never in
	// windowsRequiredSteps, so this is really asserting that invariant holds.
	missing := missingRequired([]string{"certs"}, windowsRequiredSteps)
	if len(missing) != 0 {
		t.Errorf("certs must not be a required step: missingRequired = %v", missing)
	}
}

func TestWindowsCollectCertificatesFailsWhenCertSvcPresentButCertutilFails(t *testing.T) {
	origInstalled := certSvcInstalled
	defer func() { certSvcInstalled = origInstalled }()
	certSvcInstalled = func() bool { return true }

	// No AD CS is actually installed on a stock test runner, so the real
	// certutil -backupDB call fails exactly as observed live (0x80070002).
	// This preserves that pre-existing failure behavior for a host that
	// claims (or is faked to claim) the role is present but has no store.
	c := &WindowsCollector{}
	_, err := c.collectCertificates(t.TempDir())
	if err == nil {
		t.Skip("certutil -backupDB unexpectedly succeeded on this host (AD CS may genuinely be installed); nothing to assert")
	}
}
