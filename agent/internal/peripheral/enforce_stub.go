//go:build !windows

package peripheral

// stubEnforcer is the non-Windows enforcer: detection/eval still run, but no OS
// enforcement is applied. Every action reports alert_only via Applied=false.
type stubEnforcer struct{}

func NewEnforcer() Enforcer { return stubEnforcer{} }

func (stubEnforcer) ApplyGate(string, bool) EnforceOutcome {
	return EnforceOutcome{Mechanism: "unsupported", Applied: false, Verified: false, Detail: "enforcement not implemented on this OS"}
}
func (stubEnforcer) RevertGate(string) EnforceOutcome { return EnforceOutcome{Mechanism: "unsupported"} }
func (stubEnforcer) DisableDevice(string) EnforceOutcome {
	return EnforceOutcome{Mechanism: "unsupported", Applied: false, Verified: false, Detail: "enforcement not implemented on this OS"}
}
func (stubEnforcer) ApplyReadOnly(string) EnforceOutcome {
	return EnforceOutcome{Mechanism: "unsupported", Applied: false, Verified: false, Detail: "enforcement not implemented on this OS"}
}
func (stubEnforcer) RevertReadOnly(string) EnforceOutcome {
	return EnforceOutcome{Mechanism: "unsupported"}
}
