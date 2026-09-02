package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	rollbackstate "github.com/breeze-rmm/agent/internal/rollback"
)

type fakeRollbackController struct {
	executed     []rollbackstate.Directive
	executeErr   error
	pending      *rollbackstate.Observation
	acknowledged string
}

func (f *fakeRollbackController) Active() bool { return false }

func (f *fakeRollbackController) Execute(_ context.Context, d rollbackstate.Directive) error {
	f.executed = append(f.executed, d)
	return f.executeErr
}
func (f *fakeRollbackController) Reconcile(context.Context) error { return nil }
func (f *fakeRollbackController) PendingObservation() (*rollbackstate.Observation, error) {
	return f.pending, nil
}
func (f *fakeRollbackController) Acknowledge(id string) error { f.acknowledged = id; return nil }

func TestHandleAgentRollbackStrictlyDecodesAndDispatches(t *testing.T) {
	controller := &fakeRollbackController{}
	h := &Heartbeat{rollbackController: controller}
	result := handleAgentRollback(h, Command{Payload: map[string]any{"schemaVersion": float64(1), "rollbackId": "rollback-1"}})
	if result.Status != "completed" || len(controller.executed) != 1 || controller.executed[0].RollbackID != "rollback-1" {
		t.Fatalf("result=%+v executed=%+v", result, controller.executed)
	}

	result = handleAgentRollback(h, Command{Payload: map[string]any{"schemaVersion": float64(1), "rollbackId": "rollback-2", "unexpected": true}})
	if result.Status != "failed" || len(controller.executed) != 1 {
		t.Fatal("unknown directive field was not rejected before execution")
	}

	controller.executeErr = errors.New("denied")
	result = handleAgentRollback(h, Command{Payload: map[string]any{"schemaVersion": float64(1), "rollbackId": "rollback-3"}})
	if result.Status != "failed" {
		t.Fatal("executor rejection was not returned")
	}
}

func TestRollbackObservationPersistsOnWireUntilAcknowledged(t *testing.T) {
	observation := &rollbackstate.Observation{SchemaVersion: 1, ObservationID: "observation-1", RollbackID: "rollback-1", DeviceID: "device-1", Phase: rollbackstate.PhaseRestartRequested, CurrentVersion: "2.0.0", ComponentVersions: map[string]string{"agent": "1.9.0"}, ObservedAt: time.Unix(1, 0).UTC(), ErrorCode: "restart_failed"}
	payload, err := json.Marshal(HeartbeatPayload{Status: "ok", AgentVersion: "2.0.0", RollbackObservation: observation})
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["rollbackObservation"] == nil {
		t.Fatal("pending rollback observation omitted from heartbeat wire payload")
	}
	wire := decoded["rollbackObservation"].(map[string]any)
	if wire["targetVersion"] != nil || wire["failureCode"] != nil {
		t.Fatalf("non-frozen rollback fields leaked onto wire: %+v", wire)
	}
	if wire["errorCode"] != "restart_failed" || wire["componentVersions"].(map[string]any)["agent"] != "1.9.0" {
		t.Fatalf("frozen rollback fields missing from wire: %+v", wire)
	}
	controller := &fakeRollbackController{pending: observation}
	h := &Heartbeat{rollbackController: controller}
	h.acknowledgeRollbackObservation("observation-1")
	if controller.acknowledged != "observation-1" {
		t.Fatalf("acknowledged=%q", controller.acknowledged)
	}
}
