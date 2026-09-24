package hwhealth

import "strings"

var remainingVendorStates = func() map[string]map[string]string {
	rows := []struct{ key, raw, normalized string }{
		{"megacli/controller", "Optimal|OK|Degraded|Failed", "ok|ok|degraded|failed"},
		{"megacli/virtual_disk", "Optimal|Degraded|Partially Degraded|Offline|Rebuild|Consistency Check|Initialization", "optimal|degraded|partially_degraded|offline|rebuilding|checking|initializing"},
		{"megacli/physical_disk", "Online, Spun Up|Hotspare, Spun Up|Unconfigured(good)|Unconfigured(bad)|Rebuild|Copyback|Failed|Offline|JBOD", "online|hotspare|ready|failed|rebuilding|copyback|failed|offline|jbod"},
		{"megacli/cache_battery", "Optimal|Learn Cycle Active|Battery Replacement required|Pack is about to fail|Degraded", "ok|learning|failed|failed|degraded"},
		{"ssacli/controller", "OK|Failed|Temporarily Disabled|Permanently Disabled", "ok|failed|degraded|degraded"},
		{"ssacli/cache_battery", "OK|Recharging|Failed|Not Present", "ok|charging|failed|missing"},
		{"ssacli/virtual_disk", "OK|Interim Recovery Mode|Failed|Recovering|Rebuilding|Ready for Rebuild|Transforming|Queued for Expansion|In Progress", "optimal|degraded|failed|rebuilding|rebuilding|rebuilding|migrating|migrating|initializing"},
		{"ssacli/physical_disk", "OK|Predictive Failure|Failed|Rebuilding|Erasing|Spare Drive", "online|predictive_failure|failed|rebuilding|online|hotspare"},
		{"arcconf/controller", "Optimal|OK|Degraded|Failed", "ok|ok|degraded|failed"},
		{"arcconf/virtual_disk", "Optimal|Degraded|Suboptimal, Fault Tolerant|Failed|Impacted|Rebuilding", "optimal|degraded|degraded|failed|failed|rebuilding"},
		{"arcconf/physical_disk", "Online|Hot Spare|Ready|Failed|Rebuilding|Raw (Pass Through)", "online|hotspare|ready|failed|rebuilding|jbod"},
		{"arcconf/cache_battery", "Optimal|Charging|Not Installed|Failed", "ok|charging|missing|failed"},
		{"omreport/controller", "Ok|Non-Critical|Critical|Failed|Degraded", "ok|degraded|failed|failed|degraded"},
		{"omreport/virtual_disk", "Ready|Degraded|Failed|Background Initialization|Resynching|Regenerating|Formatting", "optimal|degraded|failed|initializing|rebuilding|rebuilding|initializing"},
		{"omreport/physical_disk", "Online|Ready|Failed|Foreign|Blocked|Non-RAID|Rebuilding|Removed", "online|ready|failed|foreign|offline|jbod|rebuilding|missing"},
		{"omreport/cache_battery", "Ready|Degraded|Failed|Charging|Learning|Missing", "ok|degraded|failed|charging|learning|missing"},
		{"zfs/virtual_disk", "ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED|scrub|resilver", "optimal|degraded|failed|offline|failed|failed|checking|rebuilding"},
		{"zfs/physical_disk", "ONLINE|DEGRADED|FAULTED|OFFLINE|UNAVAIL|REMOVED", "online|degraded|failed|offline|missing|missing"},
	}
	out := make(map[string]map[string]string)
	for _, row := range rows {
		out[row.key] = make(map[string]string)
		values := strings.Split(row.normalized, "|")
		for i, raw := range strings.Split(row.raw, "|") {
			out[row.key][strings.ToLower(raw)] = values[i]
		}
	}
	return out
}()

func remainingVendorState(source Kind, typ ComponentType, raw string) string {
	if s := remainingVendorStates[string(source)+"/"+string(typ)][strings.ToLower(strings.TrimSpace(raw))]; s != "" {
		return s
	}
	return "unknown"
}
