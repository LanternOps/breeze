package security

import (
	"encoding/json"
	"errors"
	"testing"
)

// #7965: a failed AV or firewall collection must be reported as unknown
// (field omitted from the payload), never as a fabricated `false` that the
// API stores as a real "protection off" reading.

func TestAVRealTimeProtectionState(t *testing.T) {
	cases := []struct {
		name      string
		value     bool
		collected bool
		failed    bool
		want      *bool
	}{
		{"every AV source failed", false, false, true, nil},
		{"one source succeeded, another failed, protection off", false, true, true, boolPtr(false)},
		{"one source succeeded, another failed, protection on", true, true, true, boolPtr(true)},
		{"source succeeded, protection off", false, true, false, boolPtr(false)},
		{"no AV source applies and none failed", false, false, false, boolPtr(false)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := avRealTimeProtectionState(tc.value, tc.collected, tc.failed)
			assertBoolPtr(t, got, tc.want)
		})
	}
}

func TestFirewallState(t *testing.T) {
	assertBoolPtr(t, firewallState(false, errors.New("netsh failed")), nil)
	assertBoolPtr(t, firewallState(true, errors.New("partial")), nil)
	assertBoolPtr(t, firewallState(false, ErrNotSupported), nil)
	assertBoolPtr(t, firewallState(false, nil), boolPtr(false))
	assertBoolPtr(t, firewallState(true, nil), boolPtr(true))
}

func TestSecurityStatusJSONOmitsUnknownFields(t *testing.T) {
	raw, err := json.Marshal(SecurityStatus{Provider: "other", EncryptionStatus: "unknown"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"realTimeProtection", "firewallEnabled"} {
		if _, ok := decoded[key]; ok {
			t.Errorf("%s present in payload for an uncollected status: %s", key, raw)
		}
	}

	raw, err = json.Marshal(SecurityStatus{RealTimeProtection: boolPtr(false), FirewallEnabled: boolPtr(false)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	decoded = map[string]any{}
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, key := range []string{"realTimeProtection", "firewallEnabled"} {
		if v, ok := decoded[key]; !ok || v != false {
			t.Errorf("%s = %v (present=%v), want a genuine false to be sent: %s", key, v, ok, raw)
		}
	}
}

func assertBoolPtr(t *testing.T, got, want *bool) {
	t.Helper()
	switch {
	case want == nil && got != nil:
		t.Fatalf("got %v, want nil (unknown)", *got)
	case want != nil && got == nil:
		t.Fatalf("got nil, want %v", *want)
	case want != nil && *got != *want:
		t.Fatalf("got %v, want %v", *got, *want)
	}
}
