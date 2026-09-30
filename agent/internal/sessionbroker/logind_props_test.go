package sessionbroker

import (
	"context"
	"errors"
	"testing"
	"time"
)

// applyLogindSessionProperties parses `loginctl show-session -p ...` output.
// The consent gate reads Class, the raw Type, LockedHint and whether the
// properties could be read at all, to decide whether anyone is at a desktop.
func TestApplyLogindSessionProperties(t *testing.T) {
	out := "Type=x11\nRemote=no\nDisplay=:0\nSeat=seat0\nState=active\nClass=user\nLockedHint=yes\nIdleHint=no\nIdleSinceHint=0\n"
	sess := DetectedSession{Username: "alice", Session: "2", State: "active"}
	if err := applyLogindSessionProperties(&sess, out, time.Now()); err != nil {
		t.Fatalf("apply: %v", err)
	}
	if sess.Display != "x11" || sess.LogindType != "x11" || sess.Seat != "seat0" || sess.Class != "user" {
		t.Fatalf("unexpected parse %+v", sess)
	}
	if sess.LogindDisplay != ":0" {
		t.Fatalf("Display=:0 must be kept as the logind display: %+v", sess)
	}
	if !sess.LockKnown || !sess.Locked {
		t.Fatalf("LockedHint=yes must read as locked: %+v", sess)
	}
	if sess.PropertiesUnknown {
		t.Fatal("properties were read")
	}

	tty := DetectedSession{Username: "bob", Session: "5", State: "active"}
	if err := applyLogindSessionProperties(&tty, "Type=tty\nRemote=yes\nState=online\nClass=user\nLockedHint=no\n", time.Now()); err != nil {
		t.Fatalf("apply tty: %v", err)
	}
	if tty.Display != "" || tty.LogindType != "tty" || !tty.IsRemote || tty.State != "online" {
		t.Fatalf("unexpected tty parse %+v", tty)
	}
	// Screen lockers that never set LockedHint leave it "no", so "no" cannot
	// be told apart from "nobody reports it": unknown, not unlocked.
	if tty.LockKnown {
		t.Fatalf("LockedHint=no must leave the lock state unknown: %+v", tty)
	}

	// A logind too old to report LockedHint leaves the lock state unknown.
	old := DetectedSession{Username: "carol", Session: "7"}
	if err := applyLogindSessionProperties(&old, "Type=wayland\nClass=user\n", time.Now()); err != nil {
		t.Fatalf("apply old: %v", err)
	}
	if old.LockKnown {
		t.Fatal("absent LockedHint must leave the lock state unknown")
	}
}

// Rows `loginctl list-sessions` prints that cannot be parsed are reported, not
// silently dropped: a session the detector cannot read may be the one someone
// is sitting at.
func TestParseLoginctlListLine(t *testing.T) {
	tests := []struct {
		line string
		ok   bool
		want DetectedSession
	}{
		{"  2 1000 alice seat0 tty2", true, DetectedSession{UID: 1000, Username: "alice", Session: "2", State: "active"}},
		{"c1 120 gdm seat0 tty1 active no -", true, DetectedSession{UID: 120, Username: "gdm", Session: "c1", State: "active"}},
		{"7 notanumber bob", false, DetectedSession{}},
		{"7 1000", false, DetectedSession{}},
	}
	for _, tt := range tests {
		got, ok := parseLoginctlListLine(tt.line)
		if ok != tt.ok || (ok && got != tt.want) {
			t.Errorf("parseLoginctlListLine(%q) = (%+v,%v), want (%+v,%v)", tt.line, got, ok, tt.want, tt.ok)
		}
	}
}

type countedFakeDetector struct {
	sessions []DetectedSession
	skipped  int
}

func (d *countedFakeDetector) ListSessions() ([]DetectedSession, error) { return d.sessions, nil }
func (d *countedFakeDetector) WatchSessions(context.Context) <-chan SessionEvent {
	return nil
}
func (d *countedFakeDetector) listSessionsCounted() ([]DetectedSession, int, error) {
	return d.sessions, d.skipped, nil
}

func TestListSessionsComplete(t *testing.T) {
	complete := &countedFakeDetector{sessions: []DetectedSession{{Session: "1"}}}
	if got, err := ListSessionsComplete(complete); err != nil || len(got) != 1 {
		t.Fatalf("complete listing = (%v,%v)", got, err)
	}
	partial := &countedFakeDetector{sessions: []DetectedSession{{Session: "1"}}, skipped: 1}
	if _, err := ListSessionsComplete(partial); !errors.Is(err, ErrSessionListIncomplete) {
		t.Fatalf("a listing that skipped a row must report ErrSessionListIncomplete, got %v", err)
	}
}
