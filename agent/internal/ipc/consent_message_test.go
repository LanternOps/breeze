package ipc

import (
	"encoding/json"
	"strings"
	"testing"
)

// The consent wire contract is shared with the Breeze Assist app
// (apps/helper/src-tauri/src/ipc/consent.rs); these pin the exact JSON keys
// and message types both sides read.
func TestConsentProtocolV2WireContract(t *testing.T) {
	if ConsentProtocolVersion != 2 {
		t.Fatalf("ConsentProtocolVersion = %d, want 2", ConsentProtocolVersion)
	}
	if TypeConsentPresented != "consent_presented" || TypeConsentCancel != "consent_cancel" {
		t.Fatalf("unexpected consent message types %q / %q", TypeConsentPresented, TypeConsentCancel)
	}
	for _, o := range []string{ConsentOutcomeGranted, ConsentOutcomeDenied, ConsentOutcomePresentedExpired, ConsentOutcomeUnavailable} {
		if o == "" {
			t.Fatal("empty consent outcome constant")
		}
	}
	if ConsentOutcomeGranted != "granted" || ConsentOutcomeDenied != "denied" ||
		ConsentOutcomePresentedExpired != "presented_expired" || ConsentOutcomeUnavailable != "unavailable" {
		t.Fatal("consent outcome values changed; the server and Assist read these verbatim")
	}

	req, _ := json.Marshal(ConsentRequest{SessionID: "s", ProtocolVersion: 2, Nonce: "n1"})
	for _, key := range []string{`"protocolVersion":2`, `"nonce":"n1"`} {
		if !strings.Contains(string(req), key) {
			t.Fatalf("v2 consent request %s missing %s", req, key)
		}
	}

	res, _ := json.Marshal(ConsentResult{Nonce: "n1", Outcome: ConsentOutcomePresentedExpired, Detail: "x"})
	for _, key := range []string{`"nonce":"n1"`, `"outcome":"presented_expired"`, `"detail":"x"`} {
		if !strings.Contains(string(res), key) {
			t.Fatalf("v2 consent result %s missing %s", res, key)
		}
	}

	ack, _ := json.Marshal(ConsentPresented{Nonce: "n1"})
	if string(ack) != `{"nonce":"n1"}` {
		t.Fatalf("consent_presented payload = %s", ack)
	}

	auth, _ := json.Marshal(AuthRequest{ConsentProtocolVersion: 2})
	if !strings.Contains(string(auth), `"consentProtocolVersion":2`) {
		t.Fatalf("auth request %s missing consentProtocolVersion", auth)
	}
}

// A version 1 exchange (older agent or older helper) must stay byte-for-byte
// what it was: no new keys appear when the v2 fields are unset.
func TestConsentProtocolV1WireUnchanged(t *testing.T) {
	req, _ := json.Marshal(ConsentRequest{SessionID: "s", TechnicianName: "t", TimeoutMs: 1, OnTimeout: "block"})
	for _, key := range []string{"protocolVersion", "nonce"} {
		if strings.Contains(string(req), key) {
			t.Fatalf("v1 consent request %s must not carry %q", req, key)
		}
	}
	res, _ := json.Marshal(ConsentResult{Decision: "allow"})
	if string(res) != `{"decision":"allow"}` {
		t.Fatalf("v1 consent result = %s", res)
	}
	auth, _ := json.Marshal(AuthRequest{})
	if strings.Contains(string(auth), "consentProtocolVersion") {
		t.Fatalf("auth request without the capability must omit it: %s", auth)
	}
}
