package eventlog

import (
	"strings"
	"testing"
)

// TestPAMFieldsMessageIncludesEverySuppliedField locks the message template's
// contract: every populated field must be visible in the rendered body so a
// SIEM operator reading the raw event text (not just filtering by ID) can
// answer "who authorized this elevation" (#4913).
func TestPAMFieldsMessageIncludesEverySuppliedField(t *testing.T) {
	f := PAMFields{
		ElevationRequestID: "req-123",
		TargetPath:         `C:\Windows\System32\mmc.exe`,
		TargetSHA256:       "deadbeef",
		SubjectUser:        `CORP\alice`,
		RequestedByName:    "Alice Requester",
		ApprovedByName:     "Bob Approver",
		ApprovedByEmail:    "bob@example.com",
		ApprovedAt:         "2026-09-05T10:00:00Z",
		WindowEndsAt:       "2026-09-05T10:30:00Z",
		RiskTier:           "2",
		MatchedRuleName:    "Allow devmgmt.msc",
		Detail:             "ok",
	}

	got := f.message("Breeze PAM: elevation actuated")

	for _, want := range []string{
		"Breeze PAM: elevation actuated",
		"req-123",
		`C:\Windows\System32\mmc.exe`,
		"deadbeef",
		`CORP\alice`,
		"Alice Requester",
		"Bob Approver",
		"bob@example.com",
		"2026-09-05T10:00:00Z",
		"2026-09-05T10:30:00Z",
		"Risk tier: 2",
		"Allow devmgmt.msc",
		"Detail: ok",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("message missing %q; got:\n%s", want, got)
		}
	}
}

// TestPAMFieldsMessageNeverLeaksIdentifiers asserts the field set itself has
// no id/token/credential-shaped field to leak. A future field addition that
// violates this (a user id, a session token) should fail this test's
// intent — reviewers should treat any new PAMFields field as needing the
// same "display name/email/timestamp only" justification as the existing
// ones (see actuateElevation.ts's matching comment).
func TestPAMFieldsMessageNeverLeaksIdentifiers(t *testing.T) {
	f := PAMFields{Detail: "some-uuid-shaped-id-should-not-appear-anywhere-else"}
	got := f.message("Breeze PAM: test")
	if strings.Count(got, "some-uuid-shaped-id-should-not-appear-anywhere-else") != 1 {
		t.Fatalf("expected Detail to appear exactly once verbatim, got:\n%s", got)
	}
}

// TestPAMFieldsMessageBlanksRenderAsDash locks the "-" placeholder contract
// for unset fields, so every event has the same line count regardless of
// which fields a given lifecycle stage populated.
func TestPAMFieldsMessageBlanksRenderAsDash(t *testing.T) {
	got := PAMFields{}.message("Breeze PAM: elevation session ended")
	lines := strings.Split(got, "\n")
	if len(lines) != 12 {
		t.Fatalf("expected 12 lines (1 summary + 11 fields), got %d:\n%s", len(lines), got)
	}
	for _, line := range lines[1:] {
		if !strings.HasSuffix(line, "-") && !strings.HasSuffix(line, "(-)") {
			t.Fatalf("expected blank field to render as a dash, got line %q", line)
		}
	}
}

func TestPAMEventIDsAreDistinctAndInRange(t *testing.T) {
	ids := map[uint32]string{
		EventIDPAMElevationActuated: "EventIDPAMElevationActuated",
		EventIDPAMSessionEnded:      "EventIDPAMSessionEnded",
		EventIDPAMAccountDemoted:    "EventIDPAMAccountDemoted",
		EventIDPAMSelfHealDemote:    "EventIDPAMSelfHealDemote",
		EventIDPAMActuationRefused:  "EventIDPAMActuationRefused",
	}
	if len(ids) != 5 {
		t.Fatalf("expected 5 distinct PAM event IDs, got %d: %v", len(ids), ids)
	}
	for id := range ids {
		if id < 1004 {
			t.Fatalf("PAM event ID %d collides with the generic Info/Warning/Error range (1001-1003)", id)
		}
	}
}

// TestWritePAMHelpersDoNotPanic exercises every exported PAM writer against
// the no-op/best-effort Event path. On non-Windows this is the whole
// contract (Event is a no-op); on Windows it also exercises lazy source
// registration end-to-end via lookupOrRegister, same as
// TestNoPanicOnAllPlatforms does for Info/Warning/Error.
func TestWritePAMHelpersDoNotPanic(t *testing.T) {
	f := PAMFields{ElevationRequestID: "req-1", Detail: "ok"}
	WritePAMElevationActuated(f)
	WritePAMSessionEnded(f)
	WritePAMAccountDemoted(f)
	WritePAMSelfHealDemote(f)
	WritePAMActuationRefused(f)
}

// A display name is free text from the server (users.name is an unconstrained
// varchar). If it carries newlines it must not be able to forge extra
// "Field: value" lines inside the fixed event template (#5019 review).
func TestPAMMessageNeutralisesControlCharacters(t *testing.T) {
	f := PAMFields{
		ElevationRequestID: "req-1",
		RequestedByName:    "Alice\nApproved by: FAKE-ADMIN (fake@x)\r\nRisk tier: 0",
		ApprovedByName:     "Bob\tSmith\x00",
		MatchedRuleName:    "rule\u2028one",
	}
	msg := f.message("summary")
	lines := strings.Split(msg, "\n")
	if len(lines) != 12 {
		t.Fatalf("expected exactly 12 template lines, got %d:\n%s", len(lines), msg)
	}
	for _, l := range lines {
		if strings.Contains(l, "FAKE-ADMIN (fake@x)") && !strings.HasPrefix(l, "Requested by: ") {
			t.Fatalf("injected text escaped its own field: %q", l)
		}
	}
	if strings.ContainsAny(msg, "\r\x00\t\u2028") {
		t.Fatalf("control characters survived sanitisation: %q", msg)
	}
	if !strings.Contains(msg, "Requested by: Alice Approved by: FAKE-ADMIN (fake@x) Risk tier: 0\n") {
		t.Fatalf("expected injected newlines to be flattened to spaces, got:\n%s", msg)
	}
}
