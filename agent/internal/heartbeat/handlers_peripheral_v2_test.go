package heartbeat

import (
	"encoding/json"
	"testing"

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
	applyPeripheralPolicyV2 = func(envelope peripheral.PeripheralPolicyEnvelopeV2, local peripheral.PeripheralPolicyIdentityV2, _ *peripheral.Store, _ peripheral.PolicyV2Dependencies) peripheral.PeripheralPolicyResultV2 {
		gotIdentity = local
		return peripheral.PeripheralPolicyResultV2{SchemaVersion: 2, Phase: envelope.Phase, Revision: envelope.Revision, Digest: envelope.Digest, Outcome: "applied"}
	}
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1"}}
	result := handlePeripheralPolicySyncV2(h, Command{Type: tools.CmdPeripheralPolicySyncV2, Payload: map[string]any{
		"schemaVersion": 2, "phase": "enforce", "identity": map[string]any{"deviceId": "device-1", "orgId": "org-1", "siteId": "site-1", "groupIds": []any{}},
		"revision": 1, "digest": "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "generatedAt": "2026-08-25T00:00:00Z", "reason": "test", "effectivePolicies": []any{},
	}})
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

func TestPeripheralPolicyV2HandlerRejectsUnknownFields(t *testing.T) {
	h := &Heartbeat{config: &config.Config{DeviceID: "device-1", OrgID: "org-1", SiteID: "site-1"}}
	result := handlePeripheralPolicySyncV2(h, Command{Payload: map[string]any{"schemaVersion": 2, "unexpected": true}})
	if result.Status != "failed" {
		t.Fatalf("status = %q, want failed", result.Status)
	}
}
