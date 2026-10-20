package patching

import "strings"

// Provenance of AvailablePatch.Severity (#9387). Empty means the provider has
// no provenance to report (every non-Windows-Update provider today) or that
// the severity is "unknown".
const (
	// SeveritySourceVendor is a rating the vendor published for this update
	// (for Windows Update, IUpdate.MsrcSeverity).
	SeveritySourceVendor = "vendor"
	// SeveritySourceDerived is a rating the agent inferred from the update's
	// classification and title because the vendor published none. The UI
	// labels it as derived so nobody mistakes it for a vendor rating.
	SeveritySourceDerived = "derived"
)

// windowsSeverity resolves the severity and its provenance for a Windows
// Update entry.
//
// Microsoft's own MSRC rating always wins. Windows Update leaves
// IUpdate.MsrcSeverity empty for most of the volume, though — cumulative
// updates, drivers, Defender definitions and feature updates — which used to
// leave nearly every Microsoft row Unrated (#9387). When the rating is
// missing, derive one from the WUA classification (categoryNames carries the
// raw category names: classification plus product) and the title:
//
//   - Definition Updates, Drivers, Feature Packs, Tools and Upgrades never
//     carry a security rating and stay "unknown". This is checked first so a
//     "Security Intelligence Update for Microsoft Defender Antivirus"
//     (a definition update) does not pick up a rating from its title.
//   - Critical Updates → "critical"; Security Updates → "important".
//   - Update Rollups → "important" only when the title says "security"
//     (e.g. a Security Monthly Quality Rollup); otherwise "unknown".
//   - Any other classification → "important" when the title names a security
//     update or a (non-preview) cumulative update; otherwise "unknown".
//     Preview cumulative updates are the optional non-security releases.
//
// The derived value is a floor, not Microsoft's rating: a cumulative update
// that fixes a critical CVE still shows "important". Pulling exact per-KB
// ratings from MSRC server-side is a separate enhancement.
func windowsSeverity(msrcSeverity string, categoryNames []string, title string) (severity, source string) {
	switch s := strings.ToLower(strings.TrimSpace(msrcSeverity)); s {
	case "critical", "important", "moderate", "low":
		return s, SeveritySourceVendor
	}

	if derived := deriveWindowsSeverity(categoryNames, title); derived != "unknown" {
		return derived, SeveritySourceDerived
	}
	return "unknown", ""
}

// Classification names that never carry a security rating. Matched exactly
// (case-insensitively) so a product category such as "Microsoft Security
// Essentials" or a driver-servicing product name cannot trip them.
var unratedWindowsClassifications = map[string]bool{
	"definition updates": true,
	"drivers":            true,
	"feature packs":      true,
	"tools":              true,
	"upgrades":           true,
}

func deriveWindowsSeverity(categoryNames []string, title string) string {
	classifications := make(map[string]bool, len(categoryNames))
	for _, name := range categoryNames {
		classifications[strings.ToLower(strings.TrimSpace(name))] = true
	}

	for name := range classifications {
		if unratedWindowsClassifications[name] {
			return "unknown"
		}
	}
	if classifications["critical updates"] {
		return "critical"
	}
	if classifications["security updates"] {
		return "important"
	}

	t := strings.ToLower(title)
	if classifications["update rollups"] {
		if strings.Contains(t, "security") {
			return "important"
		}
		return "unknown"
	}
	if strings.Contains(t, "security update") {
		return "important"
	}
	if strings.Contains(t, "cumulative update") && !strings.Contains(t, "preview") {
		return "important"
	}
	return "unknown"
}
