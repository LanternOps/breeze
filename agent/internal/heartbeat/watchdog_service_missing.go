package heartbeat

import "strings"

func watchdogServiceMissing(output string, err error) bool {
	errText := ""
	if err != nil {
		errText = err.Error()
	}
	lower := strings.ToLower(output + " " + errText)
	return strings.Contains(lower, "not found") ||
		strings.Contains(lower, "not loaded") ||
		strings.Contains(lower, "does not exist") ||
		strings.Contains(lower, "could not be found") ||
		strings.Contains(lower, "no such service")
}
