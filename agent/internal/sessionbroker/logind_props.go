package sessionbroker

import (
	"fmt"
	"strings"
	"time"
)

// logindSessionProperties is the property list the Linux detector asks
// `loginctl show-session` for; applyLogindSessionProperties parses the answer.
const logindSessionProperties = "--property=Type,Remote,Display,Seat,State,Class,LockedHint,IdleHint,IdleSinceHint"

// applyLogindSessionProperties folds `loginctl show-session` KEY=VALUE output
// into sess. Platform-neutral so it is unit-tested everywhere; only the Linux
// detector calls it.
func applyLogindSessionProperties(sess *DetectedSession, out string, now time.Time) error {
	var idleHint bool
	var idleSinceRaw string
	scanner := newDetectorScanner(out)
	for scanner.Scan() {
		parts := strings.SplitN(strings.TrimSpace(scanner.Text()), "=", 2)
		if len(parts) != 2 {
			continue
		}
		switch parts[0] {
		case "Type":
			sess.LogindType = parts[1]
			if parts[1] == "x11" || parts[1] == "wayland" || parts[1] == "mir" {
				sess.Display = parts[1]
			}
		case "Remote":
			sess.IsRemote = parts[1] == "yes"
		case "Seat":
			sess.Seat = parts[1]
		case "State":
			sess.State = parts[1]
		case "Class":
			sess.Class = parts[1]
		case "LockedHint":
			// Only "yes" is evidence. Screen lockers that never call
			// SetLockedHint leave it "no" while the screen is locked, so
			// "no" is indistinguishable from "nobody reports it" (same
			// reasoning as IdleHint below).
			if parts[1] == "yes" {
				sess.Locked, sess.LockKnown = true, true
			}
		case "IdleHint":
			idleHint = parts[1] == "yes"
		case "IdleSinceHint":
			idleSinceRaw = parts[1]
		}
	}
	if err := scanner.Err(); err != nil {
		return fmt.Errorf("parse loginctl show-session output for %s: %w", sess.Session, err)
	}
	// Idle is only reported when the DE actively asserts IdleHint=yes.
	// IdleHint=no must stay unknown, not "active": most DEs and all
	// headless sessions never call SetIdleHint, so "no" is
	// indistinguishable from "nobody reports it".
	if idleHint {
		if since, ok := parseIdleSinceHint(idleSinceRaw); ok {
			sess.IdleFor, sess.IdleKnown = idleSince(now, since)
		}
	}
	return nil
}
