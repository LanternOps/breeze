//go:build darwin

package cis

import (
	"fmt"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

func platformChecks() []Check {
	return []Check{
		{
			ID:       "2.2.1",
			Title:    "Ensure FileVault is enabled",
			Severity: "high",
			Level:    "l1",
			Fn:       checkFileVaultEnabled,
		},
		{
			ID:       "5.1.1",
			Title:    "Ensure macOS application firewall is enabled",
			Severity: "high",
			Level:    "l1",
			Fn:       checkFirewallEnabled,
		},
		{
			ID:       "6.1.2",
			Title:    "Ensure automatic login is disabled",
			Severity: "high",
			Level:    "l1",
			Fn:       checkAutoLoginDisabled,
		},
		{
			ID:       "6.1.3",
			Title:    "Ensure a password is required to wake the computer from sleep or screen saver",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkScreenSaverPassword,
		},
		{
			ID:       "2.5.1",
			Title:    "Ensure Gatekeeper is enabled",
			Severity: "high",
			Level:    "l1",
			Fn:       checkGatekeeperEnabled,
		},
		{
			ID:       "5.2.1",
			Title:    "Ensure SSH root login is disabled",
			Severity: "high",
			Level:    "l1",
			Fn:       checkSshRootLoginDisabled,
		},
		{
			ID:       "2.4.1",
			Title:    "Ensure remote Apple events are disabled",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkRemoteAppleEventsDisabled,
		},
		{
			ID:       "6.3.1",
			Title:    "Ensure Safari 'Open safe files after downloading' is disabled",
			Severity: "low",
			Level:    "l2",
			Fn:       checkSafariAutoOpen,
		},
	}
}

// checkFileVaultEnabled validates CIS 2.2.1.
func checkFileVaultEnabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.2.1",
		Title:    "Ensure FileVault is enabled",
		Severity: "high",
	}

	enabled, err := security.GetEncryptionStatus()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check FileVault: %s", err.Error())
		return result
	}

	result.Evidence = map[string]any{"fileVaultEnabled": enabled}

	if enabled {
		result.Status = "pass"
		result.Message = "FileVault is enabled"
	} else {
		result.Status = "fail"
		result.Message = "FileVault is not enabled"
	}
	return result
}

// checkFirewallEnabled validates CIS 5.1.1.
func checkFirewallEnabled() CheckResult {
	result := CheckResult{
		CheckID:  "5.1.1",
		Title:    "Ensure macOS application firewall is enabled",
		Severity: "high",
	}

	enabled, err := security.GetFirewallStatus()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check firewall: %s", err.Error())
		return result
	}

	result.Evidence = map[string]any{"firewallEnabled": enabled}

	if enabled {
		result.Status = "pass"
		result.Message = "Application firewall is enabled"
	} else {
		result.Status = "fail"
		result.Message = "Application firewall is not enabled"
	}
	return result
}

// checkAutoLoginDisabled validates CIS 6.1.2.
func checkAutoLoginDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "6.1.2",
		Title:    "Ensure automatic login is disabled",
		Severity: "high",
	}

	output, err := security.RunCommand(5*time.Second,
		"defaults", "read", "/Library/Preferences/com.apple.loginwindow", "autoLoginUser")
	if err != nil {
		// Error/not found means no auto-login user is set — pass.
		result.Status = "pass"
		result.Message = "Automatic login is disabled (no autoLoginUser set)"
		result.Evidence = map[string]any{"autoLoginUser": "not_set"}
		return result
	}

	user := strings.TrimSpace(output)
	result.Evidence = map[string]any{"autoLoginUser": user}
	result.Status = "fail"
	result.Message = fmt.Sprintf("Automatic login is enabled for user '%s'", user)
	return result
}

// checkScreenSaverPassword validates CIS 6.1.3.
func checkScreenSaverPassword() CheckResult {
	result := CheckResult{
		CheckID:  "6.1.3",
		Title:    "Ensure a password is required to wake from sleep or screen saver",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"sysadminctl", "-screenLock", "status")
	if err != nil {
		// Fallback to defaults read.
		output2, err2 := security.RunCommand(5*time.Second,
			"defaults", "read", "com.apple.screensaver", "askForPassword")
		if err2 != nil {
			result.Status = "error"
			result.Message = fmt.Sprintf("failed to determine screen lock setting: %s", err.Error())
			return result
		}
		val := strings.TrimSpace(output2)
		result.Evidence = map[string]any{"askForPassword": val}
		if val == "1" {
			result.Status = "pass"
			result.Message = "Password is required to wake from screen saver"
		} else {
			result.Status = "fail"
			result.Message = "Password is NOT required to wake from screen saver"
		}
		return result
	}

	lower := strings.ToLower(output)
	result.Evidence = map[string]any{"screenLockStatus": output}

	if strings.Contains(lower, "screenlock is on") || strings.Contains(lower, "enabled") {
		result.Status = "pass"
		result.Message = "Screen lock is enabled"
	} else {
		result.Status = "fail"
		result.Message = "Screen lock is not enabled"
	}
	return result
}

// checkGatekeeperEnabled validates CIS 2.5.1.
func checkGatekeeperEnabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.5.1",
		Title:    "Ensure Gatekeeper is enabled",
		Severity: "high",
	}

	output, err := security.RunCommand(5*time.Second, "spctl", "--status")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check Gatekeeper: %s", err.Error())
		return result
	}

	lower := strings.ToLower(output)
	result.Evidence = map[string]any{"spctlOutput": output}

	if strings.Contains(lower, "assessments enabled") {
		result.Status = "pass"
		result.Message = "Gatekeeper is enabled"
	} else {
		result.Status = "fail"
		result.Message = "Gatekeeper is not enabled"
	}
	return result
}

// checkSshRootLoginDisabled validates CIS 5.2.1 on macOS.
func checkSshRootLoginDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "5.2.1",
		Title:    "Ensure SSH root login is disabled",
		Severity: "high",
	}

	output, err := security.RunCommand(5*time.Second,
		"grep", "-i", "^PermitRootLogin", "/etc/ssh/sshd_config")
	if err != nil {
		// If grep fails (no match), default behavior depends on OS version.
		result.Status = "pass"
		result.Message = "PermitRootLogin not set (macOS default disallows root SSH)"
		result.Evidence = map[string]any{"permitRootLogin": "not_set"}
		return result
	}

	lower := strings.ToLower(strings.TrimSpace(output))
	result.Evidence = map[string]any{"permitRootLogin": output}

	if strings.Contains(lower, "no") {
		result.Status = "pass"
		result.Message = "SSH root login is disabled"
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("SSH root login is set to: %s", strings.TrimSpace(output))
	}
	return result
}

// checkRemoteAppleEventsDisabled validates CIS 2.4.1.
func checkRemoteAppleEventsDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.4.1",
		Title:    "Ensure remote Apple events are disabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"systemsetup", "-getremoteappleevents")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check remote Apple events: %s", err.Error())
		return result
	}

	lower := strings.ToLower(output)
	result.Evidence = map[string]any{"remoteAppleEvents": output}

	if strings.Contains(lower, "off") {
		result.Status = "pass"
		result.Message = "Remote Apple events are disabled"
	} else {
		result.Status = "fail"
		result.Message = "Remote Apple events are enabled"
	}
	return result
}

// checkSafariAutoOpen validates CIS 6.3.1 (L2).
func checkSafariAutoOpen() CheckResult {
	result := CheckResult{
		CheckID:  "6.3.1",
		Title:    "Ensure Safari 'Open safe files after downloading' is disabled",
		Severity: "low",
	}

	output, err := security.RunCommand(5*time.Second,
		"defaults", "read", "com.apple.Safari", "AutoOpenSafeDownloads")
	if err != nil {
		// Not set — check if default is on or off.
		result.Status = "fail"
		result.Message = "AutoOpenSafeDownloads not explicitly set (default is enabled)"
		result.Evidence = map[string]any{"autoOpenSafeDownloads": "not_set"}
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"autoOpenSafeDownloads": val}

	if val == "0" {
		result.Status = "pass"
		result.Message = "Safari auto-open safe downloads is disabled"
	} else {
		result.Status = "fail"
		result.Message = "Safari auto-open safe downloads is enabled"
	}
	return result
}
