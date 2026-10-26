package heartbeat

import "time"

// noStartDialJitter disables the websocket client's U(0, 10 s) first-dial
// wait (W09, #8148) for tests that start a real client.
func noStartDialJitter() *time.Duration {
	var zero time.Duration
	return &zero
}
