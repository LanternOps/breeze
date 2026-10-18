package systemrestore

import (
	"encoding/json"
	"testing"
)

func TestOutcomeJSONShape(t *testing.T) {
	o := Outcome{
		Status:         StatusExistingAccepted,
		RequestID:      "3f1d1a0e-0000-4000-8000-000000000001",
		SequenceNumber: "9223372036854775807",
		Description:    "Breeze: install 6 updates [3f1d1a0e]",
		AttemptedAt:    "2026-09-02T18:03:11Z",
		DurationMs:     1234,

		ExistingPointAgeMinutes: 240,
		FrequencyMinutes:        1440,
	}
	b, err := json.Marshal(o)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round map[string]any
	if err := json.Unmarshal(b, &round); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	// The sequence number MUST be a JSON string: int64 exceeds the JS safe
	// integer range and the console/API read it as a string (#4609).
	if _, ok := round["sequenceNumber"].(string); !ok {
		t.Fatalf("sequenceNumber must marshal as a JSON string, got %T", round["sequenceNumber"])
	}
	for _, k := range []string{"status", "requestId", "attemptedAt", "durationMs",
		"description", "existingPointAgeMinutes", "frequencyMinutes"} {
		if _, ok := round[k]; !ok {
			t.Fatalf("key %q missing from marshalled Outcome: %s", k, b)
		}
	}
}

func TestOutcomeOmitsEmptyOptionalFields(t *testing.T) {
	b, err := json.Marshal(Outcome{Status: StatusUnsupported, RequestID: "x", AttemptedAt: "t"})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round map[string]any
	if err := json.Unmarshal(b, &round); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, k := range []string{"sequenceNumber", "description", "message", "existingPointAgeMinutes", "frequencyMinutes"} {
		if _, ok := round[k]; ok {
			t.Fatalf("optional key %q should be omitted when empty: %s", k, b)
		}
	}
}

func TestStatusWireValues(t *testing.T) {
	// W07 and the API ledger consume these exact strings; a rename here is a
	// protocol break, not a refactor.
	want := map[Status]string{
		StatusCreated:            "created",
		StatusExistingAccepted:   "existing_accepted",
		StatusSkippedDisabled:    "skipped_disabled",
		StatusSkippedDefinitions: "skipped_definition_only",
		StatusUnsupported:        "unsupported",
		StatusBusy:               "busy",
		StatusInsufficientPrivs:  "insufficient_privileges",
		StatusVerificationFailed: "verification_failed",
		StatusFailed:             "failed",
	}
	for s, w := range want {
		if string(s) != w {
			t.Fatalf("status %q, want wire value %q", s, w)
		}
	}
}

func TestStatusTerminal(t *testing.T) {
	tests := []struct {
		status Status
		want   bool
	}{
		{StatusCreated, true},
		{StatusExistingAccepted, true},
		{StatusSkippedDisabled, true},
		{StatusSkippedDefinitions, true},
		{StatusUnsupported, true},
		{StatusBusy, true},
		{StatusInsufficientPrivs, true},
		{StatusVerificationFailed, true},
		{StatusFailed, true},
		{Status("requested"), false},
		{Status(""), false},
	}
	for _, tc := range tests {
		if got := tc.status.Terminal(); got != tc.want {
			t.Fatalf("Status(%q).Terminal() = %v, want %v", tc.status, got, tc.want)
		}
	}
}
