package tools

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// updateAttempt mirrors uninstallAttempt — each is a single package-manager
// command to try in order; the first one whose binary is on PATH and whose
// invocation succeeds wins. Reused intentionally instead of introducing a
// parallel type so the runner code can stay shared.
type updateAttempt = uninstallAttempt

// UpdateSoftware upgrades a named package to the latest version available via
// the platform's native package manager. Like UninstallSoftware it accepts
// {name, version?} payload; version is currently only used by winget on
// Windows (passes through as --version target). On macOS and Linux version
// is ignored — package managers always upgrade to the newest available.
//
// This is intentionally NOT a download-arbitrary-payload path. Anything that
// can't be expressed as a package-manager upgrade (e.g. an app installed by
// dragging a .app into /Applications outside of brew) returns
// "no supported update command found".
func UpdateSoftware(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := strings.TrimSpace(GetPayloadString(payload, "name", ""))
	version := strings.TrimSpace(GetPayloadString(payload, "version", ""))

	if err := validateSoftwareName(name); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	if err := validateSoftwareVersion(version); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := updateSoftwareOS(name, version); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":    name,
		"version": version,
		"action":  "update",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func updateSoftwareOS(name, version string) error {
	switch runtime.GOOS {
	case "windows":
		return updateSoftwareWindows(name, version)
	case "darwin":
		return updateSoftwareMacOS(name)
	case "linux":
		return updateSoftwareLinux(name)
	default:
		return fmt.Errorf("software update unsupported on %s", runtime.GOOS)
	}
}

func updateSoftwareWindows(name, version string) error {
	// Two-tier match strategy mirrors uninstallSoftwareWindows: try
	// --name first (matches the human-readable name the user sees in
	// the Software tab), then --id as a fallback (winget's stable
	// identifier, used when the display name is ambiguous).
	attempts := []updateAttempt{
		{
			command: "winget",
			args: []string{
				"upgrade",
				"--name", name,
				"--silent",
				"--accept-source-agreements",
				"--accept-package-agreements",
				"--disable-interactivity",
			},
		},
		{
			command: "winget",
			args: []string{
				"upgrade",
				"--id", name,
				"--silent",
				"--accept-source-agreements",
				"--accept-package-agreements",
				"--disable-interactivity",
			},
		},
	}

	if version != "" {
		// When a target version is supplied, prepend version-pinned
		// variants. winget treats --version as "upgrade to this exact
		// version" — useful for compliance pinning.
		attempts = append([]updateAttempt{
			{
				command: "winget",
				args: []string{
					"upgrade",
					"--name", name,
					"--version", version,
					"--silent",
					"--accept-source-agreements",
					"--accept-package-agreements",
					"--disable-interactivity",
				},
			},
		}, attempts...)
	}

	return runUpdateAttempts(name, attempts)
}

func updateSoftwareMacOS(name string) error {
	// brew upgrade on a cask name fails with "No available formula" before
	// it tries the cask form, so try cask first. Plain formula second.
	attempts := []updateAttempt{
		{command: "brew", args: []string{"upgrade", "--cask", name}},
		{command: "brew", args: []string{"upgrade", name}},
	}

	return runUpdateAttempts(name, attempts)
}

func updateSoftwareLinux(name string) error {
	// Reuse the protected-package guard from uninstall: upgrading
	// systemd/glibc/kernel through this path is just as risky as
	// removing them, and the typical breakage (interrupted boot,
	// broken libc) requires physical hands.
	if isProtectedLinuxPackage(name) {
		return fmt.Errorf("refusing to update protected package %q", name)
	}

	attempts := []updateAttempt{
		// apt-get install --only-upgrade is the documented way to bump
		// a single package; plain `upgrade` is whole-system.
		{command: "apt-get", args: []string{"install", "--only-upgrade", "-y", name}},
		{command: "dnf", args: []string{"upgrade", "-y", name}},
		{command: "yum", args: []string{"update", "-y", name}},
		{command: "zypper", args: []string{"update", "-y", name}},
		// pacman -S is the upgrade-or-install verb on Arch.
		{command: "pacman", args: []string{"-S", "--noconfirm", name}},
	}

	return runUpdateAttempts(name, attempts)
}

func runUpdateAttempts(softwareName string, attempts []updateAttempt) error {
	errors := make([]string, 0, len(attempts))
	attempted := 0

	for _, attempt := range attempts {
		if _, err := exec.LookPath(attempt.command); err != nil {
			continue
		}

		attempted++
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		cmd := exec.CommandContext(ctx, attempt.command, attempt.args...)
		output, err := cmd.CombinedOutput()
		cancel()
		sanitizedOutput, outputTruncated := sanitizeUninstallOutput(string(output))
		lowerOutput := strings.ToLower(sanitizedOutput)

		if err == nil {
			return nil
		}

		// "no updates available" / "already up to date" / "no upgrade
		// candidate" are all success-equivalents — the package is at
		// the requested version. Map to nil so callers see the same
		// path as an actual upgrade.
		if strings.Contains(lowerOutput, "no available upgrade") ||
			strings.Contains(lowerOutput, "no applicable update") ||
			strings.Contains(lowerOutput, "no updates available") ||
			strings.Contains(lowerOutput, "already up to date") ||
			strings.Contains(lowerOutput, "already up-to-date") ||
			strings.Contains(lowerOutput, "is already the newest version") ||
			strings.Contains(lowerOutput, "nothing to do") ||
			strings.Contains(lowerOutput, "no packages marked for update") {
			return nil
		}

		errLine := fmt.Sprintf("%s %v: %v (%s)", attempt.command, attempt.args, err, strings.TrimSpace(sanitizedOutput))
		if outputTruncated {
			errLine += " [output truncated]"
		}
		errors = append(errors, errLine)
	}

	if attempted == 0 {
		return fmt.Errorf("no supported update command found on this endpoint for %q", softwareName)
	}

	joined, truncated := truncateStringBytes(strings.Join(errors, "; "), maxUninstallErrorBytes)
	if truncated {
		joined += " [error summary truncated]"
	}
	return fmt.Errorf("failed to update %q after %d attempt(s): %s", softwareName, attempted, joined)
}
