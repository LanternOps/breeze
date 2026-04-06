package sessionbroker

import (
	"strings"
	"testing"
)

func TestSanitizeDetectedField(t *testing.T) {
	t.Parallel()

	if got, err := sanitizeDetectedField(" alice ", true); err != nil || got != "alice" {
		t.Fatalf("sanitizeDetectedField valid = %q, %v", got, err)
	}
	if _, err := sanitizeDetectedField("", true); err == nil {
		t.Fatal("expected empty required field to fail")
	}
	if _, err := sanitizeDetectedField("bad\nname", true); err == nil {
		t.Fatal("expected control characters to fail")
	}
	if _, err := sanitizeDetectedField(strings.Repeat("a", maxDetectedFieldBytes+1), true); err == nil {
		t.Fatal("expected oversized field to fail")
	}
}

func TestSanitizeDetectedSession(t *testing.T) {
	t.Parallel()

	session, err := sanitizeDetectedSession(DetectedSession{
		UID:      1000,
		Username: "alice",
		Session:  "c1",
		Display:  "wayland",
		Seat:     "seat0",
		State:    "active",
		Type:     "console",
	})
	if err != nil {
		t.Fatalf("sanitizeDetectedSession: %v", err)
	}
	if session.Username != "alice" || session.Session != "c1" {
		t.Fatalf("unexpected sanitized session: %+v", session)
	}

	if _, err := sanitizeDetectedSession(DetectedSession{Username: "alice", Session: "bad\nid"}); err == nil {
		t.Fatal("expected invalid session ID to fail")
	}
}
