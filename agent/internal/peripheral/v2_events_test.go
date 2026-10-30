package peripheral

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
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

// The API's submitPeripheralEventsSchema requires peripheralType and an
// RFC 3339 occurredAt; eventId is the dedupe key (org, device, eventId), so it
// must differ between two revisions applied within the same second.
func TestApplyPeripheralPolicyV2WithEventsWireShape(t *testing.T) {
	store := newV2TestStore(t)
	deps := PolicyV2Dependencies{
		Detect: func() ([]DetectedPeripheral, error) {
			return []DetectedPeripheral{{PeripheralType: "usb", Vendor: "SanDisk", Product: "Cruzer", SerialNumber: "SN1", DeviceClass: "storage", DeviceID: "usb-1"}}, nil
		},
		Enforcer: &v2TestEnforcer{},
		Classes:  []string{"storage"},
	}
	first := testV2Envelope(t, 1, "enforce", blockStorageV2Policy())
	_, firstEvents := ApplyPeripheralPolicyV2WithEvents(first, first.Identity, store, deps)
	second := testV2Envelope(t, 2, "enforce", []PeripheralPolicyV2{})
	_, secondEvents := ApplyPeripheralPolicyV2WithEvents(second, second.Identity, store, deps)
	if len(firstEvents) != 1 || len(secondEvents) != 1 {
		t.Fatalf("events = %+v / %+v", firstEvents, secondEvents)
	}
	if firstEvents[0].EventID == secondEvents[0].EventID {
		t.Fatalf("revisions 1 and 2 share event id %q; the second batch would be deduplicated away", firstEvents[0].EventID)
	}

	raw, err := json.Marshal(EventSubmission{Events: firstEvents})
	if err != nil {
		t.Fatal(err)
	}
	var wire struct {
		Events []map[string]any `json:"events"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	ev := wire.Events[0]
	for field, want := range map[string]any{"eventType": "blocked", "peripheralType": "usb", "vendor": "SanDisk", "product": "Cruzer", "serialNumber": "SN1", "policyId": first.EffectivePolicies[0].PolicyID} {
		if ev[field] != want {
			t.Errorf("%s = %v, want %v (wire event %v)", field, ev[field], want, ev)
		}
	}
	if id, _ := ev["eventId"].(string); id == "" || len(id) > 255 {
		t.Errorf("eventId = %q, want 1..255 chars", id)
	}
	if at, _ := ev["occurredAt"].(string); at == "" {
		t.Errorf("occurredAt missing")
	} else if _, err := time.Parse(time.RFC3339, at); err != nil {
		t.Errorf("occurredAt %q is not RFC 3339: %v", at, err)
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
