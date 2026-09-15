package websocket

import (
	"encoding/json"
	"testing"
)

// SEC-038 W05: the renewal answer is also the agent's fence resync channel, so
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
