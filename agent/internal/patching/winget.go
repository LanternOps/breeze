package patching

import (
	"bufio"
	"fmt"
	"regexp"
	"strings"
	"time"
)

// UserExecFunc runs a command in user context and returns stdout, stderr, exit code.
// Used to dispatch commands through the session broker to a user helper process.
type UserExecFunc func(name string, args []string, timeout time.Duration) (stdout, stderr string, exitCode int, err error)

// winget CLI timeouts
const (
	wingetScanTimeout    = 120 * time.Second
	wingetInstallTimeout = 300 * time.Second
)

// validWingetPkgID matches valid winget package identifiers (e.g. "Mozilla.Firefox", "Google.Chrome").
var validWingetPkgID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._\-]{0,255}$`)

// WingetProvider integrates with Windows Package Manager (winget) via user-context IPC.
type WingetProvider struct {
	exec UserExecFunc
}

// NewWingetProvider creates a new WingetProvider that dispatches commands via the given executor.
func NewWingetProvider(exec UserExecFunc) *WingetProvider {
	return &WingetProvider{exec: exec}
}

// ID returns the provider identifier.
func (w *WingetProvider) ID() string {
	return "winget"
}

// Name returns the human-readable provider name.
func (w *WingetProvider) Name() string {
	return "winget (Windows Package Manager)"
}

// Scan returns available upgrades from winget.
func (w *WingetProvider) Scan() ([]AvailablePatch, error) {
	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"upgrade",
		"--include-unknown",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget upgrade failed: %w", err)
	}
	// winget returns exit code 0 for "no upgrades" and non-zero for some upgrade scenarios
	// but also returns non-zero on actual errors — check stderr
	if exitCode != 0 && stdout == "" {
		return nil, fmt.Errorf("winget upgrade failed (exit %d): %s", exitCode, strings.TrimSpace(stderr))
	}

	return parseWingetUpgradeOutput(stdout), nil
}

// Install installs a package by winget ID.
func (w *WingetProvider) Install(patchID string) (InstallResult, error) {
	if !validWingetPkgID.MatchString(patchID) {
		return InstallResult{}, fmt.Errorf("invalid winget package ID: %q", patchID)
	}

	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"install",
		"--exact",
		"--id", patchID,
		"--silent",
		"--accept-package-agreements",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetInstallTimeout)
	if err != nil {
		return InstallResult{}, fmt.Errorf("winget install failed: %w", err)
	}

	combined := strings.TrimSpace(stdout + "\n" + stderr)
	if exitCode != 0 {
		return InstallResult{}, fmt.Errorf("winget install failed (exit %d): %s", exitCode, combined)
	}

	result := InstallResult{
		PatchID: patchID,
		Message: combined,
	}

	// winget signals reboot requirement in output
	if strings.Contains(strings.ToLower(combined), "restart") || strings.Contains(strings.ToLower(combined), "reboot") {
		result.RebootRequired = true
	}

	return result, nil
}

// Uninstall removes a package by winget ID.
func (w *WingetProvider) Uninstall(patchID string) error {
	if !validWingetPkgID.MatchString(patchID) {
		return fmt.Errorf("invalid winget package ID: %q", patchID)
	}

	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"uninstall",
		"--exact",
		"--id", patchID,
		"--silent",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetInstallTimeout)
	if err != nil {
		return fmt.Errorf("winget uninstall failed: %w", err)
	}

	if exitCode != 0 {
		combined := strings.TrimSpace(stdout + "\n" + stderr)
		return fmt.Errorf("winget uninstall failed (exit %d): %s", exitCode, combined)
	}

	return nil
}

// GetInstalled returns installed packages from winget.
func (w *WingetProvider) GetInstalled() ([]InstalledPatch, error) {
	stdout, stderr, exitCode, err := w.exec("winget", []string{
		"list",
		"--accept-source-agreements",
		"--disable-interactivity",
	}, wingetScanTimeout)
	if err != nil {
		return nil, fmt.Errorf("winget list failed: %w", err)
	}
	if exitCode != 0 && stdout == "" {
		return nil, fmt.Errorf("winget list failed (exit %d): %s", exitCode, strings.TrimSpace(stderr))
	}

	return parseWingetListOutput(stdout), nil
}

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
