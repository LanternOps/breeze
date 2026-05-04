package collectors

import (
	"bufio"
	"os"
	"path"
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

var allowedPolicyConfigKeysByPath = map[string]map[string]struct{}{
	"/etc/ssh/sshd_config": {
		"allowtcpforwarding":              {},
		"challengeresponseauthentication": {},
		"clientalivecountmax":             {},
		"clientaliveinterval":             {},
		"kbdinteractiveauthentication":    {},
		"logingracetime":                  {},
		"maxauthtries":                    {},
		"passwordauthentication":          {},
		"permitrootlogin":                 {},
		"protocol":                        {},
		"pubkeyauthentication":            {},
		"usepam":                          {},
		"x11forwarding":                   {},
	},
	"/etc/login.defs": {
		"encrypt_method": {},
		"pass_max_days":  {},
		"pass_min_days":  {},
		"pass_warn_age":  {},
		"uid_max":        {},
		"uid_min":        {},
		"umask":          {},
	},
	"/etc/audit/auditd.conf": {
		"admin_space_left_action": {},
		"disk_error_action":       {},
		"disk_full_action":        {},
		"max_log_file":            {},
		"max_log_file_action":     {},
		"space_left_action":       {},
	},
}

var allowedSysctlConfigKeys = map[string]struct{}{
	"fs.protected_hardlinks":                 {},
	"fs.protected_symlinks":                  {},
	"kernel.dmesg_restrict":                  {},
	"kernel.kptr_restrict":                   {},
	"kernel.randomize_va_space":              {},
	"net.ipv4.conf.all.accept_redirects":     {},
	"net.ipv4.conf.all.log_martians":         {},
	"net.ipv4.conf.all.rp_filter":            {},
	"net.ipv4.conf.all.secure_redirects":     {},
	"net.ipv4.conf.default.accept_redirects": {},
	"net.ipv4.conf.default.log_martians":     {},
	"net.ipv4.conf.default.rp_filter":        {},
	"net.ipv4.conf.default.secure_redirects": {},
	"net.ipv4.ip_forward":                    {},
	"net.ipv4.tcp_syncookies":                {},
	"net.ipv6.conf.all.accept_redirects":     {},
	"net.ipv6.conf.all.disable_ipv6":         {},
	"net.ipv6.conf.default.accept_redirects": {},
	"net.ipv6.conf.default.disable_ipv6":     {},
}

type PolicyStateCollector struct {
	readFile func(string) ([]byte, error)
}

func NewPolicyStateCollector() *PolicyStateCollector {
	return &PolicyStateCollector{readFile: os.ReadFile}
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
		if !isAllowedPolicyConfigProbe(filePath, configKey) {
			continue
		}
		filePath = normalizePolicyConfigPath(filePath)

		dedupeKey := strings.ToLower(filePath) + "::" + strings.ToLower(configKey)
		if _, ok := seen[dedupeKey]; ok {
			continue
		}
		seen[dedupeKey] = struct{}{}

		content, err := c.readConfigFile(filePath)
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
			ConfigValue: redactSensitiveConfigValue(configKey, value),
		})
	}

	return entries, nil
}

func (c *PolicyStateCollector) readConfigFile(filePath string) ([]byte, error) {
	if c != nil && c.readFile != nil {
		return c.readFile(filePath)
	}
	return os.ReadFile(filePath)
}

func normalizePolicyConfigPath(filePath string) string {
	normalized := strings.ReplaceAll(strings.TrimSpace(filePath), "\\", "/")
	if !strings.HasPrefix(normalized, "/") {
		return ""
	}
	cleaned := path.Clean(normalized)
	if cleaned == "." || strings.Contains(cleaned, "/../") || strings.HasSuffix(cleaned, "/..") {
		return ""
	}
	return cleaned
}

func normalizePolicyConfigKey(configKey string) string {
	return strings.ToLower(strings.TrimSpace(configKey))
}

func isSensitiveConfigKey(configKey string) bool {
	normalized := strings.NewReplacer(" ", "_", ".", "_", "-", "_").Replace(normalizePolicyConfigKey(configKey))
	sensitiveExact := map[string]struct{}{
		"password":   {},
		"passwd":     {},
		"pwd":        {},
		"secret":     {},
		"token":      {},
		"credential": {},
		"bearer":     {},
	}
	if _, ok := sensitiveExact[normalized]; ok {
		return true
	}
	return strings.Contains(normalized, "api_key") ||
		strings.Contains(normalized, "apikey") ||
		strings.Contains(normalized, "access_key") ||
		strings.Contains(normalized, "private_key") ||
		strings.Contains(normalized, "client_secret") ||
		strings.Contains(normalized, "auth_token") ||
		strings.HasSuffix(normalized, "token") ||
		strings.HasSuffix(normalized, "secret")
}

func isAllowedPolicyConfigProbe(filePath string, configKey string) bool {
	normalizedPath := normalizePolicyConfigPath(filePath)
	normalizedKey := normalizePolicyConfigKey(configKey)
	if normalizedPath == "" || normalizedKey == "" || isSensitiveConfigKey(normalizedKey) {
		return false
	}

	if keys, ok := allowedPolicyConfigKeysByPath[normalizedPath]; ok {
		_, allowed := keys[normalizedKey]
		return allowed
	}

	if normalizedPath == "/etc/sysctl.conf" ||
		(strings.HasPrefix(normalizedPath, "/etc/sysctl.d/") && strings.HasSuffix(normalizedPath, ".conf")) {
		_, allowed := allowedSysctlConfigKeys[normalizedKey]
		return allowed
	}

	return false
}

func redactSensitiveConfigValue(configKey string, value string) string {
	if isSensitiveConfigKey(configKey) {
		return "[redacted]"
	}
	return value
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
