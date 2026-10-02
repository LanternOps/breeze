package sessionbroker

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

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
		case "Display":
			sess.LogindDisplay = parts[1]
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

// parseLoginctlListLine parses one `loginctl list-sessions --no-legend` row
// ("SESSION UID USER [SEAT] [TTY] ..."). ok=false means the row could not be
// read; callers count it as skipped rather than silently dropping it.
func parseLoginctlListLine(line string) (DetectedSession, bool) {
	fields := strings.Fields(line)
	if len(fields) < 3 {
		return DetectedSession{}, false
	}
	uid, err := strconv.ParseUint(fields[1], 10, 32)
	if err != nil {
		return DetectedSession{}, false
	}
	return DetectedSession{
		UID:      uint32(uid),
		Username: fields[2],
		Session:  fields[0],
		State:    "active",
	}, true
}
