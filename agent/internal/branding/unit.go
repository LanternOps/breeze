package branding

import (
	"errors"
	"fmt"
	"strings"
)

// ErrNoDescriptionLine is returned when a unit has no Description= line to brand.
var ErrNoDescriptionLine = errors.New("unit has no Description= line")

// UnitWithDescription returns unit with its first Description= line replaced
// by description. An unset (empty or blank) description returns unit
// unchanged. An invalid description, or a unit with no Description= line,
// also returns unit unchanged together with an error the caller can log, so a
// bad build-time value never reaches a unit that runs as root.
func UnitWithDescription(unit, description string) (string, error) {
	if strings.TrimSpace(description) == "" {
		return unit, nil
	}
	if !Valid(description) {
		return unit, fmt.Errorf("invalid branding description (%d characters)", len([]rune(description)))
	}
	lines := strings.Split(unit, "\n")
	for i, line := range lines {
		if strings.HasPrefix(line, "Description=") {
			lines[i] = "Description=" + description
			return strings.Join(lines, "\n"), nil
		}
	}
	return unit, ErrNoDescriptionLine
}
