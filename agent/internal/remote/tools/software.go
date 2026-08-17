package tools

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"
)

type uninstallAttempt struct {
	command string
	args    []string
}

const (
	maxSoftwareNameLength    = 200
	maxSoftwareVersionLength = 100
)

var (
	invalidSoftwareNamePattern = regexp.MustCompile(`[\\/\x00\r\n']`)
	shellMetaPattern           = regexp.MustCompile("[;&|><`$'\"]")
	protectedLinuxPackageNames = map[string]struct{}{
		// Core OS
		"kernel":    {},
		"linux":     {},
		"systemd":   {},
		"glibc":     {},
		"libc6":     {},
		"coreutils": {},
		"bash":      {},
		"sudo":      {},
		"init":      {},
		// Package managers
		"apt":     {},
		"apt-get": {},
		"dpkg":    {},
		"rpm":     {},
		"yum":     {},
		"dnf":     {},
		"zypper":  {},
		"pacman":  {},
		// Bootloader
		"grub":         {},
		"grub2":        {},
		"grub-common":  {},
		"grub2-common": {},
		"grub-efi":     {},
		// Security-critical
		"openssl":        {},
		"openssh-server": {},
		"openssh-client": {},
		"libssl":         {},
		// Init/recovery
		"initramfs-tools": {},
		"dracut":          {},
		"systemd-sysv":    {},
	}
)

func validateSoftwareName(name string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return fmt.Errorf("software name is required")
	}
	if len(trimmed) > maxSoftwareNameLength {
		return fmt.Errorf("software name exceeds %d characters", maxSoftwareNameLength)
	}
	if strings.Contains(trimmed, "..") {
		return fmt.Errorf("software name contains invalid traversal sequence")
	}
	if strings.HasPrefix(trimmed, "-") {
		return fmt.Errorf("software name must not start with '-'")
	}
	if invalidSoftwareNamePattern.MatchString(trimmed) || shellMetaPattern.MatchString(trimmed) {
		return fmt.Errorf("software name contains unsafe characters")
	}
	return nil
}

// validWingetPackageIDPattern mirrors the agent's patching.validWingetPkgID and
// the API's softwareActions packageId regex: a winget identifier such as
// "Mozilla.Firefox". Empty is allowed (the field is optional).
var validWingetPackageIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

func validateSoftwarePackageID(packageID string) error {
	trimmed := strings.TrimSpace(packageID)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) > 256 {
		return fmt.Errorf("software packageId exceeds 256 characters")
	}
	if !validWingetPackageIDPattern.MatchString(trimmed) {
		return fmt.Errorf("software packageId contains unsafe characters")
	}
	return nil
}

func validateSoftwareVersion(version string) error {
	trimmed := strings.TrimSpace(version)
	if trimmed == "" {
		return nil
	}
	if len(trimmed) > maxSoftwareVersionLength {
		return fmt.Errorf("software version exceeds %d characters", maxSoftwareVersionLength)
	}
	if strings.HasPrefix(trimmed, "-") {
		return fmt.Errorf("software version must not start with '-'")
	}
	if strings.Contains(trimmed, "..") {
		return fmt.Errorf("software version contains invalid traversal sequence")
	}
	if invalidSoftwareNamePattern.MatchString(trimmed) || shellMetaPattern.MatchString(trimmed) {
		return fmt.Errorf("software version contains unsafe characters")
	}
	return nil
}

// UninstallSoftware removes software by name using platform-native uninstall methods.
func UninstallSoftware(payload map[string]any) CommandResult {
	startTime := time.Now()

	name := strings.TrimSpace(GetPayloadString(payload, "name", ""))
	version := strings.TrimSpace(GetPayloadString(payload, "version", ""))

	if err := validateSoftwareName(name); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}
	if err := validateSoftwareVersion(version); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	if err := uninstallSoftwareOS(name, version); err != nil {
		return NewErrorResult(err, time.Since(startTime).Milliseconds())
	}

	result := map[string]any{
		"name":    name,
		"version": version,
		"action":  "uninstall",
		"success": true,
	}

	return NewSuccessResult(result, time.Since(startTime).Milliseconds())
}

func uninstallSoftwareOS(name, version string) error {
	switch runtime.GOOS {
	case "windows":
		return uninstallSoftwareWindows(name, version)
	case "darwin":
		return uninstallSoftwareMacOS(name)
	case "linux":
		return uninstallSoftwareLinux(name)
	default:
		return fmt.Errorf("software uninstall unsupported on %s", runtime.GOOS)
	}
}

func uninstallSoftwareWindows(name, version string) error {
	// Resolve winget once for all attempts: under the SYSTEM service the
	// per-user "winget" PATH alias doesn't exist (see resolveWingetCommand).
	wingetCmd := resolveWingetCommand()
	attempts := []uninstallAttempt{
		{
			command: wingetCmd,
			args: []string{
				"uninstall",
				"--name", name,
				"--silent",
				"--accept-source-agreements",
				"--disable-interactivity",
			},
		},
		{
			command: "wmic",
			args: []string{
				"product",
				"where",
				fmt.Sprintf("name='%s'", name),
				"call",
				"uninstall",
				"/nointeractive",
			},
		},
	}

	if version != "" {
		attempts = append([]uninstallAttempt{
			{
				command: wingetCmd,
				args: []string{
					"uninstall",
					"--name", name,
					"--version", version,
					"--silent",
					"--accept-source-agreements",
					"--disable-interactivity",
				},
			},
		}, attempts...)
	}

	return runUninstallAttempts(name, attempts)
}

func safeMacOSApplicationPath(name string) (string, error) {
	baseName := strings.TrimSpace(strings.TrimSuffix(name, ".app"))
	if baseName == "" {
		return "", fmt.Errorf("software name is required")
	}
	if strings.Contains(baseName, "..") || strings.ContainsRune(baseName, '/') || strings.ContainsRune(baseName, '\\') {
		return "", fmt.Errorf("invalid application name")
	}

	appPath := filepath.Clean(filepath.Join("/Applications", baseName+".app"))
	if !strings.HasPrefix(appPath, "/Applications/") || appPath == "/Applications" {
		return "", fmt.Errorf("resolved application path is unsafe")
	}
	return appPath, nil
}

func uninstallSoftwareMacOS(name string) error {
	appPath, pathErr := safeMacOSApplicationPath(name)
	if pathErr != nil {
		return pathErr
	}

	var directRemoveErr error
	if info, statErr := os.Lstat(appPath); statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing to remove symlink at %s", appPath)
		}
		if removeErr := os.RemoveAll(appPath); removeErr == nil {
			return nil
		} else {
			directRemoveErr = fmt.Errorf("os.RemoveAll(%s): %w", appPath, removeErr)
		}
	}

	attempts := []uninstallAttempt{
		{command: "brew", args: []string{"uninstall", "--cask", name}},
		{command: "brew", args: []string{"uninstall", name}},
	}

	pkgErr := runUninstallAttempts(name, attempts)
	if pkgErr == nil {
		return nil
	}
	if directRemoveErr != nil {
		return fmt.Errorf("%w; also tried direct removal: %v", pkgErr, directRemoveErr)
	}
	return pkgErr
}

func isProtectedLinuxPackage(name string) bool {
	normalized := strings.ToLower(strings.TrimSpace(name))
	if normalized == "" {
		return false
	}
	if strings.HasPrefix(normalized, "kernel-") || strings.HasPrefix(normalized, "linux-image-") || strings.HasPrefix(normalized, "linux-headers-") {
		return true
	}

	normalized = strings.TrimPrefix(normalized, "linux-image-")
	normalized = strings.TrimPrefix(normalized, "linux-headers-")
	normalized = strings.TrimPrefix(normalized, "kernel-")
	if _, blocked := protectedLinuxPackageNames[normalized]; blocked {
		return true
	}

	// Guard common critical package prefixes.
	return strings.HasPrefix(normalized, "systemd") || strings.HasPrefix(normalized, "kernel")
}

func uninstallSoftwareLinux(name string) error {
	if isProtectedLinuxPackage(name) {
		return fmt.Errorf("refusing to uninstall protected package %q", name)
	}

	attempts := []uninstallAttempt{
		{command: "apt-get", args: []string{"remove", "-y", name}},
		{command: "dnf", args: []string{"remove", "-y", name}},
		{command: "yum", args: []string{"remove", "-y", name}},
		{command: "zypper", args: []string{"remove", "-y", name}},
		{command: "pacman", args: []string{"-R", "--noconfirm", name}},
	}

	return runUninstallAttempts(name, attempts)
}

// providerNotFoundMarkers are the phrases an uninstall provider emits when it
// has no record of the requested package. They mean "*this tool* cannot see it"
// — NOT "the package is absent from the device". winget in particular indexes
// only a subset of Add/Remove Programs, and under the SYSTEM service account it
// cannot see per-user installs at all, so it answers
// "No installed package found matching input criteria." for plenty of software
// that is very much installed (#3592).
var providerNotFoundMarkers = []string{
	"not installed",
	"no package",
	"no installed package",
	"unknown package",
	"not found",
	// wmic's no-match message. It is emitted with EXIT CODE 0, which is why the
	// marker check runs on the success path too.
	"no instance(s) available",
}

func providerReportedNotFound(lowerOutput string) bool {
	for _, marker := range providerNotFoundMarkers {
		if strings.Contains(lowerOutput, marker) {
			return true
		}
	}
	return false
}

// Seams for tests. uninstallVerifyStillPresent is the post-condition check; see
// software_uninstall_verify.go.
var (
	uninstallLookPath   = exec.LookPath
	runUninstallCommand = func(attempt uninstallAttempt) ([]byte, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		defer cancel()
		return exec.CommandContext(ctx, attempt.command, attempt.args...).CombinedOutput()
	}
	uninstallVerifyStillPresent = softwareStillInstalled
)

// runUninstallAttempts walks the platform's uninstall providers in order and
// then VERIFIES the post-condition before reporting success.
//
// The verification is the point of this function, not a belt-and-braces extra.
// Before #3592 two separate paths returned nil without any evidence of removal:
//
//  1. `err == nil` from the provider. `wmic product where name='X' call
//     uninstall` exits 0 even when the WHERE clause matches nothing, so the
//     fallback attempt reported success unconditionally.
//  2. A provider "not found" message short-circuited the whole operation as
//     "already absent". Because winget is the FIRST attempt on Windows, any
//     software winget does not index made Breeze answer
//     `{"action":"uninstall","success":true}` with exit code 0 while never
//     running the wmic fallback and never touching the machine.
//
// Both produced a device_commands row that says the uninstall succeeded, after
// which the next genuinely-fresh inventory scan legitimately re-reports the
// software — the "stale entry survives a fresh scan" symptom in #3592.
//
// A provider that cannot see the package no longer ends the operation; it falls
// through to the next provider, and the inventory re-check below decides the
// outcome. Verification failing (collector error) is not treated as proof of
// either state — we fall back to the provider signals in that case.
func runUninstallAttempts(softwareName string, attempts []uninstallAttempt) error {
	errors := make([]string, 0, len(attempts))
	attempted := 0
	providerClaimedRemoval := false
	providerNotFoundCount := 0

	for _, attempt := range attempts {
		if _, err := uninstallLookPath(attempt.command); err != nil {
			continue
		}

		attempted++
		output, err := runUninstallCommand(attempt)
		sanitizedOutput, outputTruncated := sanitizeUninstallOutput(string(output))
		lowerOutput := strings.ToLower(sanitizedOutput)

		// A zero exit code is not automatically a removal claim.
		// `wmic product where name='X' call uninstall` exits 0 and prints
		// "No Instance(s) Available." when the WHERE clause matches nothing, so
		// the no-match markers are checked here as well as on the failure path.
		// Otherwise that lie becomes the one signal still trusted when the
		// post-condition check is unavailable.
		if err == nil && !providerReportedNotFound(lowerOutput) {
			providerClaimedRemoval = true
			break
		}

		if providerReportedNotFound(lowerOutput) {
			providerNotFoundCount++
			continue
		}

		errLine := fmt.Sprintf("%s %v: %v (%s)", attempt.command, attempt.args, err, strings.TrimSpace(sanitizedOutput))
		if outputTruncated {
			errLine += " [output truncated]"
		}
		errors = append(errors, errLine)
	}

	if attempted == 0 {
		return fmt.Errorf("no supported uninstall command found on this endpoint for %q", softwareName)
	}

	joined, truncated := truncateStringBytes(strings.Join(errors, "; "), maxUninstallErrorBytes)
	if truncated {
		joined += " [error summary truncated]"
	}

	// Verification may only DOWNGRADE an unproven success to a failure. It must
	// never upgrade a hard provider error into a success, because "absent from
	// the inventory collector" is not always "absent from the device": the name
	// handed to an uninstall command does not always appear verbatim in the
	// collector's output (a brew cask token is "google-chrome" while
	// system_profiler reports "Google Chrome"). Letting a name the collector
	// simply cannot see convert a real apt/brew/msiexec failure into `nil` would
	// re-create the exact silent success this change exists to remove.
	if len(errors) > 0 && !providerClaimedRemoval {
		return fmt.Errorf("failed to uninstall %q after %d attempt(s): %s", softwareName, attempted, joined)
	}

	stillPresent, verifyErr := uninstallVerifyStillPresent(softwareName)
	if verifyErr != nil {
		// We could not look. A provider that actually exited 0 is still real
		// evidence something ran, so honour it. "No provider could even see the
		// package" is NOT evidence — accepting it here would restore the #3592
		// silent success behind a transient collector failure, which on macOS is
		// entirely reachable (a system_profiler hiccup during an uninstall of
		// software Homebrew does not manage).
		if providerClaimedRemoval {
			return nil
		}
		return fmt.Errorf("could not confirm %q was removed: no provider reported removing it (%d of %d attempted providers reported it as unknown) and this device's software inventory could not be read: %v", softwareName, providerNotFoundCount, attempted, verifyErr)
	}

	if !stillPresent {
		return nil
	}

	// Verified still installed — every "success" below this line would have been
	// a lie.
	if providerClaimedRemoval {
		return fmt.Errorf("uninstall command for %q reported success but it is still present in this device's software inventory (the uninstaller may have been silently blocked, or may require a reboot to finish)", softwareName)
	}
	return fmt.Errorf("no uninstall provider on this endpoint could locate %q (%d of %d attempted providers reported it as unknown), and it is still present in this device's software inventory", softwareName, providerNotFoundCount, attempted)
}
