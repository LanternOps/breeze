package tools

import (
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/collectors"
)

// softwareInventoryFn is the enumeration used to verify an uninstall's
// post-condition. It is the SAME collector the agent reports to
// /api/v1/agents/{id}/software from, which is what makes the check meaningful:
// "still installed" here means "the next inventory report will still list it".
// Indirected for tests.
var softwareInventoryFn = func() ([]collectors.SoftwareItem, error) {
	return collectors.Guard("software", collectors.NewSoftwareCollector().Collect)
}

// normalizeSoftwareNameForMatch makes the uninstall payload's name comparable to
// an inventory entry's DisplayName. macOS uninstall targets arrive as either
// "Foo" or "Foo.app" while system_profiler reports "Foo", so the .app suffix is
// stripped from both sides.
func normalizeSoftwareNameForMatch(name string) string {
	trimmed := strings.ToLower(strings.TrimSpace(name))
	return strings.TrimSuffix(trimmed, ".app")
}

// softwareStillInstalled reports whether software named `name` is still visible
// in this device's software inventory.
//
// Matching is exact (case-insensitive, trimmed) rather than substring: the name
// handed to an uninstall command originates from a software_inventory row, so an
// exact match is available, and substring matching would report "Teams" as still
// installed because "Microsoft Teams Meeting Add-in" remains.
//
// A collector error is returned to the caller rather than being flattened to
// false — "we could not look" must not be mistaken for "it is gone".
func softwareStillInstalled(name string) (bool, error) {
	target := normalizeSoftwareNameForMatch(name)
	if target == "" {
		return false, nil
	}

	installed, err := softwareInventoryFn()
	if err != nil {
		return false, err
	}

	// An endpoint with zero installed software is not a real state — it means
	// the enumeration did not work. The Linux collector in particular returns an
	// empty list with a nil error when neither dpkg-query nor rpm is usable
	// (software_linux.go), and treating that as "verified absent" would let the
	// uninstall post-condition pass without ever having looked.
	if len(installed) == 0 {
		return false, fmt.Errorf("software inventory came back empty; cannot verify removal")
	}

	for _, item := range installed {
		if normalizeSoftwareNameForMatch(item.Name) == target {
			return true, nil
		}
	}
	return false, nil
}
