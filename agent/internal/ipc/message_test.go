package ipc

import (
	"encoding/json"
	"testing"
)

func TestHelperAssistConstants(t *testing.T) {
	if HelperRoleAssist != "assist" {
		t.Fatalf("HelperRoleAssist = %q, want \"assist\"", HelperRoleAssist)
	}
	if HelperBinaryAssistHelper != "assist_helper" {
		t.Fatalf("HelperBinaryAssistHelper = %q, want \"assist_helper\"", HelperBinaryAssistHelper)
	}
	if TypeHelperTokenUpdate != "helper_token_update" {
		t.Fatalf("TypeHelperTokenUpdate = %q, want \"helper_token_update\"", TypeHelperTokenUpdate)
	}
}

func TestHelperTokenUpdateRoundTrip(t *testing.T) {
	in := HelperTokenUpdate{Token: "brz_abc", ExpiresAt: "2026-06-01T00:00:00Z"}
	b, err := json.Marshal(in)
	if err != nil {
		t.Fatal(err)
	}
	var out HelperTokenUpdate
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if out != in {
		t.Fatalf("round-trip mismatch: %+v != %+v", out, in)
	}
	b2, _ := json.Marshal(HelperTokenUpdate{Token: "brz_x"})
	if string(b2) != `{"token":"brz_x"}` {
		t.Fatalf("omitempty failed: %s", b2)
	}
}
