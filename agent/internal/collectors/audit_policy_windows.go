//go:build windows

package collectors

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"strconv"
	"strings"
)

func collectAuditPolicyState() (AuditPolicySnapshot, error) {
	settings := map[string]any{}
	raw := map[string]any{}

	if output, err := runCollectorOutput(collectorLongCommandTimeout, "auditpol", "/get", "/category:*", "/r"); err == nil {
		raw["auditpol"] = truncateCollectorString(string(output))
		parseWindowsAuditpolCSV(string(output), settings)
	} else {
		raw["auditpol_error"] = truncateCollectorString(err.Error())
	}

	for _, logName := range []string{"Security", "System", "Application"} {
		output, err := runCollectorOutput(collectorShortCommandTimeout, "wevtutil", "gl", logName)
		if err != nil {
			raw["wevtutil_"+strings.ToLower(logName)+"_error"] = truncateCollectorString(err.Error())
			continue
		}

		raw["wevtutil_"+strings.ToLower(logName)] = truncateCollectorString(string(output))
		parseWindowsEventLogSettings(logName, string(output), settings)
	}

	return AuditPolicySnapshot{
		OSType:      "windows",
		CollectedAt: nowRFC3339(),
		Settings:    settings,
		Raw:         raw,
	}, nil
}

func parseWindowsAuditpolCSV(content string, settings map[string]any) {
	reader := csv.NewReader(bytes.NewReader([]byte(content)))
	header, err := reader.Read()
	if err != nil {
		return
	}

	subIdx, incIdx, settingValueIdx, ok := resolveWindowsAuditpolIndexes(header)
	if !ok {
		return
	}

	for i := 0; i < collectorResultLimit; i++ {
		row, err := reader.Read()
		if err != nil {
			break
		}
		if len(row) <= subIdx {
			continue
		}

		subcategory := strings.TrimSpace(row[subIdx])
		if subcategory == "" {
			continue
		}

		inclusion := ""
		if incIdx >= 0 && len(row) > incIdx {
			inclusion = normalizeWindowsAuditInclusion(row[incIdx])
		}
		if inclusion == "" && settingValueIdx >= 0 && len(row) > settingValueIdx {
			inclusion = mapWindowsAuditSettingValue(row[settingValueIdx])
		}
		if inclusion == "" && incIdx >= 0 && len(row) > incIdx {
			// Keep raw localized value when no canonical mapping is possible.
			inclusion = strings.ReplaceAll(strings.ToLower(strings.TrimSpace(row[incIdx])), " ", "_")
		}
		if inclusion == "" {
			continue
		}

		key := "auditpol:" + strings.ToLower(subcategory)
		settings[truncateCollectorString(key)] = truncateCollectorString(inclusion)
	}
}

func resolveWindowsAuditpolIndexes(header []string) (subIdx int, incIdx int, settingValueIdx int, ok bool) {
	subIdx = -1
	incIdx = -1
	settingValueIdx = -1

	for idx, column := range header {
		normalized := strings.ToLower(strings.TrimSpace(column))
		switch normalized {
		case "subcategory":
			subIdx = idx
		case "inclusion setting":
			incIdx = idx
		case "setting value":
			settingValueIdx = idx
		}
	}

	// `auditpol /r` keeps stable column order even when header labels are localized.
	if subIdx < 0 && len(header) > 2 {
		subIdx = 2
	}
	if incIdx < 0 && len(header) > 4 {
		incIdx = 4
	}
	if settingValueIdx < 0 && len(header) > 6 {
		settingValueIdx = 6
	}

	if subIdx < 0 {
		return -1, -1, -1, false
	}
	if incIdx < 0 && settingValueIdx < 0 {
		return -1, -1, -1, false
	}

	return subIdx, incIdx, settingValueIdx, true
}

func normalizeWindowsAuditInclusion(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	normalized = strings.ReplaceAll(normalized, "_", " ")
	switch {
	case strings.Contains(normalized, "success and failure"):
		return "success_and_failure"
	case strings.Contains(normalized, "success"):
		return "success"
	case strings.Contains(normalized, "failure"):
		return "failure"
	case strings.Contains(normalized, "no auditing"):
		return "none"
	default:
		return ""
	}
}

func mapWindowsAuditSettingValue(value string) string {
	normalized := strings.TrimSpace(value)
	intValue, err := strconv.Atoi(normalized)
	if err != nil {
		return ""
	}

	switch intValue {
	case 0:
		return "none"
	case 1:
		return "success"
	case 2:
		return "failure"
	case 3:
		return "success_and_failure"
	default:
		return ""
	}
}

func parseWindowsEventLogSettings(logName string, content string, settings map[string]any) {
	prefix := "eventlog." + strings.ToLower(logName)
	for _, line := range strings.Split(content, "\n") {
		parts := strings.SplitN(strings.TrimSpace(line), ":", 2)
		if len(parts) != 2 {
			continue
		}

		key := strings.ToLower(strings.TrimSpace(parts[0]))
		value := strings.TrimSpace(parts[1])
		switch key {
		case "retention":
			settings[prefix+".retention"] = strings.EqualFold(value, "true") || value == "1"
		case "maxsize":
			if n, err := strconv.ParseInt(value, 10, 64); err == nil {
				settings[prefix+".max_size"] = n
			}
		}
	}
}

func applyAuditPolicyBaseline(settings map[string]any) (AuditPolicyApplyResult, error) {
	result := AuditPolicyApplyResult{
		AppliedAt: nowRFC3339(),
	}

	for key, rawValue := range settings {
		normalizedKey := strings.ToLower(strings.TrimSpace(key))
		if !strings.HasPrefix(normalizedKey, "auditpol:") {
			result.Skipped++
			continue
		}

		subcategory := strings.TrimSpace(strings.TrimPrefix(normalizedKey, "auditpol:"))
		if subcategory == "" {
			result.Skipped++
			continue
		}

		successEnabled, failureEnabled, ok := parseWindowsAuditValue(rawValue)
		if !ok {
			result.Skipped++
			result.Errors = append(result.Errors, fmt.Sprintf("unsupported value for %s", key))
			continue
		}

		successArg := "disable"
		if successEnabled {
			successArg = "enable"
		}
		failureArg := "disable"
		if failureEnabled {
			failureArg = "enable"
		}

		output, err := runCollectorCombinedOutput(
			collectorLongCommandTimeout,
			"auditpol",
			"/set",
			"/subcategory:"+subcategory,
			"/success:"+successArg,
			"/failure:"+failureArg,
		)
		if err != nil {
			result.Errors = append(result.Errors, truncateCollectorString(fmt.Sprintf("%s: %v (%s)", key, err, strings.TrimSpace(string(output)))))
			continue
		}

		result.Applied++
	}

	if result.Applied == 0 && len(result.Errors) > 0 {
		return result, fmt.Errorf("failed to apply audit baseline: %s", truncateCollectorString(strings.Join(result.Errors, "; ")))
	}

	return result, nil
}

func parseWindowsAuditValue(rawValue any) (success bool, failure bool, ok bool) {
	value, isString := rawValue.(string)
	if !isString {
		return false, false, false
	}

	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "success_and_failure", "success and failure":
		return true, true, true
	case "success":
		return true, false, true
	case "failure":
		return false, true, true
	case "none", "no_auditing", "no auditing":
		return false, false, true
	default:
		return false, false, false
	}
}
