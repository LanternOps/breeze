//go:build linux

package cis

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/security"
)

func platformRemediate(checkID, action string, payload map[string]any) RemediationResult {
	switch checkID {
	case "1.1.1.1":
		module := "cramfs"
		if m, ok := payload["module"].(string); ok && m != "" {
			module = m
		}
		return remediateDisableKernelModule(module)
	case "1.5.3":
		return remediateSysctl("kernel.randomize_va_space", "2")
	case "1.4.1":
		return remediateSysctl("fs.suid_dumpable", "0")
	case "3.3.1":
		return remediateSysctl("net.ipv4.ip_forward", "0")
	case "5.2.5":
		return remediateHardenSshdConfig("PermitRootLogin", "no")
	default:
		return RemediationResult{
			CheckID: checkID,
			Action:  action,
			Success: false,
			Error:   fmt.Sprintf("no Linux remediation implemented for check %s", checkID),
		}
	}
}

// remediateDisableKernelModule blacklists a kernel module.
func remediateDisableKernelModule(module string) RemediationResult {
	result := RemediationResult{
		CheckID: "1.1.1.1",
		Action:  "disable_kernel_module",
	}

	// Capture before state.
	lsmodOut, _ := security.RunCommand(5*time.Second, "lsmod")
	loaded := strings.Contains(lsmodOut, module)
	result.BeforeState = map[string]any{"moduleLoaded": loaded}

	// Write blacklist config.
	confPath := fmt.Sprintf("/etc/modprobe.d/cis-%s.conf", module)
	content := fmt.Sprintf("install %s /bin/true\nblacklist %s\n", module, module)
	if err := os.WriteFile(confPath, []byte(content), 0644); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("failed to write %s: %s", confPath, err.Error())
		return result
	}

	// Unload if currently loaded.
	if loaded {
		security.RunCommand(5*time.Second, "rmmod", module)
	}

	// Capture after state.
	lsmodOut, _ = security.RunCommand(5*time.Second, "lsmod")
	result.AfterState = map[string]any{
		"moduleLoaded": strings.Contains(lsmodOut, module),
		"configFile":   confPath,
	}

	result.Success = true
	result.RollbackHint = fmt.Sprintf("rm %s && modprobe %s", confPath, module)
	return result
}

// remediateSysctl sets a sysctl parameter and persists it.
func remediateSysctl(key, value string) RemediationResult {
	result := RemediationResult{
		CheckID: key,
		Action:  "set_sysctl",
	}

	// Capture before state.
	before, _ := security.RunCommand(5*time.Second, "sysctl", "-n", key)
	result.BeforeState = map[string]any{key: strings.TrimSpace(before)}

	// Apply immediately.
	_, err := security.RunCommand(5*time.Second, "sysctl", "-w", fmt.Sprintf("%s=%s", key, value))
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("failed to set %s: %s", key, err.Error())
		return result
	}

	// Persist to /etc/sysctl.d/99-cis.conf.
	confPath := "/etc/sysctl.d/99-cis.conf"
	line := fmt.Sprintf("%s = %s\n", key, value)

	existing, _ := os.ReadFile(confPath)
	content := string(existing)

	// Replace existing line or append.
	replaced := false
	var lines []string
	for _, l := range strings.Split(content, "\n") {
		if strings.HasPrefix(strings.TrimSpace(l), key+" ") || strings.HasPrefix(strings.TrimSpace(l), key+"=") {
			lines = append(lines, strings.TrimSpace(line))
			replaced = true
		} else if l != "" {
			lines = append(lines, l)
		}
	}
	if !replaced {
		lines = append(lines, strings.TrimSpace(line))
	}

	if err := os.WriteFile(confPath, []byte(strings.Join(lines, "\n")+"\n"), 0644); err != nil {
		result.Details = map[string]any{"warning": fmt.Sprintf("applied but failed to persist to %s: %s", confPath, err.Error())}
	}

	// Capture after state.
	after, _ := security.RunCommand(5*time.Second, "sysctl", "-n", key)
	result.AfterState = map[string]any{key: strings.TrimSpace(after)}

	result.Success = true
	result.RollbackHint = fmt.Sprintf("sysctl -w %s=%s", key, strings.TrimSpace(before))
	return result
}

// remediateHardenSshdConfig sets a key/value in sshd_config and reloads sshd.
func remediateHardenSshdConfig(key, value string) RemediationResult {
	result := RemediationResult{
		CheckID: "5.2.5",
		Action:  "harden_sshd_config",
	}

	confPath := "/etc/ssh/sshd_config"
	data, err := os.ReadFile(confPath)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("failed to read %s: %s", confPath, err.Error())
		return result
	}

	content := string(data)
	oldValue := findSSHConfigValueFromContent(content, key)
	result.BeforeState = map[string]any{key: oldValue}

	// Replace or append the setting.
	newContent := setSSHConfigValue(content, key, value)

	if err := os.WriteFile(confPath, []byte(newContent), 0600); err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("failed to write %s: %s", confPath, err.Error())
		return result
	}

	// Reload sshd.
	_, reloadErr := security.RunCommand(5*time.Second, "systemctl", "reload", "sshd")
	if reloadErr != nil {
		// Try ssh (some distros use 'ssh' not 'sshd').
		security.RunCommand(5*time.Second, "systemctl", "reload", "ssh")
	}

	result.AfterState = map[string]any{key: value}
	result.Success = true
	result.RollbackHint = fmt.Sprintf("Set %s to '%s' in %s and reload sshd", key, oldValue, confPath)
	return result
}

func findSSHConfigValueFromContent(content, key string) string {
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

func setSSHConfigValue(content, key, value string) string {
	setting := fmt.Sprintf("%s %s", key, value)
	replaced := false
	var lines []string

	for _, line := range strings.Split(content, "\n") {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "#") && trimmed != "" {
			parts := strings.Fields(trimmed)
			if len(parts) >= 1 && strings.EqualFold(parts[0], key) {
				lines = append(lines, setting)
				replaced = true
				continue
			}
		}
		lines = append(lines, line)
	}

	if !replaced {
		lines = append(lines, setting)
	}

	return strings.Join(lines, "\n")
}
