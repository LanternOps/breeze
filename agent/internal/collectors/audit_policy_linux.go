//go:build linux

package collectors

import (
	"bufio"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
)

func collectAuditPolicyState() (AuditPolicySnapshot, error) {
	settings := map[string]any{}
	raw := map[string]any{}

	if output, err := exec.Command("systemctl", "is-enabled", "auditd").Output(); err == nil {
		value := strings.TrimSpace(string(output))
		settings["auditd.enabled"] = value == "enabled"
		raw["systemctl_is_enabled"] = value
	} else {
		raw["systemctl_is_enabled_error"] = err.Error()
	}

	if output, err := exec.Command("auditctl", "-s").Output(); err == nil {
		content := string(output)
		raw["auditctl_status"] = content
		parseAuditctlStatus(content, settings)
	} else {
		raw["auditctl_status_error"] = err.Error()
	}

	if configData, err := os.ReadFile("/etc/audit/auditd.conf"); err == nil {
		content := string(configData)
		raw["auditd_conf"] = content
		parseAuditdConfig(content, settings)
	} else {
		raw["auditd_conf_error"] = err.Error()
	}

	return AuditPolicySnapshot{
		OSType:      "linux",
		CollectedAt: nowRFC3339(),
		Settings:    settings,
		Raw:         raw,
	}, nil
}

func parseAuditctlStatus(content string, settings map[string]any) {
	for _, line := range strings.Split(content, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 2 {
			continue
		}
		key := strings.ToLower(strings.TrimSpace(fields[0]))
		value := strings.TrimSpace(fields[1])
		switch key {
		case "enabled":
			settings["auditd.kernel_enabled"] = value == "1"
		case "failure":
			settings["auditd.failure_mode"] = value
		}
	}
}

func parseAuditdConfig(content string, settings map[string]any) {
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.ToLower(strings.TrimSpace(parts[0]))
		value := strings.TrimSpace(parts[1])
		switch key {
		case "max_log_file", "num_logs":
			if n, err := strconv.Atoi(value); err == nil {
				settings["auditd."+key] = n
			} else {
				settings["auditd."+key] = value
			}
		case "max_log_file_action", "space_left_action", "admin_space_left_action", "disk_full_action", "disk_error_action":
			settings["auditd."+key] = strings.ToLower(value)
		}
	}
}

func applyAuditPolicyBaseline(_ map[string]any) (AuditPolicyApplyResult, error) {
	return AuditPolicyApplyResult{
		AppliedAt: nowRFC3339(),
		Applied:   0,
		Skipped:   0,
		Errors:    []string{"linux baseline apply is not implemented yet"},
	}, errors.New("linux baseline apply is not implemented yet")
}
