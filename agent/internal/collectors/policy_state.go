package collectors

import (
	"bufio"
	"os"
	"strings"
)

type RegistryProbe struct {
	RegistryPath string
	ValueName    string
}

type ConfigProbe struct {
	FilePath  string
	ConfigKey string
}

type RegistryStateEntry struct {
	RegistryPath string `json:"registryPath"`
	ValueName    string `json:"valueName"`
	ValueData    any    `json:"valueData,omitempty"`
	ValueType    string `json:"valueType,omitempty"`
}

type ConfigStateEntry struct {
	FilePath    string `json:"filePath"`
	ConfigKey   string `json:"configKey"`
	ConfigValue any    `json:"configValue,omitempty"`
}

type PolicyStateCollector struct{}

func NewPolicyStateCollector() *PolicyStateCollector {
	return &PolicyStateCollector{}
}

func (c *PolicyStateCollector) CollectConfigState(probes []ConfigProbe) ([]ConfigStateEntry, error) {
	entries := make([]ConfigStateEntry, 0, len(probes))
	seen := make(map[string]struct{})

	for _, probe := range probes {
		filePath := strings.TrimSpace(probe.FilePath)
		configKey := strings.TrimSpace(probe.ConfigKey)
		if filePath == "" || configKey == "" {
			continue
		}

		dedupeKey := strings.ToLower(filePath) + "::" + strings.ToLower(configKey)
		if _, ok := seen[dedupeKey]; ok {
			continue
		}
		seen[dedupeKey] = struct{}{}

		content, err := os.ReadFile(filePath)
		if err != nil {
			continue
		}

		value, ok := extractConfigValue(string(content), configKey)
		if !ok {
			continue
		}

		entries = append(entries, ConfigStateEntry{
			FilePath:    filePath,
			ConfigKey:   configKey,
			ConfigValue: value,
		})
	}

	return entries, nil
}

func extractConfigValue(content string, wantedKey string) (string, bool) {
	scanner := bufio.NewScanner(strings.NewReader(content))
	normalizedWantedKey := strings.ToLower(strings.TrimSpace(wantedKey))

	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}

		key, value, ok := splitConfigLine(line)
		if !ok {
			continue
		}

		if strings.ToLower(strings.TrimSpace(key)) != normalizedWantedKey {
			continue
		}

		normalizedValue := normalizeConfigValue(value)
		return normalizedValue, true
	}

	return "", false
}

func splitConfigLine(line string) (string, string, bool) {
	if idx := strings.Index(line, "="); idx >= 0 {
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		if key == "" {
			return "", "", false
		}
		return key, value, true
	}

	// Support common YAML-style "key: value" lines.
	if idx := strings.Index(line, ":"); idx >= 0 {
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		if key != "" && !strings.ContainsAny(key, " \t") {
			return key, value, true
		}
	}

	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", "", false
	}

	key := fields[0]
	value := strings.Join(fields[1:], " ")
	return key, value, true
}

func normalizeConfigValue(value string) string {
	trimmed := strings.TrimSpace(value)
	for _, marker := range []string{" #", " ;", "\t#", "\t;"} {
		if idx := strings.Index(trimmed, marker); idx >= 0 {
			trimmed = strings.TrimSpace(trimmed[:idx])
		}
	}
	trimmed = strings.Trim(trimmed, "\"'")
	return strings.TrimSpace(trimmed)
}
