//go:build linux

package cis

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

func platformChecks() []Check {
	return []Check{
		{
			ID:       "1.1.1.1",
			Title:    "Ensure mounting of cramfs filesystems is disabled",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkCramfsDisabled,
		},
		{
			ID:       "1.5.3",
			Title:    "Ensure address space layout randomization (ASLR) is enabled",
			Severity: "high",
			Level:    "l1",
			Fn:       checkASLREnabled,
		},
		{
			ID:       "1.5.4",
			Title:    "Ensure prelink is not installed",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkPrelinkNotInstalled,
		},
		{
			ID:       "3.4.1",
			Title:    "Ensure a firewall utility is installed and active",
			Severity: "high",
			Level:    "l1",
			Fn:       checkFirewallEnabled,
		},
		{
			ID:       "5.2.1",
			Title:    "Ensure permissions on /etc/ssh/sshd_config are configured",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkSshdConfigPerms,
		},
		{
			ID:       "5.2.5",
			Title:    "Ensure SSH root login is disabled",
			Severity: "high",
			Level:    "l1",
			Fn:       checkSshRootLoginDisabled,
		},
		{
			ID:       "5.2.13",
			Title:    "Ensure SSH LoginGraceTime is set to one minute or less",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkSshLoginGraceTime,
		},
		{
			ID:       "5.4.1",
			Title:    "Ensure password hashing algorithm is SHA-512 or yescrypt",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkPasswordHashAlgorithm,
		},
		{
			ID:       "1.4.1",
			Title:    "Ensure core dumps are restricted",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkCoreDumpsRestricted,
		},
		{
			ID:       "3.3.1",
			Title:    "Ensure IP forwarding is disabled",
			Severity: "medium",
			Level:    "l1",
			Fn:       checkIPForwardingDisabled,
		},
	}
}

// checkCramfsDisabled validates CIS 1.1.1.1.
func checkCramfsDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "1.1.1.1",
		Title:    "Ensure mounting of cramfs filesystems is disabled",
		Severity: "medium",
	}

	lsmodOut, err := security.RunCommand(5*time.Second, "lsmod")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to run lsmod: %s", err.Error())
		return result
	}

	loaded := strings.Contains(lsmodOut, "cramfs")
	result.Evidence = map[string]any{"moduleLoaded": loaded}

	if !loaded {
		// Also check if it's properly blacklisted.
		modprobeOut, _ := security.RunCommand(5*time.Second, "modprobe", "-n", "-v", "cramfs")
		blacklisted := strings.Contains(modprobeOut, "install /bin/true") || strings.Contains(modprobeOut, "install /bin/false")
		result.Evidence["blacklisted"] = blacklisted

		if blacklisted {
			result.Status = "pass"
			result.Message = "cramfs is not loaded and is blacklisted"
		} else {
			result.Status = "fail"
			result.Message = "cramfs is not loaded but not blacklisted"
			result.Remediation = &Remediation{
				Action:       "disable_kernel_module",
				CommandType:  "cis_remediation",
				Payload:      map[string]any{"module": "cramfs"},
				RollbackHint: "rm /etc/modprobe.d/cis-cramfs.conf",
			}
		}
	} else {
		result.Status = "fail"
		result.Message = "cramfs module is currently loaded"
		result.Remediation = &Remediation{
			Action:       "disable_kernel_module",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"module": "cramfs"},
			RollbackHint: "modprobe cramfs",
		}
	}
	return result
}

// checkASLREnabled validates CIS 1.5.3.
func checkASLREnabled() CheckResult {
	result := CheckResult{
		CheckID:  "1.5.3",
		Title:    "Ensure address space layout randomization (ASLR) is enabled",
		Severity: "high",
	}

	output, err := security.RunCommand(5*time.Second, "sysctl", "-n", "kernel.randomize_va_space")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to read sysctl: %s", err.Error())
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"kernel.randomize_va_space": val}

	if val == "2" {
		result.Status = "pass"
		result.Message = "ASLR is fully enabled (randomize_va_space = 2)"
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("ASLR value is %s (should be 2)", val)
		result.Remediation = &Remediation{
			Action:       "set_sysctl",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"key": "kernel.randomize_va_space", "value": "2"},
			RollbackHint: fmt.Sprintf("sysctl -w kernel.randomize_va_space=%s", val),
		}
	}
	return result
}

// checkPrelinkNotInstalled validates CIS 1.5.4.
func checkPrelinkNotInstalled() CheckResult {
	result := CheckResult{
		CheckID:  "1.5.4",
		Title:    "Ensure prelink is not installed",
		Severity: "medium",
	}

	_, err := security.RunCommand(5*time.Second, "which", "prelink")
	result.Evidence = map[string]any{"prelinkFound": err == nil}

	if err != nil {
		result.Status = "pass"
		result.Message = "prelink is not installed"
	} else {
		result.Status = "fail"
		result.Message = "prelink is installed"
	}
	return result
}

// checkFirewallEnabled validates CIS 3.4.1.
func checkFirewallEnabled() CheckResult {
	result := CheckResult{
		CheckID:  "3.4.1",
		Title:    "Ensure a firewall utility is installed and active",
		Severity: "high",
	}

	enabled, err := security.GetFirewallStatus()
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("unable to determine firewall status: %s", err.Error())
		return result
	}

	result.Evidence = map[string]any{"firewallEnabled": enabled}

	if enabled {
		result.Status = "pass"
		result.Message = "Firewall is active"
	} else {
		result.Status = "fail"
		result.Message = "No active firewall detected"
	}
	return result
}

// checkSshdConfigPerms validates CIS 5.2.1 — sshd_config owned by root with mode 600.
func checkSshdConfigPerms() CheckResult {
	result := CheckResult{
		CheckID:  "5.2.1",
		Title:    "Ensure permissions on /etc/ssh/sshd_config are configured",
		Severity: "medium",
	}

	info, err := os.Stat("/etc/ssh/sshd_config")
	if err != nil {
		if os.IsNotExist(err) {
			result.Status = "not_applicable"
			result.Message = "sshd_config not found — SSH may not be installed"
		} else {
			result.Status = "error"
			result.Message = fmt.Sprintf("failed to stat sshd_config: %s", err.Error())
		}
		return result
	}

	mode := info.Mode().Perm()
	result.Evidence = map[string]any{"mode": fmt.Sprintf("%04o", mode)}

	if mode <= 0o600 {
		result.Status = "pass"
		result.Message = fmt.Sprintf("sshd_config permissions are %04o", mode)
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("sshd_config permissions are %04o (should be 0600 or stricter)", mode)
	}
	return result
}

// checkSshRootLoginDisabled validates CIS 5.2.5.
func checkSshRootLoginDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "5.2.5",
		Title:    "Ensure SSH root login is disabled",
		Severity: "high",
	}

	data, err := os.ReadFile("/etc/ssh/sshd_config")
	if err != nil {
		if os.IsNotExist(err) {
			result.Status = "not_applicable"
			result.Message = "sshd_config not found — SSH may not be installed"
		} else {
			result.Status = "error"
			result.Message = fmt.Sprintf("failed to read sshd_config: %s", err.Error())
		}
		return result
	}

	value := findSSHConfigValue(string(data), "PermitRootLogin")
	result.Evidence = map[string]any{"permitRootLogin": value}

	if strings.EqualFold(value, "no") {
		result.Status = "pass"
		result.Message = "PermitRootLogin is set to no"
	} else {
		result.Status = "fail"
		if value == "" {
			result.Message = "PermitRootLogin is not explicitly set (default may allow root login)"
		} else {
			result.Message = fmt.Sprintf("PermitRootLogin is set to '%s' (should be 'no')", value)
		}
		result.Remediation = &Remediation{
			Action:       "harden_sshd_config",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"key": "PermitRootLogin", "value": "no"},
			RollbackHint: fmt.Sprintf("Set PermitRootLogin to '%s' in /etc/ssh/sshd_config", value),
		}
	}
	return result
}

// checkSshLoginGraceTime validates CIS 5.2.13 — LoginGraceTime <= 60.
func checkSshLoginGraceTime() CheckResult {
	result := CheckResult{
		CheckID:  "5.2.13",
		Title:    "Ensure SSH LoginGraceTime is set to one minute or less",
		Severity: "medium",
	}

	data, err := os.ReadFile("/etc/ssh/sshd_config")
	if err != nil {
		if os.IsNotExist(err) {
			result.Status = "not_applicable"
			result.Message = "sshd_config not found"
		} else {
			result.Status = "error"
			result.Message = fmt.Sprintf("failed to read sshd_config: %s", err.Error())
		}
		return result
	}

	value := findSSHConfigValue(string(data), "LoginGraceTime")
	result.Evidence = map[string]any{"loginGraceTime": value}

	if value == "" {
		result.Status = "fail"
		result.Message = "LoginGraceTime is not set (default is 120s)"
		return result
	}

	// LoginGraceTime can be in seconds or with suffix (e.g., "60", "1m")
	if value == "60" || value == "1m" || value == "30" || value == "30s" {
		result.Status = "pass"
		result.Message = fmt.Sprintf("LoginGraceTime is set to %s", value)
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("LoginGraceTime is set to %s (should be 60 or less)", value)
	}
	return result
}

// checkPasswordHashAlgorithm validates CIS 5.4.1 — SHA-512 or yescrypt.
func checkPasswordHashAlgorithm() CheckResult {
	result := CheckResult{
		CheckID:  "5.4.1",
		Title:    "Ensure password hashing algorithm is SHA-512 or yescrypt",
		Severity: "medium",
	}

	// Check /etc/login.defs for ENCRYPT_METHOD
	data, err := os.ReadFile("/etc/login.defs")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to read /etc/login.defs: %s", err.Error())
		return result
	}

	method := ""
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		if strings.HasPrefix(line, "ENCRYPT_METHOD") {
			parts := strings.Fields(line)
			if len(parts) >= 2 {
				method = strings.ToUpper(parts[1])
			}
		}
	}

	result.Evidence = map[string]any{"encryptMethod": method}

	if method == "SHA512" || method == "YESCRYPT" {
		result.Status = "pass"
		result.Message = fmt.Sprintf("Password hashing algorithm is %s", method)
	} else {
		result.Status = "fail"
		if method == "" {
			result.Message = "ENCRYPT_METHOD not found in /etc/login.defs"
		} else {
			result.Message = fmt.Sprintf("Password hashing algorithm is %s (should be SHA512 or YESCRYPT)", method)
		}
	}
	return result
}

// checkCoreDumpsRestricted validates CIS 1.4.1.
func checkCoreDumpsRestricted() CheckResult {
	result := CheckResult{
		CheckID:  "1.4.1",
		Title:    "Ensure core dumps are restricted",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second, "sysctl", "-n", "fs.suid_dumpable")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to read sysctl: %s", err.Error())
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"fs.suid_dumpable": val}

	if val == "0" {
		result.Status = "pass"
		result.Message = "Core dumps are restricted (suid_dumpable = 0)"
	} else {
		result.Status = "fail"
		result.Message = fmt.Sprintf("suid_dumpable is %s (should be 0)", val)
		result.Remediation = &Remediation{
			Action:       "set_sysctl",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"key": "fs.suid_dumpable", "value": "0"},
			RollbackHint: fmt.Sprintf("sysctl -w fs.suid_dumpable=%s", val),
		}
	}
	return result
}

// checkIPForwardingDisabled validates CIS 3.3.1.
func checkIPForwardingDisabled() CheckResult {
	result := CheckResult{
		CheckID:  "3.3.1",
		Title:    "Ensure IP forwarding is disabled",
		Severity: "medium",
	}

	output, err := security.RunCommand(5*time.Second, "sysctl", "-n", "net.ipv4.ip_forward")
	if err != nil {
		result.Status = "error"
		result.Message = fmt.Sprintf("failed to read sysctl: %s", err.Error())
		return result
	}

	val := strings.TrimSpace(output)
	result.Evidence = map[string]any{"net.ipv4.ip_forward": val}

	if val == "0" {
		result.Status = "pass"
		result.Message = "IP forwarding is disabled"
	} else {
		result.Status = "fail"
		result.Message = "IP forwarding is enabled (should be disabled)"
		result.Remediation = &Remediation{
			Action:       "set_sysctl",
			CommandType:  "cis_remediation",
			Payload:      map[string]any{"key": "net.ipv4.ip_forward", "value": "0"},
			RollbackHint: "sysctl -w net.ipv4.ip_forward=1",
		}
	}
	return result
}

// findSSHConfigValue reads the effective value of a key from sshd_config content.
func findSSHConfigValue(content, key string) string {
	for _, line := range strings.Split(content, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "#") || line == "" {
			continue
		}
		parts := strings.Fields(line)
		if len(parts) >= 2 && strings.EqualFold(parts[0], key) {
			return parts[1]
		}
	}
	return ""
}
