//go:build darwin && cgo

package sessionbroker

import "testing"

// TestDarwinIdleKnown asserts that when a console user is present, the darwin
// detector reports a known, non-negative idle duration from HIDIdleTime.
func TestDarwinIdleKnown(t *testing.T) {
	sessions, err := NewSessionDetector().ListSessions()
	if err != nil {
		t.Fatalf("ListSessions: %v", err)
	}
	if len(sessions) == 0 {
		t.Skip("no console user logged in")
	}
	s := sessions[0]
	if !s.IdleKnown {
		t.Fatal("expected IdleKnown=true for console session on darwin cgo build")
	}
	if s.IdleFor < 0 {
		t.Fatalf("expected non-negative idle, got %v", s.IdleFor)
	}
}
