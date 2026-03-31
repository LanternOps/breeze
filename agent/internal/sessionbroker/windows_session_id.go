package sessionbroker

import (
	"fmt"
	"strconv"
	"strings"
)

func parseWindowsSessionID(value string) (uint32, error) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return 0, fmt.Errorf("session ID is required")
	}
	if trimmed != value {
		return 0, fmt.Errorf("session ID must not include leading or trailing whitespace")
	}
	if len(trimmed) > 10 {
		return 0, fmt.Errorf("session ID is too long")
	}
	for _, r := range trimmed {
		if r < '0' || r > '9' {
			return 0, fmt.Errorf("session ID must contain only digits")
		}
	}
	id, err := strconv.ParseUint(trimmed, 10, 32)
	if err != nil {
		return 0, err
	}
	return uint32(id), nil
}

func ParseWindowsSessionIDForHeartbeat(value string) (uint32, error) {
	return parseWindowsSessionID(value)
}
