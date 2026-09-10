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
// and on macOS (no-op probe, see checkServices' default case).
func Validate(serviceUnits []string) (*ValidationResult, error) {
	result := &ValidationResult{Passed: true}

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

	slog.Info("bmr: validation complete",
		"passed", result.Passed,
		"networkUp", result.NetworkUp,
		"criticalFiles", result.CriticalFiles,
		"servicesRunning", result.ServicesRunning,
		"failures", len(result.Failures),
	)
	return result, nil
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

func checkServicesLinux(units []string) (bool, []string) {
	var inactive []string
	for _, unit := range units {
		out, err := runServiceProbeCommand("systemctl", "is-active", unit)
		state := strings.TrimSpace(string(out))
		if err != nil || state != "active" {
			inactive = append(inactive, unit)
			slog.Warn("bmr: service not active", "unit", unit, "state", state)
		}
	}
	return len(inactive) == 0, inactive
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

// enabledSystemdUnitsFromStaging reads the staged services/systemd.txt
// artifact (written by systemstate.LinuxCollector.collectServices as the
// raw output of `systemctl list-unit-files --type=service`,
// agent/internal/backup/systemstate/state_linux.go) and returns the unit
// names whose STATE column reads "enabled" — the same units restore_linux.go
// (a sibling wave's file, not touched here) enables during
// RestoreSystemState. Returns nil if the artifact wasn't staged (non-Linux
// platform, or a capture that skipped the services step).
func enabledSystemdUnitsFromStaging(stagingDir string) []string {
	data, err := os.ReadFile(filepath.Join(stagingDir, "services", "systemd.txt"))
	if err != nil {
		return nil
	}
	return parseSystemdEnabledUnits(data)
}

// parseSystemdEnabledUnits extracts unit names from the output of
// `systemctl list-unit-files --type=service`, keeping only units whose
// STATE column reads exactly "enabled".
//
// KNOWN DUPLICATION (intentional, see the plan doc's Wave 2 file list and
// Wave 5's reconciliation note): a sibling wave's restore_linux_logic.go
// independently adds a same-purpose `parseEnabledServices` helper to drive
// the actual service-restore step. This package cannot import or reuse that
// helper here without editing restore_linux.go, which is out of scope for
// this change (owned by that wave). The two parsers must be kept in sync on
// the parsing rule (STATE column == "enabled") until a follow-up
// consolidates them into one shared helper.
func parseSystemdEnabledUnits(data []byte) []string {
	var units []string
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		if fields[1] == "enabled" {
			units = append(units, fields[0])
		}
	}
	return units
}
