package peripheral

import (
	"sync/atomic"
	"testing"
)

func blockStorageV2Policy() []PeripheralPolicyV2 {
	return []PeripheralPolicyV2{{
		PolicyID: "11111111-1111-4111-8111-111111111111", Source: "organization",
		EffectiveClass: "storage", ConfiguredClass: "storage", Action: "block", Exceptions: []ExceptionRule{},
	}}
}

// #9618: protocol-2 agents never reported what they found, so the Activity Log,
// the device Peripherals tab and the peripheral.blocked alert stayed empty.
func TestApplyPeripheralPolicyV2WithEventsReportsTheEnforcedScan(t *testing.T) {
	store := newV2TestStore(t)
	envelope := testV2Envelope(t, 1, "enforce", blockStorageV2Policy())
	var detects atomic.Int32
	got, events := ApplyPeripheralPolicyV2WithEvents(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{}))
	if got.Outcome != "applied" {
		t.Fatalf("result = %+v", got)
	}
	if len(events) != 1 {
		t.Fatalf("events = %+v, want one per detected peripheral", events)
	}
	ev := events[0]
	if ev.EventType != "blocked" || ev.PolicyID != envelope.EffectivePolicies[0].PolicyID {
		t.Fatalf("event = %+v, want a blocked event naming the winning policy", ev)
	}
	if ev.Details["enforcement"] != "blocked" || ev.Details["policyRevision"] != 1 {
		t.Fatalf("details = %+v", ev.Details)
	}
	if _, ok := ev.Details["policyName"]; ok {
		t.Fatalf("details carry the synthetic v2 policy name (the policy id): %+v", ev.Details)
	}
	if ev.EventID == "" || ev.OccurredAt.IsZero() {
		t.Fatalf("event lacks id/time: %+v", ev)
	}
}

func TestApplyPeripheralPolicyV2WithEventsReportsUncoveredPeripheralsAsConnected(t *testing.T) {
	store := newV2TestStore(t)
	envelope := testV2Envelope(t, 1, "enforce", []PeripheralPolicyV2{})
	var detects atomic.Int32
	got, events := ApplyPeripheralPolicyV2WithEvents(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{}))
	if got.Outcome != "applied" || len(events) != 1 || events[0].EventType != "connected" || events[0].PolicyID != "" {
		t.Fatalf("result=%+v events=%+v", got, events)
	}
}

func TestApplyPeripheralPolicyV2WithEventsReportsNothingWithoutAFreshScan(t *testing.T) {
	t.Run("rejected", func(t *testing.T) {
		store := newV2TestStore(t)
		envelope := testV2Envelope(t, 1, "enforce", blockStorageV2Policy())
		var detects atomic.Int32
		got, events := ApplyPeripheralPolicyV2WithEvents(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{unverified: true}))
		if got.Outcome != "rejected" || len(events) != 0 {
			t.Fatalf("result=%+v events=%+v", got, events)
		}
	})
	t.Run("same revision redelivery", func(t *testing.T) {
		store := newV2TestStore(t)
		envelope := testV2Envelope(t, 1, "enforce", blockStorageV2Policy())
		var detects atomic.Int32
		if got, _ := ApplyPeripheralPolicyV2WithEvents(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{})); got.Outcome != "applied" {
			t.Fatalf("first apply = %+v", got)
		}
		got, events := ApplyPeripheralPolicyV2WithEvents(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{}))
		if got.Outcome != "applied" || len(events) != 0 {
			t.Fatalf("redelivery result=%+v events=%+v", got, events)
		}
	})
	t.Run("clear legacy", func(t *testing.T) {
		store := newV2TestStore(t)
		envelope := testV2Envelope(t, 1, "clear_legacy", []PeripheralPolicyV2{})
		var detects atomic.Int32
		got, events := ApplyPeripheralPolicyV2WithEvents(envelope, envelope.Identity, store, testV2Deps(&detects, &v2TestEnforcer{}))
		if got.Outcome != "applied" || len(events) != 0 {
			t.Fatalf("result=%+v events=%+v", got, events)
		}
	})
}
