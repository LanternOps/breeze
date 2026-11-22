package security

import (
	"regexp"
	"strconv"
	"strings"
)

// macOSMajorVersion is a seam so firewall tests can run on non-macOS CI.
var macOSMajorVersion = hostMacOSMajorVersion

// parseMacOSMajor extracts the major number from "27.0.1" style versions.
func parseMacOSMajor(version string) (int, bool) {
	head, _, _ := strings.Cut(strings.TrimSpace(version), ".")
	n, err := strconv.Atoi(head)
	if err != nil {
		return 0, false
	}
	return n, true
}

var socketfilterfwStatePattern = regexp.MustCompile(`State = (\d+)`)

// parseSocketfilterfwState prefers the numeric "State = N" because the
// surrounding text is localized; English words are the fallback.
func parseSocketfilterfwState(output string) (enabled, ok bool) {
	if m := socketfilterfwStatePattern.FindStringSubmatch(output); m != nil {
		switch m[1] {
		case "0":
			return false, true
		case "1", "2":
			return true, true
		}
	}
	lower := strings.ToLower(output)
	if strings.Contains(lower, "enabled") {
		return true, true
	}
	if strings.Contains(lower, "disabled") {
		return false, true
	}
	return false, false
}
