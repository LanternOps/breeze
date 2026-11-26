package websocket

import (
	"errors"
	"time"
)

// parkedProbeInterval is how often a parked agent still attempts one upgrade
// (#8318 D-1a). Assignment normally wakes the loop through the parked state
// within one heartbeat; the probe is only the backstop for a missed signal,
// so it is long: one refused upgrade per device every ten minutes instead of
// one a minute.
const parkedProbeInterval = 10 * time.Minute

// waitWhileParked blocks while the device is parked, until the parked state
// changes or parkedProbeInterval passes (then the caller dials once, as a
// probe). It returns false when the client was stopped. Not parked (or no
// state wired): returns true at once.
func (c *Client) waitWhileParked() bool {
	st := c.config.Parked
	changed := st.Changed() // before Parked(): a change in between is not missed
	if !st.Parked() {
		return true
	}
	select {
	case <-c.done:
		return false
	case <-changed:
		// Assigned: dial now. Still parked (a second change): the next call
		// waits again.
		return c.waitWhileParked()
	case <-wsClock.After(parkedProbeInterval):
		return !c.stopped()
	}
}

// notePendingAssignment reports a dial failure that the server refused as
// parked into the parked state, and reports whether the loop should go back
// to waiting rather than back off. False when the refusal did not leave the
// state parked (no state wired, or the refusal signal is muted against an
// older server): the ordinary backoff then applies, so the loop never spins.
func (c *Client) notePendingAssignment(err error) bool {
	var refused *upgradeRefusedError
	if !errors.As(err, &refused) || !refused.PendingAssignment {
		return false
	}
	st := c.config.Parked
	st.NoteRefusal()
	return st.Parked()
}
