//go:build windows

package collectors

import (
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// getLinkSpeed returns the link speed in bits/sec for the named interface on Windows.
// Uses PowerShell Get-NetAdapter to query the link speed. Returns 0 if unavailable.
func getLinkSpeed(ifaceName string) uint64 {
	// Get-NetAdapter returns speed in bits/sec via LinkSpeed or ReceiveLinkSpeed
	out, err := exec.Command("powershell", "-NoProfile", "-Command",
		`Get-NetAdapter -Name '`+sanitizeIfaceName(ifaceName)+`' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ReceiveLinkSpeed`,
	).Output()
	if err != nil {
		// Fallback: try by InterfaceDescription which sometimes matches gopsutil names
		out, err = exec.Command("powershell", "-NoProfile", "-Command",
			`Get-NetAdapter -InterfaceDescription '`+sanitizeIfaceName(ifaceName)+`' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ReceiveLinkSpeed`,
		).Output()
		if err != nil {
			return 0
		}
	}

	bps, err := strconv.ParseUint(strings.TrimSpace(string(out)), 10, 64)
	if err != nil {
		return 0
	}

	return bps
}

// sanitizeIfaceNameRe strips characters that could escape a PowerShell single-quoted string.
var sanitizeIfaceNameRe = regexp.MustCompile(`[^a-zA-Z0-9 \-_\.\(\)#]`)

// sanitizeIfaceName removes characters unsafe for PowerShell single-quoted strings.
func sanitizeIfaceName(name string) string {
	return sanitizeIfaceNameRe.ReplaceAllString(name, "")
}
