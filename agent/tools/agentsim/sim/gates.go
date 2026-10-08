package sim

import "time"

// gate mirrors one `now.Sub(h.lastX) > interval` check in heartbeat.go Start().
type gate struct {
	period time.Duration
	last   time.Time
}

func (g *gate) due(now time.Time) bool {
	if g.period <= 0 {
		return false
	}
	if now.Sub(g.last) > g.period {
		g.last = now
		return true
	}
	return false
}

type gates struct{ security, sessions, eventlogs, inventory, posture gate }

// newGates seeds the tick-gated streams. Cold: security, sessions and event
// logs are zero-stamped (fire on the first tick) and inventory/posture were
// stamped at startup, exactly as heartbeat.go Start(). Warm: every gate starts
// at a random phase so a fleet's gated sends spread across their period.
func newGates(c Cadence, mode StartMode, now time.Time, randDur func(time.Duration) time.Duration) gates {
	mk := func(p time.Duration, coldLast time.Time) gate {
		if mode == StartWarm && p > 0 {
			return gate{period: p, last: now.Add(-randDur(p))}
		}
		return gate{period: p, last: coldLast}
	}
	return gates{
		security:  mk(c.Security, time.Time{}),
		sessions:  mk(c.Sessions, time.Time{}),
		eventlogs: mk(c.EventLogs, time.Time{}),
		inventory: mk(c.Inventory, now),
		posture:   mk(c.Posture, now),
	}
}
