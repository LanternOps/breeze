package sessionbroker

import (
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
