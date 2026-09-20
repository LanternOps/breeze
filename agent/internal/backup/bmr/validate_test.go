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
		if name != "systemctl" || len(args) == 0 {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		switch args[0] {
		case "is-active":
			if args[len(args)-1] == "sshd" {
				return []byte("inactive\n"), errors.New("exit status 3")
			}
			return []byte("active\n"), nil
		case "show":
			// sshd is an ordinary simple service whose conditions held, so
			// the #5479 healthy-inactive escape hatch must not rescue it.
			return []byte("Type=simple\nActiveState=inactive\nSubState=dead\nConditionResult=yes\n"), nil
		default:
			t.Fatalf("unexpected command: %s %v", name, args)
			return nil, nil
		}
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
// yields (nil, nil), not an error.
func TestEnabledSystemdUnitsFromStaging_MissingArtifactReturnsNil(t *testing.T) {
	stagingDir := t.TempDir()
	got, err := enabledSystemdUnitsFromStaging(stagingDir)
	if err != nil {
		t.Fatalf("expected no error for a missing (not-exist) artifact, got: %v", err)
	}
	if got != nil {
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

	got, err := enabledSystemdUnitsFromStaging(stagingDir)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0] != "cron.service" {
		t.Fatalf("got %v, want [cron.service]", got)
	}
}

// TestEnabledSystemdUnitsFromStaging_OtherReadError_Propagates proves the
// P2 fix: a non-not-exist read failure (e.g. permission denied) must
// propagate as an error, not be silently treated the same as "no services
// artifact staged" — see enabledSystemdUnitsFromStaging's doc comment.
func TestEnabledSystemdUnitsFromStaging_OtherReadError_Propagates(t *testing.T) {
	orig := readServicesArtifact
	t.Cleanup(func() { readServicesArtifact = orig })
	injected := errors.New("simulated permission denied")
	readServicesArtifact = func(string) ([]byte, error) { return nil, injected }

	units, err := enabledSystemdUnitsFromStaging(t.TempDir())
	if err == nil {
		t.Fatal("expected a non-nil error for a non-not-exist read failure")
	}
	if !errors.Is(err, injected) {
		t.Fatalf("expected the injected error to be wrapped/propagated, got: %v", err)
	}
	if units != nil {
		t.Fatalf("expected nil units on error, got %v", units)
	}
}

// TestApplyServiceValidation_EnumerationError_FailsValidation proves the
// other half of the P2 fix: applyServiceValidation (the piece of Validate
// that checks services) must turn a non-nil serviceUnitsErr into a failed,
// not-passed result — never silently checking zero services and passing,
// which is what would happen if the error were dropped upstream.
func TestApplyServiceValidation_EnumerationError_FailsValidation(t *testing.T) {
	result := &ValidationResult{Passed: true}
	applyServiceValidation(result, nil, errors.New("permission denied reading services/systemd.txt"))

	if result.Passed {
		t.Fatal("expected Passed=false when service enumeration failed")
	}
	if result.ServicesRunning {
		t.Fatal("expected ServicesRunning=false when service enumeration failed")
	}
	found := false
	for _, f := range result.Failures {
		if strings.Contains(f, "permission denied") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a failure message recording the enumeration error, got: %v", result.Failures)
	}
}

// TestApplyServiceValidation_NoErrorFallsThroughToCheckServices proves
// applyServiceValidation's normal (nil-error) path is unaffected: it still
// dispatches to checkServices exactly as before.
func TestApplyServiceValidation_NoErrorFallsThroughToCheckServices(t *testing.T) {
	withGOOS(t, "linux")
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		return []byte("active\n"), nil
	})

	result := &ValidationResult{Passed: true}
	applyServiceValidation(result, []string{"cron"}, nil)

	if !result.Passed || !result.ServicesRunning {
		t.Fatalf("expected Passed=true, ServicesRunning=true, got Passed=%v ServicesRunning=%v Failures=%v", result.Passed, result.ServicesRunning, result.Failures)
	}
}

// TestApplySystemStateValidation pins the #5412 half of Validate: when the
// run expected system state (system_image / advertised manifest) and did
// not apply it, the verdict fails with a named check — a Validated:true on
// a recovery that applied no OS state is what let issue #5412 ship.
func TestApplySystemStateValidation(t *testing.T) {
	tests := []struct {
		name       string
		state      SystemStateOutcome
		wantPassed bool
	}{
		{"expected, not applied", SystemStateOutcome{Expected: true, ManifestFound: false, Applied: false}, false},
		{"expected, manifest found, not applied", SystemStateOutcome{Expected: true, ManifestFound: true, Applied: false}, false},
		{"expected, applied", SystemStateOutcome{Expected: true, ManifestFound: true, Applied: true}, true},
		{"not expected, nothing found", SystemStateOutcome{}, true},
		{"not expected, found but not applied", SystemStateOutcome{ManifestFound: true}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := &ValidationResult{Passed: true}
			applySystemStateValidation(result, tt.state)
			if result.Passed != tt.wantPassed || result.SystemStateApplied != tt.state.Applied {
				t.Fatalf("result = %+v, want passed=%v stateApplied=%v", result, tt.wantPassed, tt.state.Applied)
			}
			if tt.wantPassed {
				if len(result.Failures) != 0 {
					t.Fatalf("unexpected failures: %v", result.Failures)
				}
				return
			}
			if len(result.Failures) != 1 || !strings.Contains(result.Failures[0], "system state not applied") {
				t.Fatalf("failures = %v, want the named 'system state not applied' check", result.Failures)
			}
		})
	}
}

// TestValidate_StateExpectedNotApplied_Fails proves the wiring through the
// public Validate entry point (the one bmr.go calls): whatever the network
// and file probes say, Passed is false and the named check is present.
func TestValidate_StateExpectedNotApplied_Fails(t *testing.T) {
	origGoos := goos
	t.Cleanup(func() { goos = origGoos })
	goos = "darwin" // no-op service probe: keep this about the state check
	result, err := Validate(nil, nil, SystemStateOutcome{Expected: true, ManifestFound: true, Applied: false})
	if err != nil {
		t.Fatalf("Validate: %v", err)
	}
	if result.Passed {
		t.Fatalf("Passed must be false when state was expected and not applied: %+v", result)
	}
	found := false
	for _, f := range result.Failures {
		if strings.Contains(f, "system state not applied") {
			found = true
		}
	}
	if !found {
		t.Fatalf("failures = %v, want 'system state not applied'", result.Failures)
	}
}

// simpleInactiveProbe is a runServiceProbeCommand stand-in for the #5479
// tests: every unit reports inactive to `is-active`, and `systemctl show`
// answers from props (keyed by unit name), defaulting to an ordinary
// simple service whose conditions held — i.e. a genuine finding.
func simpleInactiveProbe(t *testing.T, props map[string]string) func(string, ...string) ([]byte, error) {
	t.Helper()
	return func(name string, args ...string) ([]byte, error) {
		if name != "systemctl" || len(args) == 0 {
			t.Fatalf("unexpected command: %s %v", name, args)
		}
		unit := args[len(args)-1]
		switch args[0] {
		case "is-active":
			return []byte("inactive\n"), errors.New("exit status 3")
		case "show":
			if out, ok := props[unit]; ok {
				return []byte(out), nil
			}
			return []byte("Type=simple\nActiveState=inactive\nSubState=dead\nConditionResult=yes\n"), nil
		default:
			t.Fatalf("unexpected command: %s %v", name, args)
			return nil, nil
		}
	}
}

// TestCheckServicesLinux_SkipsTemplateUnits proves the probe never reports a
// systemd TEMPLATE unit (getty@.service) as a finding — a template is not
// startable, so `is-active` on it is always inactive and naming it only
// buries real regressions (#5479). An actual INSTANCE (getty@tty1.service)
// is still probed and still fails.
func TestCheckServicesLinux_SkipsTemplateUnits(t *testing.T) {
	withGOOS(t, "linux")
	var probed []string
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		if args[0] == "is-active" {
			probed = append(probed, args[len(args)-1])
		}
		return simpleInactiveProbe(t, nil)(name, args...)
	})

	ok, inactive := checkServices([]string{"getty@.service", "user@.service", "getty@tty1.service"})
	if ok {
		t.Fatal("expected the real instance unit to fail the probe")
	}
	if len(inactive) != 1 || inactive[0] != "getty@tty1.service" {
		t.Fatalf("inactive = %v, want exactly [getty@tty1.service]", inactive)
	}
	if len(probed) != 1 || probed[0] != "getty@tty1.service" {
		t.Fatalf("is-active probed %v, want only the instance unit", probed)
	}
}

// TestCheckServicesLinux_OneshotExitedIsHealthy proves a completed oneshot
// unit (grub-common.service and friends, which rest at inactive/dead after
// running successfully) is not reported as a finding, while a FAILED
// oneshot still is (#5479).
func TestCheckServicesLinux_OneshotExitedIsHealthy(t *testing.T) {
	withGOOS(t, "linux")
	withServiceProbeCommand(t, simpleInactiveProbe(t, map[string]string{
		"grub-common.service":    "Type=oneshot\nActiveState=inactive\nSubState=dead\nConditionResult=yes\n",
		"e2scrub_reap.service":   "Type=oneshot\nActiveState=active\nSubState=exited\nConditionResult=yes\n",
		"broken-oneshot.service": "Type=oneshot\nActiveState=failed\nSubState=failed\nConditionResult=yes\n",
	}))

	ok, inactive := checkServices([]string{"grub-common.service", "e2scrub_reap.service", "broken-oneshot.service"})
	if ok {
		t.Fatal("expected the failed oneshot to fail the probe")
	}
	if len(inactive) != 1 || inactive[0] != "broken-oneshot.service" {
		t.Fatalf("inactive = %v, want exactly [broken-oneshot.service]", inactive)
	}
}

// TestCheckServicesLinux_ConditionNotMetIsHealthy proves a unit systemd
// deliberately skipped because its Condition*= checks did not hold is not a
// finding (#5479).
func TestCheckServicesLinux_ConditionNotMetIsHealthy(t *testing.T) {
	withGOOS(t, "linux")
	withServiceProbeCommand(t, simpleInactiveProbe(t, map[string]string{
		"dmesg.service": "Type=simple\nActiveState=inactive\nSubState=dead\nConditionResult=no\n",
	}))

	ok, inactive := checkServices([]string{"dmesg.service"})
	if !ok || len(inactive) != 0 {
		t.Fatalf("checkServices = (%v, %v), want (true, [])", ok, inactive)
	}
}

// TestCheckServicesLinux_ShowFailureStaysAFinding proves the escape hatch
// fails CLOSED: if `systemctl show` itself errors, the inactive unit is
// still reported rather than being assumed healthy (#5479).
func TestCheckServicesLinux_ShowFailureStaysAFinding(t *testing.T) {
	withGOOS(t, "linux")
	withServiceProbeCommand(t, func(name string, args ...string) ([]byte, error) {
		if args[0] == "show" {
			return nil, errors.New("exit status 1")
		}
		return []byte("inactive\n"), errors.New("exit status 3")
	})

	ok, inactive := checkServices([]string{"cron.service"})
	if ok || len(inactive) != 1 || inactive[0] != "cron.service" {
		t.Fatalf("checkServices = (%v, %v), want (false, [cron.service])", ok, inactive)
	}
}

// TestParseSystemctlShow_ValueContainingEquals proves only the first "=" is
// treated as the separator, so a property value that itself contains "="
// survives intact.
func TestParseSystemctlShow_ValueContainingEquals(t *testing.T) {
	props := parseSystemctlShow([]byte("Type=oneshot\nExecStart=/bin/sh -c x=1\nnotaproperty\n"))
	if props["Type"] != "oneshot" {
		t.Fatalf("Type = %q, want oneshot", props["Type"])
	}
	if props["ExecStart"] != "/bin/sh -c x=1" {
		t.Fatalf("ExecStart = %q", props["ExecStart"])
	}
	if _, ok := props["notaproperty"]; ok {
		t.Fatal("line without = must be ignored")
	}
}
