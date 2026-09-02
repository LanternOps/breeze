package heartbeat

import (
	"errors"
	"testing"
)

func boolPtr(b bool) *bool { return &b }

func TestUACInterceptionFlag(t *testing.T) {
	tests := []struct {
		name        string
		sequence    []*bool // values passed to handleUACInterception in order
		wantEnabled bool
	}{
		{"default before any heartbeat is off (opt-in)", nil, false},
		{"nil from old server stays off (opt-in)", []*bool{nil}, false},
		{"explicit true enables", []*bool{boolPtr(true)}, true},
		{"explicit false stays off", []*bool{boolPtr(false)}, false},
		{"true then false disables", []*bool{boolPtr(true), boolPtr(false)}, false},
		{"true then nil disables (policy unassigned or old server)", []*bool{boolPtr(true), nil}, false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			h := &Heartbeat{pamLifetimeManager: &fakePamLifetimeManager{available: true}}
			h.pamReconciled.Store(true)
			h.pamReceivedObservationReady.Store(true)
			h.pamVerificationAvailable.Store(true)
			for _, v := range tt.sequence {
				h.handleUACInterception(v)
			}
			if got := h.IsUACInterceptionEnabled(); got != tt.wantEnabled {
				t.Fatalf("IsUACInterceptionEnabled() = %v, want %v", got, tt.wantEnabled)
			}
		})
	}
}

func TestUACDisableStopsCaptureButDoesNotReportDisabledUntilCleanupProof(t *testing.T) {
	manager := &fakePamLifetimeManager{setEnabledErr: errors.New("helper loss"), available: true}
	h := &Heartbeat{pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.uacInterceptionEnabled.Store(true)

	h.handleUACInterception(boolPtr(false))

	if h.IsUACInterceptionEnabled() {
		t.Fatal("capture remained enabled after disable request")
	}
	if len(manager.setEnabledCalls) != 1 || manager.setEnabledCalls[0] {
		t.Fatalf("manager disable calls = %v", manager.setEnabledCalls)
	}
	if got := h.pamLifetimeProtocolVersion(); got != 0 {
		t.Fatalf("capability after unverifiable disable = %d, want 0", got)
	}
}

func TestUACEnableWaitsForManagerProof(t *testing.T) {
	manager := &fakePamLifetimeManager{setEnabledErr: errors.New("ledger unresolved"), available: true}
	h := &Heartbeat{pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)

	h.handleUACInterception(boolPtr(true))

	if h.IsUACInterceptionEnabled() {
		t.Fatal("capture reported enabled after manager rejected enable")
	}
}

func TestUACDisableRetryRestoresCapabilityOnlyAfterCleanupProof(t *testing.T) {
	manager := &fakePamLifetimeManager{setEnabledErr: errors.New("helper loss"), available: true}
	h := &Heartbeat{pamLifetimeManager: manager}
	h.pamReconciled.Store(true)
	h.pamReceivedObservationReady.Store(true)
	h.pamVerificationAvailable.Store(true)
	h.uacInterceptionEnabled.Store(true)

	h.handleUACInterception(boolPtr(false))
	if got := h.pamLifetimeProtocolVersion(); got != 0 {
		t.Fatalf("capability after failed cleanup = %d, want 0", got)
	}
	manager.setEnabledErr = nil
	h.handleUACInterception(boolPtr(false))

	if got := h.pamLifetimeProtocolVersion(); got != 2 {
		t.Fatalf("capability after verified cleanup retry = %d, want 2", got)
	}
}
