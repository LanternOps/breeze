package websocket

import (
	"encoding/json"
	"testing"
	"time"
)

// #11840: the remaining-time form of the deadlines must reach the caller,
// together with the receipt reading it is measured from.
func TestHandleRevocationLeaseMessageCarriesRemainingDurations(t *testing.T) {
	var got RevocationLeaseMessage
	c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got = msg }}
	raw, err := json.Marshal(map[string]any{
		"type":             "revocation_lease",
		"sessionId":        "s1",
		"expiresAt":        1234,
		"expiresInMs":      60000,
		"hardDeadline":     5678,
		"hardDeadlineInMs": 3600000,
	})
	if err != nil {
		t.Fatal(err)
	}
	before := time.Now()
	c.handleRevocationLeaseMessage("revocation_lease", raw)
	after := time.Now()

	if got.ExpiresInMs != 60000 || got.HardDeadlineInMs != 3600000 {
		t.Fatalf("remaining durations not carried: %#v", got)
	}
	if got.ExpiresAtUnixMs != 1234 || got.HardDeadlineUnixMs != 5678 {
		t.Fatalf("absolute deadlines must still be carried for older consumers: %#v", got)
	}
	if got.ReceivedAt.Before(before) || got.ReceivedAt.After(after) {
		t.Fatalf("ReceivedAt = %v, want the moment the frame was read", got.ReceivedAt)
	}

	// An older API sends no remaining form: zero, so the absolute form governs.
	raw, _ = json.Marshal(map[string]any{"type": "revocation_lease", "sessionId": "s2", "expiresAt": 1234})
	c.handleRevocationLeaseMessage("revocation_lease", raw)
	if got.ExpiresInMs != 0 || got.HardDeadlineInMs != 0 {
		t.Fatalf("an older answer must carry no remaining durations: %#v", got)
	}
}

// The renewal answer is also the agent's fence resync channel, so
// the client must surface the generation/phase fields and must no longer
// swallow `revocation_lease_unavailable` — that answer is what ends a session
// whose FIRST renewal could not be served (owner decision 2).

func TestHandleRevocationLeaseMessageCarriesFenceFields(t *testing.T) {
	var got RevocationLeaseMessage
	c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got = msg }}

	raw, err := json.Marshal(map[string]any{
		"type":             "revocation_lease",
		"sessionId":        "s1",
		"expiresAt":        1234,
		"hardDeadline":     5678,
		"startGeneration":  "9007199254740993",
		"terminationPhase": "pending",
		"syncNonce":        "n1",
	})
	if err != nil {
		t.Fatal(err)
	}
	c.handleRevocationLeaseMessage("revocation_lease", raw)

	if got.SessionID != "s1" || got.Revoked || got.Unavailable {
		t.Fatalf("unexpected message: %#v", got)
	}
	if got.StartGeneration != "9007199254740993" {
		t.Fatalf("start generation must survive as a decimal string, got %q", got.StartGeneration)
	}
	if got.TerminationPhase != "pending" || got.SyncNonce != "n1" {
		t.Fatalf("phase/nonce not carried: %#v", got)
	}
}

func TestHandleRevocationLeaseMessageCarriesTerminalGeneration(t *testing.T) {
	var got RevocationLeaseMessage
	c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got = msg }}
	raw, _ := json.Marshal(map[string]any{
		"type":               "revocation_lease_revoked",
		"sessionId":          "s1",
		"reason":             "membership_removed",
		"terminalGeneration": "12",
	})
	c.handleRevocationLeaseMessage("revocation_lease_revoked", raw)

	if !got.Revoked || got.TerminalGeneration != "12" {
		t.Fatalf("revoked answer must carry the terminal generation, got %#v", got)
	}
}

func TestHandleRevocationLeaseMessageDeliversUnavailable(t *testing.T) {
	var got RevocationLeaseMessage
	c := &Client{OnRevocationLease: func(msg RevocationLeaseMessage) { got = msg }}
	raw, _ := json.Marshal(map[string]any{
		"type":      "revocation_lease_unavailable",
		"sessionId": "s1",
		"syncNonce": "n2",
	})
	c.handleRevocationLeaseMessage("revocation_lease_unavailable", raw)

	if !got.Unavailable {
		t.Fatalf("an unavailable answer must be delivered, not swallowed: %#v", got)
	}
	if got.Revoked {
		t.Fatal("an unavailable answer must never be reported as a revocation")
	}
	if got.SyncNonce != "n2" {
		t.Fatalf("nonce not carried: %#v", got)
	}
}

func TestHandleRevocationLeaseMessageDropsMalformedFrame(t *testing.T) {
	called := false
	c := &Client{OnRevocationLease: func(RevocationLeaseMessage) { called = true }}
	c.handleRevocationLeaseMessage("revocation_lease", []byte("{not json"))
	c.handleRevocationLeaseMessage("revocation_lease", []byte(`{"sessionId":""}`))
	if called {
		t.Fatal("a malformed frame must never reach the hook")
	}
}

func TestSendRevocationLeaseRenewCarriesSyncNonce(t *testing.T) {
	c := &Client{sendChan: make(chan []byte, 1), done: make(chan struct{})}
	if err := c.SendRevocationLeaseRenewWithNonce("s1", "n3"); err != nil {
		t.Fatal(err)
	}
	var sent map[string]any
	if err := json.Unmarshal(<-c.sendChan, &sent); err != nil {
		t.Fatal(err)
	}
	if sent["type"] != "revocation_lease_renew" || sent["sessionId"] != "s1" || sent["syncNonce"] != "n3" {
		t.Fatalf("unexpected renew frame: %#v", sent)
	}

	// The ordinary watchdog renewal sends no nonce at all.
	if err := c.SendRevocationLeaseRenew("s1"); err != nil {
		t.Fatal(err)
	}
	sent = nil
	if err := json.Unmarshal(<-c.sendChan, &sent); err != nil {
		t.Fatal(err)
	}
	if _, present := sent["syncNonce"]; present {
		t.Fatalf("a plain renewal must not carry a nonce: %#v", sent)
	}
}
