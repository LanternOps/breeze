package websocket

import (
	"encoding/json"
	"testing"
)

// #11840 review: the remaining-time fields and the anchor echo are optional
// additions. A malformed one (not a number) must be treated as absent, so the
// absolute fields govern, rather than failing the whole decode and dropping a
// renewal the session needs.
func TestMalformedOptionalLeaseFieldFallsBackToTheAbsoluteFields(t *testing.T) {
	for _, field := range []string{"expiresInMs", "hardDeadlineInMs", "renewAnchor"} {
		for name, bad := range map[string]any{"string": "60000", "object": map[string]any{"x": 1}, "bool": true, "array": []any{1}, "null": nil} {
			t.Run(field+"/"+name, func(t *testing.T) {
				var got RevocationLeaseMessage
				delivered := false
				c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got, delivered = msg, true }}
				frame := map[string]any{
					"type": "revocation_lease", "sessionId": "s1",
					"expiresAt": 1234, "hardDeadline": 5678,
					"expiresInMs": 60000, "hardDeadlineInMs": 3600000,
				}
				frame[field] = bad
				raw, _ := json.Marshal(frame)
				c.handleRevocationLeaseMessage("revocation_lease", raw)
				if !delivered {
					t.Fatalf("a malformed %s must not drop the renewal", field)
				}
				if got.ExpiresAtUnixMs != 1234 || got.HardDeadlineUnixMs != 5678 {
					t.Fatalf("absolute deadlines lost: %#v", got)
				}
				switch field {
				case "expiresInMs":
					if got.ExpiresInMs != 0 || got.HardDeadlineInMs != 3600000 {
						t.Fatalf("only the malformed field may be dropped: %#v", got)
					}
				case "hardDeadlineInMs":
					if got.HardDeadlineInMs != 0 || got.ExpiresInMs != 60000 {
						t.Fatalf("only the malformed field may be dropped: %#v", got)
					}
				case "renewAnchor":
					if !got.RequestedAt.IsZero() || !got.LeaseClockAnchor().Equal(got.ReceivedAt) {
						t.Fatalf("a malformed echo is absent: measured from receipt, got %#v", got)
					}
				}
			})
		}
	}
}

// 0 is a valid anchor (a request in the agent's first millisecond): it must
// be used, not mistaken for "absent".
func TestZeroRenewAnchorIsAValidEcho(t *testing.T) {
	var got RevocationLeaseMessage
	c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got = msg }}
	c.handleRevocationLeaseMessage("revocation_lease",
		[]byte(`{"type":"revocation_lease","sessionId":"s1","expiresAt":1,"renewAnchor":0}`))
	if got.RequestedAt.IsZero() {
		t.Fatal("renewAnchor 0 must be honoured as an echo")
	}
	if got.RequestedAt.After(got.ReceivedAt) {
		t.Fatalf("RequestedAt %v after receipt %v", got.RequestedAt, got.ReceivedAt)
	}
}

// A malformed REQUIRED field still fails the decode as before: only the
// optional #11840 additions are lenient.
func TestMalformedRequiredLeaseFieldStillDropsTheFrame(t *testing.T) {
	called := false
	c := &Client{OnRevocationLease: func(RevocationLeaseMessage) { called = true }}
	c.handleRevocationLeaseMessage("revocation_lease", []byte(`{"sessionId":"s1","expiresAt":"soon"}`))
	if called {
		t.Fatal("a malformed expiresAt must still drop the frame")
	}
}
