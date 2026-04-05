//go:build darwin

package cis

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

// isTruthyPref normalises boolean preference values from `defaults read`.
// macOS can store booleans as "1", "true", "yes", or "YES".
func isTruthyPref(val string) bool {
	switch strings.ToLower(strings.TrimSpace(val)) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// isLaunchctlNotFound returns true when the launchctl error indicates the
// service is genuinely not loaded (exit status 113 / "Could not find service"),
// as opposed to permission denied, timeout, or another failure.
func isLaunchctlNotFound(err error) bool {
	msg := err.Error()
	return strings.Contains(msg, "exit status 113") ||
		strings.Contains(msg, "Could not find service")
}

func sharingAndSecurityChecks() []Check {
	return []Check{
		// Software Update (CIS 1.x)
		{ID: "1.2", Title: "Ensure auto software update check is enabled", Severity: "medium", Level: "l1",
			Fn: func() CheckResult {
				return checkSoftwareUpdatePref("1.2", "Ensure auto software update check is enabled", "AutomaticCheckEnabled")
			}},
		{ID: "1.3", Title: "Ensure auto download of updates is enabled", Severity: "medium", Level: "l1",
			Fn: func() CheckResult {
				return checkSoftwareUpdatePref("1.3", "Ensure auto download of updates is enabled", "AutomaticDownload")
			}},
		{ID: "1.5", Title: "Ensure install of critical updates is enabled", Severity: "medium", Level: "l1",
			Fn: func() CheckResult {
				return checkSoftwareUpdatePref("1.5", "Ensure install of critical updates is enabled", "CriticalUpdateInstall")
			}},
		// AirDrop (CIS 2.1.x)
		{ID: "2.1.1.1", Title: "Ensure AirDrop is disabled", Severity: "medium", Level: "l1", Fn: checkAirDropDisabled},
		// Sharing Services (CIS 2.3.3.x)
		{ID: "2.3.3.1", Title: "Ensure screen sharing is disabled", Severity: "medium", Level: "l1", Fn: checkScreenSharingDisabled},
		{ID: "2.3.3.2", Title: "Ensure file sharing (SMB) is disabled", Severity: "medium", Level: "l1", Fn: checkFileSharingDisabled},
		{ID: "2.3.3.3", Title: "Ensure printer sharing is disabled", Severity: "medium", Level: "l1", Fn: checkPrinterSharingDisabled},
		{ID: "2.3.3.4", Title: "Ensure remote login (SSH) is disabled", Severity: "medium", Level: "l1", Fn: checkRemoteLoginDisabled},
		{ID: "2.3.3.5", Title: "Ensure remote management is disabled", Severity: "medium", Level: "l1", Fn: checkRemoteManagementDisabled},
		{ID: "2.3.3.6", Title: "Ensure Bluetooth sharing is disabled", Severity: "medium", Level: "l1", Fn: checkBluetoothSharingDisabled},
		{ID: "2.3.3.7", Title: "Ensure Internet sharing is disabled", Severity: "medium", Level: "l1", Fn: checkInternetSharingDisabled},
		{ID: "2.3.3.8", Title: "Ensure content caching is disabled", Severity: "medium", Level: "l1", Fn: checkContentCachingDisabled},
		{ID: "2.3.3.9", Title: "Ensure media sharing is disabled", Severity: "medium", Level: "l1", Fn: checkMediaSharingDisabled},
		// Security Hardening (CIS 5.1.x)
		{ID: "5.1.2", Title: "Ensure System Integrity Protection (SIP) is enabled", Severity: "high", Level: "l1", Fn: checkSIPEnabled},
		{ID: "5.1.3", Title: "Ensure firewall stealth mode is enabled", Severity: "medium", Level: "l1", Fn: checkFirewallStealthMode},
	}
}

// checkSoftwareUpdatePref checks a boolean preference key under com.apple.SoftwareUpdate.
func checkSoftwareUpdatePref(checkID, title, key string) CheckResult {
	result := CheckResult{
		CheckID:  checkID,
		Title:    title,
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"defaults", "read", "/Library/Preferences/com.apple.SoftwareUpdate", key)
	if err != nil {
		result.Status = "fail"
		result.Message = fmt.Sprintf("%s is not enabled (preference not set)", key)
		result.Evidence = map[string]any{key: "not_set"}
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{key: val}

	if isTruthyPref(val) {
		result.Status = "pass"
		result.Message = fmt.Sprintf("%s is enabled", key)
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("%s is not enabled (value: %s)", key, val)
	}
	return result
}

// checkAirDropDisabled validates CIS 2.1.1.1.
func checkAirDropDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.1.1.1",
		Title:    "Ensure AirDrop is disabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"defaults", "read", "com.apple.NetworkBrowser", "DisableAirDrop")
	if err != nil {
		// Key not found — AirDrop is enabled by default.
		result.Status = "fail"
		result.Message = "AirDrop is enabled (DisableAirDrop not set)"
		result.Evidence = map[string]any{"disableAirDrop": "not_set"}
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"disableAirDrop": val}

	if isTruthyPref(val) {
		result.Status = "pass"
		result.Message = "AirDrop is disabled"
	} else {
		result.Status = "fail"
		result.Message = "AirDrop is enabled"
	}
	return result
}

// checkScreenSharingDisabled validates CIS 2.3.3.1.
func checkScreenSharingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.1",
		Title:    "Ensure screen sharing is disabled",
		Severity: "medium",
	}

	_, err := security.RunCommand(5*time.Second,
		"launchctl", "print", "system/com.apple.screensharing")
	if err != nil {
		if isLaunchctlNotFound(err) {
			result.Status = "pass"
			result.Message = "Screen sharing service is not loaded"
			result.Evidence = map[string]any{"serviceLoaded": false}
		} else {
			result.Status = "error"
			result.Message = fmt.Sprintf("failed to query screen sharing service: %s", err.Error())
			result.Evidence = map[string]any{"error": err.Error()}
		}
		return result
	}

	result.Status = "fail"
	result.Message = "Screen sharing service is loaded (active)"
	result.Evidence = map[string]any{"serviceLoaded": true}
	return result
}

// checkFileSharingDisabled validates CIS 2.3.3.2.
func checkFileSharingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.2",
		Title:    "Ensure file sharing (SMB) is disabled",
		Severity: "medium",
	}

	_, err := security.RunCommand(5*time.Second,
		"launchctl", "print", "system/com.apple.smbd")
	if err != nil {
		if isLaunchctlNotFound(err) {
			result.Status = "pass"
			result.Message = "File sharing (SMB) service is not loaded"
			result.Evidence = map[string]any{"serviceLoaded": false}
		} else {
			result.Status = "error"
			result.Message = fmt.Sprintf("failed to query file sharing service: %s", err.Error())
			result.Evidence = map[string]any{"error": err.Error()}
		}
		return result
	}

	result.Status = "fail"
	result.Message = "File sharing (SMB) service is loaded (active)"
	result.Evidence = map[string]any{"serviceLoaded": true}
	return result
}

// checkPrinterSharingDisabled validates CIS 2.3.3.3.
func checkPrinterSharingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.3",
		Title:    "Ensure printer sharing is disabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second, "cupsctl")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to run cupsctl: %s", err.Error())
		return result
	}

	sharing := strings.Contains(output, "_share_printers=1")
	result.Evidence = map[string]any{"printerSharing": sharing, "cupsctlOutput": output}

	if !sharing {
		result.Status = "pass"
		result.Message = "Printer sharing is disabled"
	} else {
		result.Status = "fail"
		result.Message = "Printer sharing is enabled"
	}
	return result
}

// checkRemoteLoginDisabled validates CIS 2.3.3.4.
func checkRemoteLoginDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.4",
		Title:    "Ensure remote login (SSH) is disabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"systemsetup", "-getremotelogin")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check remote login: %s", err.Error())
		return result
	}

	lower := strings.ToLower(output)
	result.Evidence = map[string]any{"remoteLogin": output}

	if strings.Contains(lower, "remote login: off") {
		result.Status = "pass"
		result.Message = "Remote login (SSH) is disabled"
	} else if strings.Contains(lower, "remote login: on") {
		result.Status = "fail"
		result.Message = "Remote login (SSH) is enabled"
	} else {
		result.Status = "error"
		result.Message = fmt.Sprintf("unexpected systemsetup output: %s", strings.TrimSpace(output))
	}
	return result
}

// checkRemoteManagementDisabled validates CIS 2.3.3.5.
func checkRemoteManagementDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.5",
		Title:    "Ensure remote management is disabled",
		Severity: "medium",
	}

	_, err := security.RunCommand(5*time.Second,
		"launchctl", "print", "system/com.apple.RemoteDesktop.agent")
	if err != nil {
		if isLaunchctlNotFound(err) {
			result.Status = "pass"
			result.Message = "Remote management (ARD) service is not loaded"
			result.Evidence = map[string]any{"serviceLoaded": false}
		} else {
			result.Status = "error"
			result.Message = fmt.Sprintf("failed to query remote management service: %s", err.Error())
			result.Evidence = map[string]any{"error": err.Error()}
		}
		return result
	}

	result.Status = "fail"
	result.Message = "Remote management (ARD) service is loaded (active)"
	result.Evidence = map[string]any{"serviceLoaded": true}
	return result
}

// checkBluetoothSharingDisabled validates CIS 2.3.3.6.
func checkBluetoothSharingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.6",
		Title:    "Ensure Bluetooth sharing is disabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"defaults", "-currentHost", "read", "com.apple.Bluetooth", "PrefKeyServicesEnabled")
	if err != nil {
		// Key not found — default is disabled.
		result.Status = "pass"
		result.Message = "Bluetooth sharing preference not set (default: disabled)"
		result.Evidence = map[string]any{"prefKeyServicesEnabled": "not_set"}
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"prefKeyServicesEnabled": val}

	if val == "0" {
		result.Status = "pass"
		result.Message = "Bluetooth sharing is disabled"
	} else {
		result.Status = "fail"
		result.Message = "Bluetooth sharing is enabled"
	}
	return result
}

// checkInternetSharingDisabled validates CIS 2.3.3.7.
func checkInternetSharingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.7",
		Title:    "Ensure Internet sharing is disabled",
		Severity: "medium",
	}

	// Check IP forwarding — the reliable kernel-level indicator.
	fwdOutput, fwdErr := security.RunCommand(5*time.Second,
		"sysctl", "-n", "net.inet.ip.forwarding")
	if fwdErr == nil && strings.TrimSpace(fwdOutput) == "1" {
		result.Status = "fail"
		result.Message = "Internet sharing is enabled (IP forwarding active)"
		result.Evidence = map[string]any{"ipForwarding": true}
		return result
	}

	// Also check the NAT plist as a secondary signal.
	output, err := security.RunCommand(5*time.Second,
		"defaults", "read",
		"/Library/Preferences/SystemConfiguration/com.apple.nat", "NAT")
	if err != nil {
		result.Status = "pass"
		result.Message = "Internet sharing is not configured"
		result.Evidence = map[string]any{"natConfig": "not_set", "ipForwarding": false}
		return result
	}

	enabled := strings.Contains(output, "Enabled = 1") || strings.Contains(output, "\"Enabled\" = 1")
	result.Evidence = map[string]any{"natConfig": output, "enabled": enabled, "ipForwarding": false}

	if !enabled {
		result.Status = "pass"
		result.Message = "Internet sharing is disabled"
	} else {
		result.Status = "fail"
		result.Message = "Internet sharing is enabled (NAT configured)"
	}
	return result
}

// checkContentCachingDisabled validates CIS 2.3.3.8.
func checkContentCachingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.8",
		Title:    "Ensure content caching is disabled",
		Severity: "medium",
	}

	if _, lookErr := exec.LookPath("AssetCacheManagerUtil"); lookErr != nil {
		result.Status = "pass"
		result.Message = "Content caching utility not available (not installed)"
		result.Evidence = map[string]any{"utilityAvailable": false}
		return result
	}

	output, err := security.RunCommand(5*time.Second,
		"AssetCacheManagerUtil", "isActivated")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("AssetCacheManagerUtil failed: %s", err.Error())
		result.Evidence = map[string]any{"error": err.Error()}
		return result
	}

	lower := strings.ToLower(output)
	activated := strings.Contains(lower, "activated: true") || strings.Contains(lower, "activated = 1")
	result.Evidence = map[string]any{"assetCacheOutput": output, "activated": activated}

	if !activated {
		result.Status = "pass"
		result.Message = "Content caching is not activated"
	} else {
		result.Status = "fail"
		result.Message = "Content caching is activated"
	}
	return result
}

// checkMediaSharingDisabled validates CIS 2.3.3.9.
func checkMediaSharingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "2.3.3.9",
		Title:    "Ensure media sharing is disabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"defaults", "read", "com.apple.amp.mediasharingd", "home-sharing-enabled")
	if err != nil {
		// Key not found — default is disabled.
		result.Status = "pass"
		result.Message = "Media sharing preference not set (default: disabled)"
		result.Evidence = map[string]any{"homeSharingEnabled": "not_set"}
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"homeSharingEnabled": val}

	if val == "0" {
		result.Status = "pass"
		result.Message = "Media sharing is disabled"
	} else {
		result.Status = "fail"
		result.Message = "Media sharing is enabled"
	}
	return result
}

// checkSIPEnabled validates CIS 5.1.2.
func checkSIPEnabled() CheckResult {
	result := CheckResult{
		CheckID:  "5.1.2",
		Title:    "Ensure System Integrity Protection (SIP) is enabled",
		Severity: "high",
	}

	output, err := security.RunCommand(5*time.Second, "csrutil", "status")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check SIP status: %s", err.Error())
		return result
	}

	lower := strings.ToLower(output)
	result.Evidence = map[string]any{"csrutilOutput": output}

	if strings.Contains(lower, "status: enabled") {
		if strings.Contains(lower, "custom configuration") {
			result.Status = "fail"
			result.Message = "SIP is enabled but with custom configuration (some protections may be disabled)"
		} else {
			result.Status = "pass"
			result.Message = "System Integrity Protection is enabled"
		}
	} else {
		result.Status = "fail"
		result.Message = "System Integrity Protection is disabled"
	}
	return result
}

// checkFirewallStealthMode validates CIS 5.1.3.
func checkFirewallStealthMode() CheckResult {
	result := CheckResult{
		CheckID:  "5.1.3",
		Title:    "Ensure firewall stealth mode is enabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second,
		"/usr/libexec/ApplicationFirewall/socketfilterfw", "--getstealthmode")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to check stealth mode: %s", err.Error())
		return result
	}

	lower := strings.ToLower(output)
	result.Evidence = map[string]any{"stealthModeOutput": output}

	if strings.Contains(lower, "stealth mode enabled") {
		result.Status = "pass"
		result.Message = "Firewall stealth mode is enabled"
	} else {
		result.Status = "fail"
		result.Message = "Firewall stealth mode is not enabled"
	}
	return result
}
