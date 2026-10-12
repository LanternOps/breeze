package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func pamReconcileCommand() Command {
	return Command{ID: "reset-command", Type: tools.CmdPamReconcileV2, Payload: map[string]any{
		"protocolVersion": 1, "deviceId": "device-1", "orgId": "org-1",
	}}
}

func TestPamReconcileResetChecksIdentityAndProtocol(t *testing.T) {
	for _, tt := range []struct {
		name  string
		key   string
		value any
	}{
		{"wrong device", "deviceId", "other-device"}, {"wrong org", "orgId", "other-org"},
		{"unknown protocol", "protocolVersion", 2}, {"force deletion rejected", "force", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			called := make(chan struct{}, 1)
			h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1"}, pamLifetimeManager: &fakePamLifetimeManager{available: true, reconcileStarted: called}}
			cmd := pamReconcileCommand()
			cmd.Payload[tt.key] = tt.value
			if result := handlePamReconcileV2(h, cmd); result.Status != "failed" {
				t.Fatalf("invalid request accepted: %+v", result)
			}
			if len(called) != 0 {
				t.Fatal("invalid request reached reconciliation")
			}
		})
	}
}

func TestPamReconcileResetRestoresOnlyVerifiedAvailability(t *testing.T) {
	for _, available := range []bool{false, true} {
		t.Run(map[bool]string{false: "unknown state stays closed", true: "clean state recovers"}[available], func(t *testing.T) {
			h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1"}, pamLifetimeManager: &fakePamLifetimeManager{available: available}}
			result := handlePamReconcileV2(h, pamReconcileCommand())
			want := "failed"
			if available {
				want = "completed"
			}
			if result.Status != want {
				t.Fatalf("reset status=%s want %s: %+v", result.Status, want, result)
			}
			if h.pamVerificationAvailable.Load() != available {
				t.Fatal("reset overrode manager proof")
			}
			if h.IsUACInterceptionEnabled() {
				t.Fatal("reset enabled interception without a policy")
			}
		})
	}
}

func TestPamReconcileResetDoesNotDiscardQuarantinedOutbox(t *testing.T) {
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1"}, pamLifetimeManager: &fakePamLifetimeManager{available: true}}
	h.pamReconciliationOutbox = newPamReconciliationOutbox(t.TempDir())
	// Existing outbox behavior owns unreadable-file validation; a quarantined
	// entry must continue blocking received-observation readiness after reset.
	observation := testPamObservation("11111111-1111-4111-8111-111111111111")
	const commandID = "22222222-2222-4222-8222-222222222222"
	if err := h.pamReconciliationOutbox.Enqueue(commandID, observation); err != nil {
		t.Fatal(err)
	}
	if err := h.pamReconciliationOutbox.Quarantine(commandID, observation.ObservationID, "unknown binding"); err != nil {
		t.Fatal(err)
	}
	result := handlePamReconcileV2(h, pamReconcileCommand())
	if result.Status != "failed" || h.pamReceivedObservationReady.Load() {
		t.Fatalf("quarantine bypassed: %+v", result)
	}
	snapshot, err := h.pamReconciliationOutbox.Snapshot()
	if err != nil || len(snapshot.Quarantined) != 1 {
		t.Fatalf("quarantine discarded: %+v %v", snapshot, err)
	}
}
