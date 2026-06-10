package main

import (
	"strconv"
	"strings"
)

// currentUnitVersion is the breeze-unit-version this binary ships. Bump it
// whenever linuxUnit changes in a way the deployed fleet must pick up; the
// startup reconcile rewrites any on-disk unit older than this.
const currentUnitVersion = 2

const unitVersionPrefix = "# breeze-unit-version:"

// parseUnitVersion extracts the breeze-unit-version marker from a unit file.
// Returns (version, true) when a well-formed marker is present, else (0, false).
func parseUnitVersion(existing string) (int, bool) {
	for _, line := range strings.Split(existing, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, unitVersionPrefix) {
			continue
		}
		v, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, unitVersionPrefix)))
		if err != nil {
			return 0, false
		}
		return v, true
	}
	return 0, false
}

// unitNeedsReconcile reports whether the on-disk unit is older than what this
// binary ships. Missing/garbage marker or a lower version => reconcile. Equal
// or higher (a newer binary wrote it) => leave it alone, never downgrade.
func unitNeedsReconcile(existing string, want int) bool {
	v, ok := parseUnitVersion(existing)
	if !ok {
		return true
	}
	return v < want
}
