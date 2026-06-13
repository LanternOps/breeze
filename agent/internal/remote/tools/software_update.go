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

// UpdateSoftware upgrades a named package via the platform's native package
// manager. Like UninstallSoftware it accepts {name, version?} payload.
//
// Version pinning (a non-empty version) is treated as a control/compliance
// constraint, not a hint: every platform either honors the exact version or
// fails loudly. It is never silently dropped (the bug in #993):
//
//   - Windows: winget `--version <v>` (already supported).
//   - Linux:   package managers that accept an exact-version selector
//     (apt `pkg=ver`, dnf/yum `pkg-ver`, zypper `pkg=ver`) honor the pin,
//     including downgrades to an OLDER pinned build (apt `--allow-downgrades`,
//     dnf/yum `downgrade`, zypper `--oldpackage`). After the attempt the
//     installed version is re-queried (dpkg-query/rpm) and the pin is rejected
//     loudly unless it actually matches — apt/dnf/yum report success-equivalents
//     like "already the newest version" when the pin is older, so the attempt
//     succeeding is not proof the pin held (#993). Managers that cannot install
//     an arbitrary repo version (pacman) are excluded from a pinned upgrade, and
//     if no version-capable manager is present the attempt fails with "no
//     supported update command".
//   - macOS:   Homebrew cannot upgrade a cask/formula to an arbitrary prior
//     version, so a pinned macOS update is rejected up front with an explicit
//     "version pinning unsupported" error rather than silently jumping to the
//     newest available.
//
// When no version is supplied behavior is unchanged: upgrade to the newest
// available on every platform.
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
		return updateSoftwareMacOS(name, version)
	case "linux":
		return updateSoftwareLinux(name, version)
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

// errMacOSVersionPinUnsupported is returned when a macOS update is asked to pin
// an exact version. Homebrew has no first-class "upgrade to this specific prior
// version" command for casks/formulae (`brew upgrade` always targets the latest
// available), so honoring the pin is not possible. Failing loudly is preferable
// to silently upgrading past the requested version (#993).
var errMacOSVersionPinUnsupported = fmt.Errorf(
	"version pinning is not supported for software updates on macOS (Homebrew always upgrades to the latest available); " +
		"omit the version to upgrade to latest")

func updateSoftwareMacOS(name, version string) error {
	if version != "" {
		return errMacOSVersionPinUnsupported
	}

	// brew upgrade on a cask name fails with "No available formula" before
	// it tries the cask form, so try cask first. Plain formula second.
	attempts := []updateAttempt{
		{command: "brew", args: []string{"upgrade", "--cask", name}},
		{command: "brew", args: []string{"upgrade", name}},
	}

	return runUpdateAttempts(name, attempts)
}

func updateSoftwareLinux(name, version string) error {
	// Reuse the protected-package guard from uninstall: upgrading
	// systemd/glibc/kernel through this path is just as risky as
	// removing them, and the typical breakage (interrupted boot,
	// broken libc) requires physical hands.
	if isProtectedLinuxPackage(name) {
		return fmt.Errorf("refusing to update protected package %q", name)
	}

	if err := runUpdateAttempts(name, buildLinuxUpdateAttempts(name, version)); err != nil {
		return err
	}

	// A pin is a control constraint: the attempt "succeeding" is not enough,
	// because apt/dnf/yum emit "is already the newest version" / "nothing to
	// do" when the pin is OLDER than what's installed — and runUpdateAttempts
	// maps those success-equivalents to nil. Without this post-check the pin
	// would be silently dropped, which is the exact #993 bug class on Linux.
	// So when a version is pinned we VERIFY the installed version matches and
	// fail loudly otherwise. No pin → nothing to verify.
	if version != "" {
		return verifyLinuxPinnedVersion(name, version, queryInstalledLinuxVersion)
	}
	return nil
}

// buildLinuxUpdateAttempts returns the ordered package-manager attempts for a
// Linux update. The first whose binary is present and whose invocation succeeds
// wins (see runUpdateAttempts).
//
// Without a version pin every manager upgrades to the newest available, as
// before. With a version pin we switch to each manager's exact-version selector
// so the pin is actually honored rather than silently ignored (#993). Crucially,
// the pin can be OLDER than the installed build (an intentional downgrade/hold),
// which the plain upgrade/update verbs CANNOT perform, so each manager also gets
// an explicit downgrade-capable attempt:
//
//   - apt-get: `install --only-upgrade pkg=version`, then
//     `install --allow-downgrades pkg=version` (the latter forces a downgrade to
//     the pinned version when a newer build is installed).
//   - dnf:     `upgrade pkg-version`, then `downgrade pkg-version`.
//   - yum:     `update pkg-version`, then `downgrade pkg-version`.
//   - zypper:  `install --oldpackage pkg=version` (--oldpackage already permits a
//     downgrade to the pinned version in one shot).
//
// pacman is intentionally omitted from a pinned upgrade: it can only install the
// single version currently in the synced repos, so it cannot honor an arbitrary
// pin. When a version is requested and none of the version-capable managers are
// present, runUpdateAttempts reports "no supported update command" — a loud
// failure, never a silent upgrade to latest. (And even when an attempt reports
// success, updateSoftwareLinux re-verifies the installed version — see #993.)
func buildLinuxUpdateAttempts(name, version string) []updateAttempt {
	if version != "" {
		aptTarget := name + "=" + version
		rpmTarget := name + "-" + version
		zypperTarget := name + "=" + version
		return []updateAttempt{
			// Upgrade path (pin newer-than or equal-to installed) first, then the
			// downgrade path (pin older-than installed). runUpdateAttempts tries
			// each in order until one succeeds; the upgrade verb is a clean no-op
			// when a downgrade is needed, so the downgrade attempt follows it.
			{command: "apt-get", args: []string{"install", "--only-upgrade", "-y", aptTarget}},
			{command: "apt-get", args: []string{"install", "--allow-downgrades", "-y", aptTarget}},
			{command: "dnf", args: []string{"upgrade", "-y", rpmTarget}},
			{command: "dnf", args: []string{"downgrade", "-y", rpmTarget}},
			{command: "yum", args: []string{"update", "-y", rpmTarget}},
			{command: "yum", args: []string{"downgrade", "-y", rpmTarget}},
			// zypper --oldpackage handles both directions in a single invocation.
			{command: "zypper", args: []string{"install", "-y", "--oldpackage", zypperTarget}},
		}
	}

	return []updateAttempt{
		// apt-get install --only-upgrade is the documented way to bump
		// a single package; plain `upgrade` is whole-system.
		{command: "apt-get", args: []string{"install", "--only-upgrade", "-y", name}},
		{command: "dnf", args: []string{"upgrade", "-y", name}},
		{command: "yum", args: []string{"update", "-y", name}},
		{command: "zypper", args: []string{"update", "-y", name}},
		// pacman -S is the upgrade-or-install verb on Arch.
		{command: "pacman", args: []string{"-S", "--noconfirm", name}},
	}
}

// linuxVersionQuery resolves the currently-installed version of a package via the
// native package database (dpkg-query / rpm). Injected so the verification path
// can be table-tested without a real package manager. Returns ("", nil) when the
// package isn't found by any available tool, and a non-nil error only on an
// unexpected tool failure.
type linuxVersionQuery func(name string) (string, error)

// verifyLinuxPinnedVersion confirms the installed version of name satisfies the
// pinned version. The promise from #993 — "honored exactly or fails loudly,
// never silently dropped" — only holds on Linux because of this check: the
// package manager can report success (or a success-equivalent like "already the
// newest version") while the installed version is NOT the pin.
//
// We can't query the installed version (no dpkg/rpm), so we cannot prove the pin
// held — fail loudly rather than assume success.
func verifyLinuxPinnedVersion(name, version string, query linuxVersionQuery) error {
	installed, err := query(name)
	if err != nil {
		return fmt.Errorf("updated %q but could not verify it now reports pinned version %q: %v", name, version, err)
	}
	if installed == "" {
		return fmt.Errorf("updated %q but could not determine its installed version to confirm the pin %q held", name, version)
	}
	if !installedVersionMatchesPin(installed, version) {
		return fmt.Errorf("version pin not honored for %q: requested %q but %q is installed", name, version, installed)
	}
	return nil
}

// installedVersionMatchesPin reports whether the installed version string
// satisfies the requested pin. Package managers decorate the version we asked
// for — apt prefixes an epoch ("1:131.0"), rpm appends a release ("131.0-1.fc39")
// — so an exact string compare would produce false "pin not honored" failures.
// We accept the pin as an exact match, or as the version component once the apt
// epoch and rpm release are stripped from the installed string.
func installedVersionMatchesPin(installed, pin string) bool {
	installed = strings.TrimSpace(installed)
	pin = strings.TrimSpace(pin)
	if installed == pin {
		return true
	}
	normalized := installed
	// Strip a leading apt/dpkg epoch ("1:131.0" -> "131.0").
	if idx := strings.Index(normalized, ":"); idx >= 0 {
		normalized = normalized[idx+1:]
	}
	if normalized == pin {
		return true
	}
	// If the pin itself carries a release ("131.0-1"), the above covers it.
	// Otherwise strip the rpm release suffix ("131.0-1.fc39" -> "131.0") only
	// when the pin has no release of its own, so a release-bearing pin still
	// requires an exact (epoch-stripped) match.
	if !strings.Contains(pin, "-") {
		if idx := strings.Index(normalized, "-"); idx >= 0 {
			normalized = normalized[:idx]
		}
		if normalized == pin {
			return true
		}
	}
	return false
}

// queryInstalledLinuxVersion looks up the installed version of a package using
// dpkg-query (Debian/Ubuntu) first, then rpm (RHEL/Fedora/SUSE). Returns
// ("", nil) when neither tool is present or the package isn't installed.
func queryInstalledLinuxVersion(name string) (string, error) {
	if _, err := exec.LookPath("dpkg-query"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		out, err := exec.CommandContext(ctx, "dpkg-query", "-W", "-f=${Version}", name).Output()
		cancel()
		if err == nil {
			if v := strings.TrimSpace(string(out)); v != "" {
				return v, nil
			}
		}
	}

	if _, err := exec.LookPath("rpm"); err == nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		out, err := exec.CommandContext(ctx, "rpm", "-q", "--queryformat", "%{VERSION}-%{RELEASE}", name).Output()
		cancel()
		if err == nil {
			v := strings.TrimSpace(string(out))
			// rpm -q on a missing package exits non-zero (caught above) but be
			// defensive against the "package X is not installed" text on stdout.
			if v != "" && !strings.Contains(strings.ToLower(v), "not installed") {
				return v, nil
			}
		}
	}

	return "", nil
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
