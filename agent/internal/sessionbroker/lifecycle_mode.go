package sessionbroker

// LifecycleMode selects how the helper lifecycle computes its desired set.
// Always-on (the historical behavior, and the only mode off Windows Server)
// spawns helpers proactively for every eligible session. On-demand — the
// default on RD Session Hosts — spawns nothing at rest: helpers exist only
// while an operation holds a lease on their session (see lifecycle_lease.go).
type LifecycleMode string

const (
	LifecycleModeAlwaysOn LifecycleMode = "always-on"
	LifecycleModeOnDemand LifecycleMode = "on-demand"
)

// Windows suite-mask bits (winnt.h). VER_SUITE_TERMINAL alone means the RD
// Session Host role is installed; every modern Windows sets it together with
// VER_SUITE_SINGLEUSERTS for the built-in 2-session remote admin mode, so a
// true multi-session host is TERMINAL && !SINGLEUSERTS.
const (
	verSuiteTerminal     uint16 = 0x0010
	verSuiteSingleUserTS uint16 = 0x0100
)

func isRDSSuiteMask(suiteMask uint16) bool {
	return suiteMask&verSuiteTerminal != 0 && suiteMask&verSuiteSingleUserTS == 0
}

// resolveLifecycleMode maps the config override ("always-on" | "on-demand" |
// "auto" | "") plus the host detection result to the operating mode. Unknown
// override values behave as auto so a typo in a config file degrades to the
// sensible default instead of forcing a mode.
func resolveLifecycleMode(override string, rdsHost bool) LifecycleMode {
	switch override {
	case string(LifecycleModeAlwaysOn):
		return LifecycleModeAlwaysOn
	case string(LifecycleModeOnDemand):
		return LifecycleModeOnDemand
	}
	if rdsHost {
		return LifecycleModeOnDemand
	}
	return LifecycleModeAlwaysOn
}
