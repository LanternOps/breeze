package peripheral

// enforceableClasses are the only device classes Tier 1 enforces on Windows.
// Bluetooth and Thunderbolt block/read_only actions remain alert-only.
var enforceableClasses = map[string]bool{"storage": true, "all_usb": true}

// ClassGate describes a class-wide block to apply. HasExceptions disables the
// machine-wide durable gate (it would over-block the excepted device).
type ClassGate struct {
	Class         string
	HasExceptions bool
}

// EnforcementPlan is the OS-independent desired state derived from the current
// policy set and the current scan. It is recomputed on every policy sync.
type EnforcementPlan struct {
	BlockGates         []ClassGate
	DisableInstanceIDs []string
	ReadOnlyClasses    []string
}

// planEnforcement computes the desired enforcement state. Pure function: no OS calls.
func planEnforcement(results []EvaluationResult, policies []Policy) EnforcementPlan {
	plan := EnforcementPlan{}

	// Gates come from the policy set (a block policy with no connected device
	// must still arm the gate). Dedup by class.
	gateSeen := map[string]bool{}
	for i := range policies {
		p := &policies[i]
		if !p.IsActive || !enforceableClasses[p.DeviceClass] {
			continue
		}
		switch p.Action {
		case "block":
			if !gateSeen[p.DeviceClass] {
				gateSeen[p.DeviceClass] = true
				plan.BlockGates = append(plan.BlockGates, ClassGate{
					Class:         p.DeviceClass,
					HasExceptions: hasAllowException(p.Exceptions),
				})
			}
		case "read_only":
			if !containsStr(plan.ReadOnlyClasses, p.DeviceClass) {
				plan.ReadOnlyClasses = append(plan.ReadOnlyClasses, p.DeviceClass)
			}
		}
	}

	// Per-device disable comes from the scan: only devices that evaluated to
	// "block" (excepted devices evaluate to "allow" and are skipped).
	for _, r := range results {
		if r.Action == "block" && enforceableClasses[r.Peripheral.DeviceClass] && r.Peripheral.DeviceID != "" {
			plan.DisableInstanceIDs = append(plan.DisableInstanceIDs, r.Peripheral.DeviceID)
		}
	}
	return plan
}

func hasAllowException(exceptions []ExceptionRule) bool {
	for i := range exceptions {
		if exceptions[i].Allow {
			return true
		}
	}
	return false
}

func containsStr(xs []string, v string) bool {
	for _, x := range xs {
		if x == v {
			return true
		}
	}
	return false
}
