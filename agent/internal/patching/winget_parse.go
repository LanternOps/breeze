package patching

import (
	"bufio"
	"regexp"
	"strings"
)

// validWingetPkgID matches valid winget package identifiers (e.g. "Mozilla.Firefox", "Google.Chrome").
var validWingetPkgID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._\-]{0,255}$`)

// parseWingetUpgradeOutput parses `winget upgrade` table output into available patches.
// winget upgrade output format:
//
//	Name            Id                  Version   Available  Source
//	---------------------------------------------------------------
//	Mozilla Firefox Mozilla.Firefox     128.0     129.0      winget
func parseWingetUpgradeOutput(output string) []AvailablePatch {
	cols := findColumnBoundaries(output, []string{"Name", "Id", "Version", "Available"})
	if cols == nil {
		return nil
	}

	var patches []AvailablePatch
	scanner := bufio.NewScanner(strings.NewReader(output))
	pastSeparator := false

	for scanner.Scan() {
		line := scanner.Text()

		// Skip until we pass the separator line
		if !pastSeparator {
			if isSeparatorLine(line) {
				pastSeparator = true
			}
			continue
		}

		// Skip empty lines and footer lines
		if strings.TrimSpace(line) == "" {
			continue
		}
		// winget prints a summary line like "X upgrades available."
		if strings.Contains(line, " upgrades available") || strings.Contains(line, " upgrade available") {
			continue
		}
		// winget prints informational messages when no results found
		if strings.Contains(line, "No installed package") || strings.Contains(line, "No applicable update") {
			continue
		}

		name, id, version, available := extractUpgradeColumns(line, cols)
		if id == "" || !validWingetPkgID.MatchString(id) {
			continue
		}

		patches = append(patches, AvailablePatch{
			ID:          id,
			Title:       strings.TrimSpace(name),
			Version:     strings.TrimSpace(available),
			Description: "current: " + strings.TrimSpace(version),
			Category:    "application",
			Severity:    "unknown",
			UpdateType:  "software",
		})
	}

	return patches
}

// parseWingetListOutput parses `winget list` table output into installed patches.
// winget list output format:
//
//	Name            Id                  Version   Source
//	----------------------------------------------------
//	Mozilla Firefox Mozilla.Firefox     128.0     winget
func parseWingetListOutput(output string) []InstalledPatch {
	cols := findColumnBoundaries(output, []string{"Name", "Id", "Version"})
	if cols == nil {
		return nil
	}

	var installed []InstalledPatch
	scanner := bufio.NewScanner(strings.NewReader(output))
	pastSeparator := false

	for scanner.Scan() {
		line := scanner.Text()

		if !pastSeparator {
			if isSeparatorLine(line) {
				pastSeparator = true
			}
			continue
		}

		if strings.TrimSpace(line) == "" {
			continue
		}

		name, id, version := extractListColumns(line, cols)
		if id == "" || !validWingetPkgID.MatchString(id) {
			continue
		}

		installed = append(installed, InstalledPatch{
			ID:      id,
			Title:   strings.TrimSpace(name),
			Version: strings.TrimSpace(version),
		})
	}

	return installed
}

// columnPositions holds the start positions of known columns in winget table output.
type columnPositions struct {
	name      int
	id        int
	version   int
	available int // -1 if not present (list output)
}

// findColumnBoundaries finds column start positions from the header line.
func findColumnBoundaries(output string, requiredCols []string) *columnPositions {
	scanner := bufio.NewScanner(strings.NewReader(output))
	for scanner.Scan() {
		line := scanner.Text()

		nameIdx := strings.Index(line, "Name")
		idIdx := strings.Index(line, "Id")
		versionIdx := strings.Index(line, "Version")
		if nameIdx == -1 || idIdx == -1 || versionIdx == -1 {
			continue
		}
		// Verify Id comes after Name and Version comes after Id
		if idIdx <= nameIdx || versionIdx <= idIdx {
			continue
		}

		cols := &columnPositions{
			name:      nameIdx,
			id:        idIdx,
			version:   versionIdx,
			available: -1,
		}

		availIdx := strings.Index(line, "Available")
		if availIdx > versionIdx {
			cols.available = availIdx
		}

		return cols
	}
	return nil
}

// isSeparatorLine checks if a line is a winget table separator (all dashes/spaces).
func isSeparatorLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	if len(trimmed) < 10 {
		return false
	}
	for _, ch := range trimmed {
		if ch != '-' && ch != ' ' {
			return false
		}
	}
	return true
}

// extractUpgradeColumns extracts Name, Id, Version, Available from a data row.
func extractUpgradeColumns(line string, cols *columnPositions) (name, id, version, available string) {
	if len(line) <= cols.id {
		return
	}
	name = safeSubstring(line, cols.name, cols.id)
	if cols.available > 0 {
		id = safeSubstring(line, cols.id, cols.version)
		version = safeSubstring(line, cols.version, cols.available)
		available = safeSubstring(line, cols.available, len(line))
		// Available column may contain "Source" at the end — trim the source column
		if spaceIdx := strings.LastIndex(strings.TrimSpace(available), " "); spaceIdx > 0 {
			candidate := strings.TrimSpace(available[:spaceIdx])
			// Only strip if the trailing part looks like a source name (no dots/numbers)
			tail := strings.TrimSpace(available[spaceIdx:])
			if !strings.ContainsAny(tail, ".0123456789") {
				available = candidate
			}
		}
	} else {
		id = safeSubstring(line, cols.id, cols.version)
		version = safeSubstring(line, cols.version, len(line))
	}
	return
}

// extractListColumns extracts Name, Id, Version from a data row.
func extractListColumns(line string, cols *columnPositions) (name, id, version string) {
	if len(line) <= cols.id {
		return
	}
	name = safeSubstring(line, cols.name, cols.id)
	id = safeSubstring(line, cols.id, cols.version)
	// `winget list` grows an Available column when any package has an upgrade;
	// slicing to end-of-line concatenated Version+Available into one string
	// ("2.51.0.2   2.55.0.3"). Stop at the Available column when present.
	if cols.available > 0 {
		version = safeSubstring(line, cols.version, cols.available)
		return
	}
	version = safeSubstring(line, cols.version, len(line))
	// Version column may have Source appended — trim if present
	if spaceIdx := strings.LastIndex(strings.TrimSpace(version), " "); spaceIdx > 0 {
		candidate := strings.TrimSpace(version[:spaceIdx])
		tail := strings.TrimSpace(version[spaceIdx:])
		if !strings.ContainsAny(tail, ".0123456789") {
			version = candidate
		}
	}
	return
}

// safeSubstring extracts a substring with bounds checking and trims whitespace.
func safeSubstring(s string, start, end int) string {
	if start < 0 {
		start = 0
	}
	if end > len(s) {
		end = len(s)
	}
	if start >= end {
		return ""
	}
	return strings.TrimSpace(s[start:end])
}
