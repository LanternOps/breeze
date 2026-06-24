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

// Plan exposes planEnforcement to other packages (the heartbeat handler).
func Plan(results []EvaluationResult, policies []Policy) EnforcementPlan {
	return planEnforcement(results, policies)
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

// EnforceOutcome records what one mechanism did and whether a post-write probe
// confirmed it. Applied=true means we set the block; Verified=false means the
// probe could NOT confirm it (caller should report alert_only, not success).
type EnforceOutcome struct {
	Mechanism string
	Applied   bool
	Verified  bool
	Detail    string
}

type DeviceOutcome struct {
	InstanceID string
	EnforceOutcome
}

type EnforcementOutcome struct {
	GateOutcomes     map[string]EnforceOutcome
	DeviceOutcomes   []DeviceOutcome
	ReadOnlyOutcomes map[string]EnforceOutcome
}

// Enforcer abstracts all OS-touching enforcement so the orchestrator is testable.
type Enforcer interface {
	ApplyGate(class string, hasExceptions bool) EnforceOutcome
	RevertGate(class string) EnforceOutcome
	DisableDevice(instanceID string) EnforceOutcome
	ApplyReadOnly(class string) EnforceOutcome
	RevertReadOnly(class string) EnforceOutcome
}

// Enforce converges the OS to `plan`. For every class in allClasses not covered
// by the plan, it reverts any prior gate/read-only so deleting a policy unblocks.
func Enforce(e Enforcer, plan EnforcementPlan, allClasses []string) EnforcementOutcome {
	out := EnforcementOutcome{
		GateOutcomes:     map[string]EnforceOutcome{},
		ReadOnlyOutcomes: map[string]EnforceOutcome{},
	}

	wantGate := map[string]ClassGate{}
	for _, g := range plan.BlockGates {
		wantGate[g.Class] = g
	}
	wantRO := map[string]bool{}
	for _, c := range plan.ReadOnlyClasses {
		wantRO[c] = true
	}

	// Revert before apply because multiple policy classes can map to the same
	// underlying OS resource (for example Windows USBSTOR gates). If a shared
	// resource is reverted after another class applies it, the revert clobbers
	// the desired block.
	for _, class := range allClasses {
		if _, ok := wantGate[class]; !ok {
			out.GateOutcomes[class] = e.RevertGate(class)
		}
		if !wantRO[class] {
			out.ReadOnlyOutcomes[class] = e.RevertReadOnly(class)
		}
	}

	for _, class := range allClasses {
		if g, ok := wantGate[class]; ok {
			out.GateOutcomes[class] = e.ApplyGate(class, g.HasExceptions)
		}
		if wantRO[class] {
			out.ReadOnlyOutcomes[class] = e.ApplyReadOnly(class)
		}
	}

	for _, id := range plan.DisableInstanceIDs {
		out.DeviceOutcomes = append(out.DeviceOutcomes, DeviceOutcome{
			InstanceID:     id,
			EnforceOutcome: e.DisableDevice(id),
		})
	}
	return out
}

// EnforceableClasses returns the classes Tier 1 manages, for the convergence
// revert sweep. Stable order for deterministic tests.
func EnforceableClasses() []string { return []string{"all_usb", "storage"} }
