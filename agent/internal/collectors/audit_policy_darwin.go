//go:build darwin

package collectors

import (
	"bufio"
	"errors"
	"os"
	"strings"
)

func collectAuditPolicyState() (AuditPolicySnapshot, error) {
	settings := map[string]any{}
	raw := map[string]any{}

	if configData, err := os.ReadFile("/etc/security/audit_control"); err == nil {
		content := string(configData)
		raw["audit_control"] = content
		parseMacAuditControl(content, settings)
	} else {
		raw["audit_control_error"] = err.Error()
	}

	return AuditPolicySnapshot{
		OSType:      "macos",
		CollectedAt: nowRFC3339(),
		Settings:    settings,
		Raw:         raw,
	}, nil
}

func parseMacAuditControl(content string, settings map[string]any) {
	scanner := bufio.NewScanner(strings.NewReader(content))
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.ToLower(strings.TrimSpace(parts[0]))
		value := strings.TrimSpace(parts[1])
		settings["audit_control."+key] = value
	}
}

func applyAuditPolicyBaseline(_ map[string]any) (AuditPolicyApplyResult, error) {
	return AuditPolicyApplyResult{
		AppliedAt: nowRFC3339(),
		Applied:   0,
		Skipped:   0,
		Errors:    []string{"macOS baseline apply is not implemented yet"},
	}, errors.New("macOS baseline apply is not implemented yet")
}
