package ipc

import (
	"encoding/json"
	"strings"
	"testing"
)

// #10300: denialVerdict is optional on the wire. A status with nothing
// denied must not carry the key (older agents and the API see what they
// always did), and a set verdict travels under exactly this name.
func TestTCCStatusJSONDenialVerdict(t *testing.T) {
	healthy, err := json.Marshal(TCCStatus{ScreenRecording: true, Accessibility: true})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(healthy), "denialVerdict") {
		t.Fatalf("healthy status carries denialVerdict: %s", healthy)
	}

	denied, err := json.Marshal(TCCStatus{DenialVerdict: "requirement_mismatch"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(denied), `"denialVerdict":"requirement_mismatch"`) {
		t.Fatalf("denied status = %s, want denialVerdict", denied)
	}
}
