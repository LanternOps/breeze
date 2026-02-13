package mgmtdetect

import (
	"regexp"
	"strconv"
	"strings"
)

var profileCountRe = regexp.MustCompile(`(\d+)\s+configuration profiles?\s+installed`)

func parseMacProfilesOutput(output string) []Detection {
	lower := strings.ToLower(output)
	matches := profileCountRe.FindStringSubmatch(lower)
	count := 0
	if len(matches) >= 2 {
		count, _ = strconv.Atoi(matches[1])
	}

	var identifiers []string
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		if strings.Contains(line, "Profile Identifier") {
			parts := strings.SplitN(line, ":", 2)
			if len(parts) == 2 {
				id := strings.TrimSpace(parts[1])
				id = strings.TrimSuffix(id, " (verified)")
				id = strings.TrimSpace(id)
				if id != "" {
					identifiers = append(identifiers, id)
				}
			}
		}
	}

	if count == 0 && len(identifiers) == 0 {
		return nil
	}
	if count == 0 {
		count = len(identifiers)
	}

	return []Detection{
		{
			Name:   "macOS Configuration Profiles",
			Status: StatusActive,
			Details: map[string]any{
				"profileCount": count,
				"profiles":     identifiers,
			},
		},
	}
}
