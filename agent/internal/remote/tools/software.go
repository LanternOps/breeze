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
	maxSoftwareNameLength = 200
)

var (
	invalidSoftwareNamePattern = regexp.MustCompile(`[\\/\x00\r\n']`)
	shellMetaPattern           = regexp.MustCompile("[;&|><`$'\"]")
	protectedLinuxPackageNames = map[string]struct{}{
		"kernel":    {},
		"linux":     {},
		"systemd":   {},
		"glibc":     {},
		"libc6":     {},
		"coreutils": {},
		"bash":      {},
		"sudo":      {},
		"init":      {},
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
	if invalidSoftwareNamePattern.MatchString(trimmed) || shellMetaPattern.MatchString(trimmed) {
		return fmt.Errorf("software name contains unsafe characters")
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
	attempts := []uninstallAttempt{
		{
			command: "winget",
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
				command: "winget",
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
	if _, statErr := os.Stat(appPath); statErr == nil {
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

func runUninstallAttempts(softwareName string, attempts []uninstallAttempt) error {
	errors := make([]string, 0, len(attempts))
	attempted := 0

	for _, attempt := range attempts {
		if _, err := exec.LookPath(attempt.command); err != nil {
			continue
		}

		attempted++
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
		cmd := exec.CommandContext(ctx, attempt.command, attempt.args...)
		output, err := cmd.CombinedOutput()
		cancel()
		lowerOutput := strings.ToLower(string(output))

		if err == nil {
			return nil
		}

		// If package is already absent, treat as successful remediation.
		if strings.Contains(lowerOutput, "not installed") ||
			strings.Contains(lowerOutput, "no package") ||
			strings.Contains(lowerOutput, "no installed package") ||
			strings.Contains(lowerOutput, "unknown package") ||
			strings.Contains(lowerOutput, "not found") {
			return nil
		}

		errors = append(errors, fmt.Sprintf("%s %v: %v (%s)", attempt.command, attempt.args, err, strings.TrimSpace(string(output))))
	}

	if attempted == 0 {
		return fmt.Errorf("no supported uninstall command found on this endpoint for %q", softwareName)
	}

	return fmt.Errorf("failed to uninstall %q after %d attempt(s): %s", softwareName, attempted, strings.Join(errors, "; "))
}
