package heartbeat

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/peripheral"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

func TestPeripheralPolicyV2HandlerPassesPersistedIdentity(t *testing.T) {
	originalApply := applyPeripheralPolicyV2
	originalStore := newPeripheralPolicyV2Store
	t.Cleanup(func() {
		applyPeripheralPolicyV2 = originalApply
		newPeripheralPolicyV2Store = originalStore
	})
	newPeripheralPolicyV2Store = func() *peripheral.Store { return peripheral.NewStore() }
	var gotIdentity peripheral.PeripheralPolicyIdentityV2
	applyPeripheralPolicyV2 = func(envelope peripheral.PeripheralPolicyEnvelopeV2, local peripheral.PeripheralPolicyIdentityV2, _ *peripheral.Store, _ peripheral.PolicyV2Dependencies) (peripheral.PeripheralPolicyResultV2, []peripheral.PeripheralEvent) {
		gotIdentity = local
		return peripheral.PeripheralPolicyResultV2{SchemaVersion: 2, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, Outcome: "applied"}, nil
	}
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1"}}
	result := handlePeripheralPolicySyncV2(h, peripheralV2TestCommand())
	if result.Status != "completed" {
		t.Fatalf("status=%s error=%s", result.Status, result.Error)
	}
	if gotIdentity.DeviceID != "device-1" || gotIdentity.OrgID != "org-1" || gotIdentity.SiteID != "site-1" {
		t.Fatalf("identity = %+v", gotIdentity)
	}
	var payload peripheral.PeripheralPolicyResultV2
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil || payload.Outcome != "applied" {
		t.Fatalf("stdout=%q payload=%+v err=%v", result.Stdout, payload, err)
	}
	structured, ok := result.Result.(peripheral.PeripheralPolicyResultV2)
	if !ok || structured.Outcome != "applied" {
		t.Fatalf("HTTP structured result = %#v", result.Result)
	}
}

func peripheralV2TestCommand() Command {
	return Command{ID: "cmd-1", Type: tools.CmdPeripheralPolicySyncV2, Payload: map[string]any{
		"schemaVersion": 2, "phase": "enforce", "identity": map[string]any{"deviceId": "device-1", "orgId": "org-1", "siteId": "site-1", "groupIds": []any{}},
		"revision": 1, "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "generatedAt": "2026-08-25T00:00:00Z", "reason": "test", "effectivePolicies": []any{},
	}}
}

// stubPeripheralV2Apply makes the applier return an applied result plus the
// given events, and records every submission the handler makes.
func stubPeripheralV2Apply(t *testing.T, events []peripheral.PeripheralEvent, submitErr error) *[][]peripheral.PeripheralEvent {
	t.Helper()
	originalApply := applyPeripheralPolicyV2
	originalStore := newPeripheralPolicyV2Store
	originalSubmit := submitPeripheralEventsV2
	t.Cleanup(func() {
		applyPeripheralPolicyV2 = originalApply
		newPeripheralPolicyV2Store = originalStore
		submitPeripheralEventsV2 = originalSubmit
	})
	newPeripheralPolicyV2Store = func() *peripheral.Store { return peripheral.NewStore() }
	applyPeripheralPolicyV2 = func(envelope peripheral.PeripheralPolicyEnvelopeV2, _ peripheral.PeripheralPolicyIdentityV2, _ *peripheral.Store, _ peripheral.PolicyV2Dependencies) (peripheral.PeripheralPolicyResultV2, []peripheral.PeripheralEvent) {
		return peripheral.PeripheralPolicyResultV2{SchemaVersion: 2, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, Outcome: "applied"}, events
	}
	var submitted [][]peripheral.PeripheralEvent
	submitPeripheralEventsV2 = func(_ *Heartbeat, got []peripheral.PeripheralEvent) error {
		submitted = append(submitted, got)
		return submitErr
	}
	return &submitted
}

// #9618: the v2 handler is the only peripheral path a current agent runs, and
// it never submitted events, so peripheral_events stayed empty fleet-wide.
func TestPeripheralPolicyV2HandlerSubmitsTheScanEvents(t *testing.T) {
	events := []peripheral.PeripheralEvent{{EventType: "blocked", PeripheralType: "usb", PolicyID: "pol-1", OccurredAt: time.Now()}}
	submitted := stubPeripheralV2Apply(t, events, nil)
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1"}}

	result := handlePeripheralPolicySyncV2(h, peripheralV2TestCommand())

	if result.Status != "completed" {
		t.Fatalf("status=%s error=%s", result.Status, result.Error)
	}
	if len(*submitted) != 1 || len((*submitted)[0]) != 1 || (*submitted)[0][0].EventType != "blocked" {
		t.Fatalf("submitted = %+v, want the one blocked event", *submitted)
	}
}

func TestPeripheralPolicyV2HandlerSubmitFailureKeepsTheAppliedResult(t *testing.T) {
	events := []peripheral.PeripheralEvent{{EventType: "connected", PeripheralType: "usb", OccurredAt: time.Now()}}
	submitted := stubPeripheralV2Apply(t, events, errors.New("HTTP 503"))
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1"}}

	result := handlePeripheralPolicySyncV2(h, peripheralV2TestCommand())

	// The policy WAS applied and persisted on the device; a reporting failure
	// must not turn that into a rejected/failed delivery on the server.
	structured, ok := result.Result.(peripheral.PeripheralPolicyResultV2)
	if result.Status != "completed" || !ok || structured.Outcome != "applied" {
		t.Fatalf("status=%s result=%#v", result.Status, result.Result)
	}
	if len(*submitted) != 1 {
		t.Fatalf("submit attempts = %d, want 1", len(*submitted))
	}
}

func TestPeripheralPolicyV2HandlerSkipsSubmitWithoutEvents(t *testing.T) {
	submitted := stubPeripheralV2Apply(t, nil, nil)
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1"}}

	if result := handlePeripheralPolicySyncV2(h, peripheralV2TestCommand()); result.Status != "completed" {
		t.Fatalf("status=%s error=%s", result.Status, result.Error)
	}
	if len(*submitted) != 0 {
		t.Fatalf("submitted %d batches for an empty scan", len(*submitted))
	}
}

func TestPeripheralPolicyV2HandlerRejectsUnknownFields(t *testing.T) {
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1"}}
	result := handlePeripheralPolicySyncV2(h, Command{Payload: map[string]any{"schemaVersion": 2, "unexpected": true}})
	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
}
