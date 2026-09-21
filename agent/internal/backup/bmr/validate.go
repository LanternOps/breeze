package bmr

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// goos defaults to runtime.GOOS; tests override it to exercise a specific
// platform's checkServices branch without needing to run on that real OS.
var goos = runtime.GOOS

// runServiceProbeCommand executes an external service-status command
// (systemctl on Linux, sc on Windows) and returns its combined output. A
// package-level var — like chmodFile/chtimesFile (bmr.go) and runCommand in
// sibling wave's restore_linux.go — so tests can substitute a fake instead
// of shelling out to a real systemctl/sc binary that may not exist (or may
// behave unpredictably) on the test host.
var runServiceProbeCommand = func(name string, args ...string) ([]byte, error) {
	return exec.Command(name, args...).CombinedOutput()
}

// windowsCriticalServices is the fixed set of Windows service names a BMR
// validation checks are running. Windows BMR does not (yet) stage a
// services artifact the way Linux's systemd unit list does (see the plan
// doc, §3/§5 Wave 3-4), so there is no per-run "units this restore enabled"
// list to check against — a fixed, always-critical set stands in instead.
var windowsCriticalServices = []string{
	"EventLog",
	"Winmgmt",
	"LanmanServer",
	"Dhcp",
	"Dnscache",
	"MpsSvc",
}

// Validate performs post-restore checks to verify the system is in a
// working state after BMR. It checks network connectivity, critical file
// existence, and key services.
//
// serviceUnits is the list of systemd unit names the Linux restorer staged
// for this run (see applySystemState's enabledSystemdUnitsFromStaging,
// bmr.go) — ignored on Windows (a fixed critical set is checked instead)
// and on macOS (no-op probe, see checkServices' default case). serviceUnitsErr
// is applySystemState's error (if any) from reading that staged list — see
// applyServiceValidation's doc comment for why this must fail validation
// outright rather than being treated the same as "no services staged".
// state is the system-state phase's outcome; an expected-but-unapplied
// state fails the verdict with a named check (#5412).
func Validate(serviceUnits []string, serviceUnitsErr error, state SystemStateOutcome) (*ValidationResult, error) {
	result := &ValidationResult{Passed: true}

	// System state expected by the bootstrap must actually have landed.
	applySystemStateValidation(result, state)

	// Check network connectivity.
	result.NetworkUp = checkNetwork()
	if !result.NetworkUp {
		result.Passed = false
		result.Failures = append(result.Failures, "network connectivity check failed")
	}

	// Check critical files exist.
	result.CriticalFiles = checkCriticalFiles()
	if !result.CriticalFiles {
		result.Passed = false
		result.Failures = append(result.Failures, "one or more critical system files are missing")
	}

	// Check key services.
	applyServiceValidation(result, serviceUnits, serviceUnitsErr)

	slog.Info("bmr: validation complete",
		"passed", result.Passed,
		"networkUp", result.NetworkUp,
		"criticalFiles", result.CriticalFiles,
		"servicesRunning", result.ServicesRunning,
		"systemStateApplied", result.SystemStateApplied,
		"failures", len(result.Failures),
	)
	return result, nil
}

// applySystemStateValidation records the system-state outcome into result
// and fails the verdict when state was expected but not applied. Split out
// (like applyServiceValidation) so it is unit-testable without Validate's
// real network dial and OS file probes. A manifest that was found but not
// applied without being expected does not fail here: RunRecoveryContext's
// status derivation already keeps such a run off "completed" (see
// stateBlocksCompletion), and validation stays about what the bootstrap
// promised.
func applySystemStateValidation(result *ValidationResult, state SystemStateOutcome) {
	result.SystemStateApplied = state.Applied
	if state.Expected && !state.Applied {
		result.Passed = false
		if state.ManifestFound {
			result.Failures = append(result.Failures, "system state not applied: manifest was found but its artifacts were not applied")
		} else {
			result.Failures = append(result.Failures, "system state not applied: snapshot advertises system state but no manifest was found")
		}
	}
}

// checkNetwork tests basic network connectivity by trying to resolve
// and dial a well-known host.
func checkNetwork() bool {
	conn, err := net.DialTimeout("tcp", "dns.google:443", 5*time.Second)
	if err != nil {
		slog.Warn("bmr: network check failed", "error", err.Error())
		return false
	}
	_ = conn.Close()
	return true
}

// checkCriticalFiles verifies OS-specific critical files exist.
func checkCriticalFiles() bool {
	var paths []string
	switch runtime.GOOS {
	case "windows":
		paths = []string{
			`C:\Windows\System32\config\SYSTEM`,
			`C:\Windows\System32\config\SOFTWARE`,
			`C:\Windows\System32\ntoskrnl.exe`,
			`C:\Windows\System32\drivers\etc\hosts`,
		}
	case "darwin":
		paths = []string{
			"/System/Library/CoreServices/SystemVersion.plist",
			"/etc/hosts",
			"/Library/Preferences",
		}
	default: // linux
		paths = []string{
			"/etc/os-release",
			"/etc/passwd",
			"/etc/hosts",
			"/etc/fstab",
		}
	}

	allPresent := true
	for _, p := range paths {
		if _, err := os.Stat(p); os.IsNotExist(err) {
			slog.Warn("bmr: critical file missing", "path", p)
			allPresent = false
		}
	}
	return allPresent
}

// checkServices probes whether critical services are active, dispatched by
// platform (via the overridable `goos` var, not runtime.GOOS directly, so
// tests can exercise every branch from one dev machine):
//
//   - linux: `systemctl is-active <unit>` for each of serviceUnits — the
//     units this run's Linux restorer staged (see Validate's doc comment).
//     No known units (serviceUnits empty — e.g. no services/systemd.txt was
//     staged, an older/partial capture) trivially passes: this run never
//     claimed to restore any services, so there is nothing to fail on.
//   - windows: `sc query <name>` over windowsCriticalServices, regardless
//     of serviceUnits (Windows BMR has no per-run service list yet).
//   - darwin (and anything else): no-op, always passes — matches
//     restore_darwin.go, which has no service-restore step to validate.
//
// Returns (allRunning, namesThatFailed) so Validate can name the specific
// services in ValidationResult.Failures instead of the old always-true stub's
// unconditional pass (validate.go's checkServices could never drag
// ValidationResult.Passed down — a stopped service after BMR was invisible
// to validation, campaign finding B1b).
func checkServices(serviceUnits []string) (bool, []string) {
	switch goos {
	case "linux":
		return checkServicesLinux(serviceUnits)
	case "windows":
		return checkServicesWindows()
	default:
		return true, nil
	}
}

// applyServiceValidation runs the service-health portion of Validate and
// records the outcome into result. Split out from Validate itself so it can
// be unit-tested directly, without also exercising Validate's real network
// dial (checkNetwork) and OS file checks (checkCriticalFiles).
//
// serviceUnitsErr, if non-nil, means applySystemState (bmr.go) could not
// even determine which services this run was supposed to restore — e.g. a
// permission error reading the staged services/systemd.txt artifact, as
// opposed to that artifact simply not existing (enabledSystemdUnitsFromStaging
// maps a not-exist error to (nil, nil), the ordinary "nothing staged"
// case). That is NOT the same as "no services to check" and must not
// silently pass validation the way an empty serviceUnits list does —
// otherwise a corrupted/unreadable service list would validate as if
// nothing needed restoring at all.
func applyServiceValidation(result *ValidationResult, serviceUnits []string, serviceUnitsErr error) {
	if serviceUnitsErr != nil {
		result.ServicesRunning = false
		result.Passed = false
		result.Failures = append(result.Failures, fmt.Sprintf("could not determine restored services: %s", serviceUnitsErr.Error()))
		return
	}

	servicesRunning, inactive := checkServices(serviceUnits)
	result.ServicesRunning = servicesRunning
	if !servicesRunning {
		result.Passed = false
		if len(inactive) > 0 {
			result.Failures = append(result.Failures, fmt.Sprintf("services not running: %s", strings.Join(inactive, ", ")))
		} else {
			result.Failures = append(result.Failures, "one or more critical services are not running")
		}
	}
}

func checkServicesLinux(units []string) (bool, []string) {
	var inactive []string
	for _, unit := range units {
		if isTemplateUnit(unit) {
			// A template unit (getty@.service) is not itself startable —
			// only its instances are — so `is-active` on it always reports
			// inactive. Probing one can never signal a real regression, it
			// only buries the ones that can (#5479).
			slog.Debug("bmr: skipping template unit in service probe", "unit", unit)
			continue
		}
		out, err := runServiceProbeCommand("systemctl", "is-active", unit)
		state := strings.TrimSpace(string(out))
		if err == nil && state == "active" {
			continue
		}
		if healthy, reason := inactiveUnitIsHealthy(unit); healthy {
			slog.Debug("bmr: unit not active but healthy", "unit", unit, "state", state, "reason", reason)
			continue
		}
		inactive = append(inactive, unit)
		slog.Warn("bmr: service not active", "unit", unit, "state", state)
	}
	return len(inactive) == 0, inactive
}

// isTemplateUnit reports whether name is a systemd TEMPLATE unit — an
// instance-less name whose prefix ends in "@", e.g. "getty@.service" or
// "user@.service". `systemctl list-unit-files` lists these alongside
// ordinary units, so they reach the probe through
// parseSystemdEnabledUnits, but they describe how to build instances
// rather than naming a runnable service. An actual instance
// ("getty@tty1.service") has text between the "@" and the ".", so it is
// NOT a template and is still probed normally.
func isTemplateUnit(name string) bool {
	base := name
	if idx := strings.LastIndex(base, "."); idx >= 0 {
		base = base[:idx]
	}
	return strings.HasSuffix(base, "@")
}

// unitProbeProperties are the systemd properties inactiveUnitIsHealthy
// inspects for a unit that `is-active` did not report as "active". Kept as
// one ordered slice so the command and the parse stay in step.
var unitProbeProperties = []string{"Type", "ActiveState", "SubState", "ConditionResult", "UnitFileState"}

// healthyUnitFileStates are the `systemctl show -p UnitFileState` values
// that mean a unit is still installed and wanted after the restore. A unit
// that is "disabled", "masked", "bad" or absent entirely (UnitFileState
// empty / not-found) is NOT healthy no matter why it is inactive: the
// snapshot listed it as enabled, so losing that enablement is exactly the
// regression this probe exists to catch. "static"/"indirect"/"generated"
// units have no enablement of their own to lose.
var healthyUnitFileStates = map[string]bool{
	"enabled":         true,
	"enabled-runtime": true,
	"static":          true,
	"indirect":        true,
	"generated":       true,
	"transient":       true,
	"alias":           true,
}

// inactiveUnitIsHealthy decides whether a unit that `systemctl is-active`
// did not call "active" is nonetheless in an expected state for a healthy
// system, and returns a short reason when it is (#5479). Two cases:
//
//   - a oneshot unit at rest: `Type=oneshot` with ActiveState
//     inactive/active and SubState anything but "failed". Without
//     RemainAfterExit, systemd drops such a unit back to "inactive" the
//     moment its command exits successfully — the normal resting state of
//     e2scrub_reap.service, dmesg.service, grub-common.service and
//     friends. Note this deliberately does NOT try to distinguish "ran and
//     exited 0" from "has not run yet": the probe runs straight after a
//     restore, typically before the machine has had a boot for its oneshots
//     to run in, so "has not run yet" is the expected state there rather
//     than a regression. The axis that DOES carry signal for a oneshot is
//     enablement, which is why both branches below require a healthy
//     UnitFileState — a oneshot the restore left disabled, masked or
//     missing is still reported.
//   - a unit systemd deliberately skipped because its Condition*= checks
//     did not hold (`ConditionResult=no`) — e.g. a unit gated on hardware
//     or a file the recovered machine does not have. Also gated on a
//     healthy UnitFileState.
//
// Anything else — a failed unit, an activating/deactivating one, a unit
// left disabled/masked/missing by the restore, or a `systemctl show` that
// errors out — stays a genuine finding.
func inactiveUnitIsHealthy(unit string) (bool, string) {
	args := []string{"show"}
	for _, prop := range unitProbeProperties {
		args = append(args, "--property="+prop)
	}
	args = append(args, unit)

	out, err := runServiceProbeCommand("systemctl", args...)
	if err != nil {
		return false, ""
	}
	props := parseSystemctlShow(out)
	if !healthyUnitFileStates[props["UnitFileState"]] {
		return false, ""
	}
	if props["ConditionResult"] == "no" {
		return true, "condition not met"
	}
	if props["Type"] == "oneshot" && props["SubState"] != "failed" &&
		(props["ActiveState"] == "inactive" || props["ActiveState"] == "active") {
		return true, "oneshot at rest"
	}
	return false, ""
}

// parseSystemctlShow turns `systemctl show --property=X ...` output
// (KEY=VALUE, one per line) into a map. Values may legitimately contain
// "=", so only the FIRST "=" separates key from value; lines without one
// are ignored.
func parseSystemctlShow(out []byte) map[string]string {
	props := make(map[string]string)
	for _, line := range strings.Split(string(out), "\n") {
		key, value, found := strings.Cut(strings.TrimSpace(line), "=")
		if !found || key == "" {
			continue
		}
		props[key] = value
	}
	return props
}

func checkServicesWindows() (bool, []string) {
	var inactive []string
	for _, svc := range windowsCriticalServices {
		out, err := runServiceProbeCommand("sc", "query", svc)
		if err != nil || !strings.Contains(strings.ToUpper(string(out)), "RUNNING") {
			inactive = append(inactive, svc)
			slog.Warn("bmr: service not running", "service", svc)
		}
	}
	return len(inactive) == 0, inactive
}

// readServicesArtifact is a seam over os.ReadFile so tests can inject a
// deterministic non-not-exist read failure (e.g. simulating EACCES)
// without depending on filesystem permission behavior that a root-running
// test process would bypass.
var readServicesArtifact = os.ReadFile

// enabledSystemdUnitsFromStaging reads the staged services/systemd.txt
// artifact (written by systemstate.LinuxCollector.collectServices as the
// raw output of `systemctl list-unit-files --type=service`,
// agent/internal/backup/systemstate/state_linux.go) and returns the unit
// names whose STATE column reads "enabled" — the same units restore_linux.go
// (a sibling wave's file, not touched here) enables during
// RestoreSystemState.
//
// Returns (nil, nil) if the artifact simply wasn't staged (os.IsNotExist —
// non-Linux platform, or a capture that skipped the services step): that is
// the ordinary "nothing to check" case. Any OTHER read error (permission
// denied, I/O error, ...) is returned as-is rather than being swallowed the
// same way — the caller (applySystemState, bmr.go) threads it through to
// Validate's applyServiceValidation, which must fail validation outright
// rather than silently treating "couldn't tell what to check" the same as
// "nothing needs checking".
func enabledSystemdUnitsFromStaging(stagingDir string) ([]string, error) {
	data, err := readServicesArtifact(filepath.Join(stagingDir, "services", "systemd.txt"))
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read staged services list: %w", err)
	}
	return parseSystemdEnabledUnits(data), nil
}
