package collectors

// This file intentionally carries no build constraint (the trailing
// "_category" keeps Go's filename GOOS matching from applying) so the
// Windows System-log classification can be unit-tested on macOS/Linux CI.

import "strings"

// hardwareSystemLogProviders are Windows System-log providers whose errors
// describe physical storage, filesystem integrity, or machine-check faults.
// Keys are lowercase with any "Microsoft-Windows-" prefix removed.
var hardwareSystemLogProviders = map[string]bool{
	"disk":        true,
	"ntfs":        true,
	"volmgr":      true,
	"volsnap":     true,
	"storahci":    true,
	"stornvme":    true,
	"whea-logger": true,
	"kernel-whea": true,
}

// classifySystemLogEntry maps a Windows System-log entry to the "hardware" or
// "system" event-log category. Classification is currently provider-based;
// eventID is accepted so ID-specific rules can be added without changing
// callers. Anything not recognised as a hardware provider is "system".
func classifySystemLogEntry(provider string, eventID int) string {
	_ = eventID
	p := strings.ToLower(strings.TrimSpace(provider))
	p = strings.TrimPrefix(p, "microsoft-windows-")
	switch {
	case hardwareSystemLogProviders[p]:
		return "hardware"
	case strings.HasPrefix(p, "iastor"): // Intel RST: iaStorA, iaStorAC, iaStorAVC, iaStorV
		return "hardware"
	case strings.Contains(p, "thermal"):
		return "hardware"
	default:
		return "system"
	}
}

// systemLogQueryEnabled reports whether the Windows System-log error query
// should run: its entries are split between "hardware" and "system", so it is
// needed when either category is enabled.
func systemLogQueryEnabled(categories []string) bool {
	return categoryEnabled(categories, "hardware") || categoryEnabled(categories, "system")
}

// systemLogCategoryFor classifies a System-log entry and reports whether its
// derived category is enabled in the policy (i.e. whether to keep it).
func systemLogCategoryFor(categories []string, provider string, eventID int) (string, bool) {
	category := classifySystemLogEntry(provider, eventID)
	return category, categoryEnabled(categories, category)
}
