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
	// packageId is the winget identifier (e.g. "Mozilla.Firefox"). When the
	// Software tab has correlated the row to an available third-party update it
	// sends this so we can upgrade by `--id` — far more reliable than guessing
	// from the registry display name. Optional and Windows-only.
	packageID := strings.TrimSpace(GetPayloadString(payload, "packageId", ""))

	if err := validateSoftwareName(name); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	if err := validateSoftwareVersion(version); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	if err := validateSoftwarePackageID(packageID); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := updateSoftwareOS(name, version, packageID); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":      name,
		"version":   version,
		"packageId": packageID,
		"action":    "update",
		"success":   true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func updateSoftwareOS(name, version, packageID string) error {
	switch runtime.GOOS {
	case "windows":
		return updateSoftwareWindows(name, version, packageID)
	case "darwin":
		return updateSoftwareMacOS(name)
	case "linux":
		return updateSoftwareLinux(name)
	default:
		return fmt.Errorf("software update unsupported on %s", runtime.GOOS)
	}
}

func updateSoftwareWindows(name, version, packageID string) error {
	return runUpdateAttempts(name, buildWindowsUpdateAttempts(name, version, packageID))
}

// wingetUpgradeAttempt builds a single `winget upgrade` attempt selecting the
// package by the given flag (--name or --id), optionally version-pinned.
func wingetUpgradeAttempt(selector, value, version string) updateAttempt {
	args := []string{"upgrade", selector, value}
	if version != "" {
		args = append(args, "--version", version)
	}
	args = append(args,
		"--silent",
		"--accept-source-agreements",
		"--accept-package-agreements",
		"--disable-interactivity",
	)
	return updateAttempt{command: "winget", args: args}
}

// buildWindowsUpdateAttempts returns the ordered list of winget attempts.
// Ordering is significant — the first attempt whose binary is present and whose
// invocation succeeds wins (see runUpdateAttempts):
//
//  1. --id <packageID>  (when a known winget Id is supplied) — the most reliable
//     selector, so it's tried first ahead of the display-name heuristics.
//  2. --name <name>     (the human-readable name from the Software tab)
//  3. --id <name>       (display name as a fallback id, for ambiguous names)
//
// A version-pinned variant is prepended within each tier when a target version
// is supplied (winget treats --version as "upgrade to this exact version").
func buildWindowsUpdateAttempts(name, version, packageID string) []updateAttempt {
	var attempts []updateAttempt

	if packageID != "" {
		if version != "" {
			attempts = append(attempts, wingetUpgradeAttempt("--id", packageID, version))
		}
		attempts = append(attempts, wingetUpgradeAttempt("--id", packageID, ""))
	}

	if version != "" {
		attempts = append(attempts, wingetUpgradeAttempt("--name", name, version))
	}
	attempts = append(attempts,
		wingetUpgradeAttempt("--name", name, ""),
		wingetUpgradeAttempt("--id", name, ""),
	)

	return attempts
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
