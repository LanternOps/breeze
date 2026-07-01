package patching

import "strings"

// classifyWindowsUpdateCategory maps a Windows Update's category names to the
// single canonical category string Breeze uses downstream (patches.category,
// Update Ring category rules).
//
// It scans EVERY category name, not just the first, and returns the
// most-specific match. WUA attaches several categories to an update — e.g. a
// cumulative update can carry both a product category ("Windows 11") and a
// classification ("Security Updates"). Reading only index 0 (the previous
// behaviour) frequently landed on the product name and mislabelled the update
// as "application", so a ring's Security rule would miss real security updates.
//
// The returned values are kept in sync with the Update Ring category options
// (apps/web/src/components/patches/UpdateRingForm.tsx) and the approval
// evaluator (apps/api/src/services/patchApprovalEvaluator.ts): security,
// firmware, driver, definitions, feature, system, application.
func classifyWindowsUpdateCategory(names []string) string {
	// Ordered most-specific -> least-specific. The first rank with any matching
	// category name wins, so a "Security Updates" classification beats a generic
	// product-name category regardless of WUA ordering.
	ranked := []struct {
		category string
		match    func(string) bool
	}{
		{"security", func(n string) bool { return strings.Contains(n, "security") || strings.Contains(n, "critical") }},
		{"firmware", func(n string) bool { return strings.Contains(n, "firmware") }},
		{"driver", func(n string) bool { return strings.Contains(n, "driver") }},
		{"definitions", func(n string) bool { return strings.Contains(n, "definition") }},
		{"feature", func(n string) bool { return strings.Contains(n, "feature") }},
		{"system", func(n string) bool {
			return strings.Contains(n, "service pack") || strings.Contains(n, "update rollup")
		}},
	}

	lowered := make([]string, 0, len(names))
	for _, n := range names {
		lowered = append(lowered, strings.ToLower(n))
	}

	for _, r := range ranked {
		for _, n := range lowered {
			if r.match(n) {
				return r.category
			}
		}
	}

	return "application"
}
