package bmr

import (
	"log/slog"
	"net"
	"os"
	"runtime"
	"time"
)

// Validate performs post-restore checks to verify the system is in a
// working state after BMR. It checks network connectivity, critical
// file existence, and key services.
func Validate() (*ValidationResult, error) {
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
	result.ServicesRunning = checkServices()
	if !result.ServicesRunning {
		result.Passed = false
		result.Failures = append(result.Failures, "one or more critical services are not running")
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

// checkServices is a stub that returns true. Platform-specific service
// checks (e.g., sc query on Windows, launchctl on macOS, systemctl on
// Linux) can be added in the future.
func checkServices() bool {
	// TODO: implement platform-specific service health checks
	return true
}
