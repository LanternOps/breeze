package procoutput

import "strings"

// ApplyEnv returns a copy of base with UTF-8 locale variables appended when the
// environment lacks them. Subprocesses spawned by the agent often inherit
// LANG=C from systemd/LaunchDaemon and emit non-UTF-8 bytes on Windows.
func ApplyEnv(base []string) []string {
	if hasUTF8Locale(base) {
		out := make([]string, len(base))
		copy(out, base)
		return out
	}
	out := append([]string{}, base...)
	return append(out,
		"LANG=C.UTF-8",
		"LC_ALL=C.UTF-8",
		"LC_CTYPE=C.UTF-8",
	)
}

func hasUTF8Locale(env []string) bool {
	for _, entry := range env {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch key {
		case "LANG", "LC_ALL", "LC_CTYPE":
			if isUTF8LocaleValue(value) {
				return true
			}
		}
	}
	return false
}

func isUTF8LocaleValue(value string) bool {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" || normalized == "c" || normalized == "posix" {
		return false
	}
	return strings.Contains(normalized, "utf-8") || strings.Contains(normalized, "utf8")
}
