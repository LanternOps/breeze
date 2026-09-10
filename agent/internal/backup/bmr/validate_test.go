package bmr

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// withGOOS overrides the package-level goos var (validate.go) for the
// duration of the test, so checkServices' platform dispatch can be
// exercised deterministically regardless of the actual test host OS.
func withGOOS(t *testing.T, value string) {
	t.Helper()
	orig := goos
	t.Cleanup(func() { goos = orig })
	goos = value
}

// withServiceProbeCommand overrides runServiceProbeCommand for the
// duration of the test so checkServicesLinux/checkServicesWindows never
// shell out to a real systemctl/sc binary.
func withServiceProbeCommand(t *testing.T, fn func(name string, args ...string) ([]byte, error)) {
	t.Helper()
	orig := runServiceProbeCommand
	t.Cleanup(func() { runServiceProbeCommand = orig })
	runServiceProbeCommand = fn
}

// TestCheckServicesLinux_InactiveUnitFailsAndIsNamed proves the Linux
// service probe (validate.go checkServicesLinux, replacing the old
// unconditional-true stub, campaign finding B1b): a unit the probe finds
// NOT active must fail validation and be named in the result.
func TestCheckServicesLinux_InactiveUnitFailsAndIsNamed(t *testing.T) {
	withGOOS(t, "linux")
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		if name != "systemctl" || len(args) != 2 || args[0] != "is-active" {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		unit := args[1]
		if unit == "sshd" {
			return []byte("inactive\n"), errors.New("exit status 3")
		}
		return []byte("active\n"), nil
	})

	ok, inactive := checkServices([]string{"cron", "sshd", "networking"})
	if ok {
		t.Fatal("expected checkServices to report failure when one unit is inactive")
	}
	if len(inactive) != 1 || inactive[0] != "sshd" {
		t.Fatalf("inactive = %v, want exactly [sshd]", inactive)
	}
}

// TestCheckServicesLinux_AllActivePasses is the positive counterpart: every
// unit reporting active must pass with no names returned.
func TestCheckServicesLinux_AllActivePasses(t *testing.T) {
	withGOOS(t, "linux")
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		return []byte("active\n"), nil
	})

	ok, inactive := checkServices([]string{"cron", "sshd"})
	if !ok {
		t.Fatalf("expected checkServices to pass, inactive = %v", inactive)
	}
	if len(inactive) != 0 {
		t.Fatalf("expected no inactive services, got %v", inactive)
	}
}

// TestCheckServicesLinux_NoKnownUnitsTriviallyPasses proves that an empty
// serviceUnits list (no services/systemd.txt was staged — e.g. an
// older/partial capture) does not fail validation: this run never claimed
// to restore any services, so there is nothing to check.
func TestCheckServicesLinux_NoKnownUnitsTriviallyPasses(t *testing.T) {
	withGOOS(t, "linux")
	called := false
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		called = true
		return nil, nil
	})

	ok, inactive := checkServices(nil)
	if !ok || len(inactive) != 0 {
		t.Fatalf("expected trivial pass for no known units, got ok=%v inactive=%v", ok, inactive)
	}
	if called {
		t.Fatal("expected no probe command to run with zero known units")
	}
}

// TestCheckServicesWindows_InactiveServiceFailsAndIsNamed proves the
// Windows probe checks a fixed critical set via `sc query`, independent of
// serviceUnits.
func TestCheckServicesWindows_InactiveServiceFailsAndIsNamed(t *testing.T) {
	withGOOS(t, "windows")
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		if name != "sc" || len(args) != 2 || args[0] != "query" {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		svc := args[1]
		if svc == "Dnscache" {
			return []byte("STATE: 1 STOPPED"), nil
		}
		return []byte("STATE: 4 RUNNING"), nil
	})

	ok, inactive := checkServices(nil) // serviceUnits ignored on Windows
	if ok {
		t.Fatal("expected checkServices to fail when a critical Windows service is stopped")
	}
	if len(inactive) != 1 || inactive[0] != "Dnscache" {
		t.Fatalf("inactive = %v, want exactly [Dnscache]", inactive)
	}
}

// TestCheckServicesDarwin_AlwaysPasses proves the macOS branch is a no-op —
// there is no per-run service-restore step to validate on darwin (see
// restore_darwin.go).
func TestCheckServicesDarwin_AlwaysPasses(t *testing.T) {
	withGOOS(t, "darwin")
	called := false
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		called = true
		return nil, nil
	})

	ok, inactive := checkServices([]string{"anything"})
	if !ok || len(inactive) != 0 {
		t.Fatalf("expected darwin to always pass, got ok=%v inactive=%v", ok, inactive)
	}
	if called {
		t.Fatal("expected no probe command to run on darwin")
	}
}

// TestParseSystemdEnabledUnits proves the parser matches the real
// `systemctl list-unit-files --type=service` output shape the producer
// writes to services/systemd.txt (systemstate/state_linux.go
// collectServices) — keeping only units whose STATE column is exactly
// "enabled", skipping the header and footer lines.
func TestParseSystemdEnabledUnits(t *testing.T) {
	data := []byte(strings.Join([]string{
		"UNIT FILE                              STATE",
		"cron.service                           enabled",
		"sshd.service                           enabled",
		"bluetooth.service                      disabled",
		"getty@.service                         static",
		"",
		"4 unit files listed.",
	}, "\n"))

	got := parseSystemdEnabledUnits(data)
	want := []string{"cron.service", "sshd.service"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

// TestEnabledSystemdUnitsFromStaging_MissingArtifactReturnsNil proves the
// non-Linux / older-capture case: no services/systemd.txt in staging simply
// yields nil, not an error.
func TestEnabledSystemdUnitsFromStaging_MissingArtifactReturnsNil(t *testing.T) {
	stagingDir := t.TempDir()
	if got := enabledSystemdUnitsFromStaging(stagingDir); got != nil {
		t.Fatalf("expected nil for a staging dir with no services artifact, got %v", got)
	}
}

// TestEnabledSystemdUnitsFromStaging_ReadsStagedArtifact proves the
// staging-dir lookup path end to end.
func TestEnabledSystemdUnitsFromStaging_ReadsStagedArtifact(t *testing.T) {
	stagingDir := t.TempDir()
	servicesDir := filepath.Join(stagingDir, "services")
	if err := os.MkdirAll(servicesDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := "UNIT FILE          STATE\ncron.service       enabled\nbluetooth.service  disabled\n"
	if err := os.WriteFile(filepath.Join(servicesDir, "systemd.txt"), []byte(content), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	got := enabledSystemdUnitsFromStaging(stagingDir)
	if len(got) != 1 || got[0] != "cron.service" {
		t.Fatalf("got %v, want [cron.service]", got)
	}
}
