package hwhealth

import (
	"strings"
	"testing"
)

func TestVendorStates(t *testing.T) {
	// Mirrors HARDWARE_STATES in index §B / packages/shared/src/constants/hardwareHealth.ts.
	allowed := map[ComponentType]string{
		"controller":    "ok degraded failed unknown",
		"virtual_disk":  "optimal rebuilding initializing checking migrating degraded partially_degraded failed offline unknown",
		"physical_disk": "online hotspare ready jbod unconfigured rebuilding copyback foreign shielded predictive_failure degraded failed missing offline unknown",
		"cache_battery": "ok charging learning degraded failed missing unknown",
	}
	// Explicit expected mappings, independent of the implementation map.
	rows := []struct {
		source    Kind
		typ       ComponentType
		raw, want string
	}{
		{"megacli", "virtual_disk", "Optimal|Degraded|Partially Degraded|Offline", "optimal|degraded|partially_degraded|offline"},
		{"megacli", "virtual_disk", "Rebuild|Consistency Check|Initialization", "rebuilding|checking|initializing"},
		{"megacli", "physical_disk", "Online, Spun Up|Hotspare, Spun Up|Unconfigured(good)|Unconfigured(bad)|Rebuild|Copyback|Failed|Offline|JBOD", "online|hotspare|ready|failed|rebuilding|copyback|failed|offline|jbod"},
		{"megacli", "cache_battery", "Optimal|Learn Cycle Active|Battery Replacement required|Pack is about to fail|Degraded", "ok|learning|failed|failed|degraded"},
		{"ssacli", "controller", "OK|Failed|Temporarily Disabled|Permanently Disabled", "ok|failed|degraded|degraded"},
		{"ssacli", "cache_battery", "OK|Recharging|Failed|Not Present", "ok|charging|failed|missing"},
		{"ssacli", "virtual_disk", "OK|Interim Recovery Mode|Failed|Recovering|Rebuilding|Ready for Rebuild|Transforming|Queued for Expansion|In Progress", "optimal|degraded|failed|rebuilding|rebuilding|rebuilding|migrating|migrating|initializing"},
		{"ssacli", "physical_disk", "OK|Predictive Failure|Failed|Rebuilding|Erasing|Spare Drive", "online|predictive_failure|failed|rebuilding|online|hotspare"},
		{"arcconf", "virtual_disk", "Optimal|Degraded|Suboptimal, Fault Tolerant|Failed|Impacted|Rebuilding", "optimal|degraded|degraded|failed|failed|rebuilding"},
		{"arcconf", "physical_disk", "Online|Hot Spare|Ready|Failed|Rebuilding|Raw (Pass Through)", "online|hotspare|ready|failed|rebuilding|jbod"},
		{"arcconf", "cache_battery", "Optimal|Charging|Not Installed|Failed", "ok|charging|missing|failed"},
		{"omreport", "virtual_disk", "Ready|Degraded|Failed|Background Initialization|Resynching|Regenerating|Formatting", "optimal|degraded|failed|initializing|rebuilding|rebuilding|initializing"},
		{"omreport", "physical_disk", "Online|Ready|Failed|Foreign|Blocked|Non-RAID|Rebuilding|Removed", "online|ready|failed|foreign|offline|jbod|rebuilding|missing"},
		{"omreport", "cache_battery", "Ready|Degraded|Failed|Charging|Learning|Missing", "ok|degraded|failed|charging|learning|missing"},
		{"zfs", "virtual_disk", "ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED|scrub|resilver", "optimal|degraded|failed|offline|failed|failed|checking|rebuilding"},
		{"zfs", "physical_disk", "ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED", "online|degraded|failed|offline|missing|missing"},
	}
	for _, row := range rows {
		wants := strings.Split(row.want, "|")
		for i, raw := range strings.Split(row.raw, "|") {
			t.Run(string(row.source)+"/"+string(row.typ)+"/"+raw, func(t *testing.T) {
				got := remainingVendorState(row.source, row.typ, raw)
				if got != wants[i] {
					t.Fatalf("%q maps to %q, want %q", raw, got, wants[i])
				}
				if !strings.Contains(" "+allowed[row.typ]+" ", " "+got+" ") {
					t.Fatal("outside HARDWARE_STATES:", got)
				}
			})
		}
		if remainingVendorState(row.source, row.typ, "future vendor state") != "unknown" {
			t.Fatal("fallback must be unknown")
		}
	}
}
