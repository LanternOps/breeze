package isolation

import (
	"time"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
)

// Dead-man self-release (#10103, plan W4d, spec §3.6 item 5, OD4). Off unless
// the containment policy sets a window (deadManSeconds > 0). When it is on and
// the agent runs for that long without authenticated control-plane contact, it
// releases with kind dead_man and reports self_released. The server never
// re-asserts: a human acknowledges the release before isolating again.
//
// How the window is counted, so that it fails safe both ways:
//   - It is a count of running time, advanced by Tick from the system
//     monotonic clock. The wall clock never feeds it, so a clock that is wrong
//     or jumps cannot fire it early or hold it off.
//   - A gap between ticks longer than deadManMaxTickGap (sleep, hibernate, a
//     stalled process, a monotonic reading that went backwards) adds nothing,
//     and after one the device gets DeadManWakeGrace to reach the control
//     plane before the dead-man may fire.
//   - The count lives in memory. An agent restart starts it again (a delay,
//     never an early release); the episode's expiry, which the recovery binary
//     enforces without the agent, stays the backstop.
//   - It runs only on a committed episode, and it fires once: the release moves
//     the journal out of the committed phase, and a failed release is retried
//     as the same dead_man release.
//   - The window is fixed for the episode when the rules are first applied.
//
// `containment release --force` and the break-glass code are unaffected.
const (
	// DeadManMinSeconds and DeadManMaxSeconds bound a non-zero window: the
	// containment policy's deadManMinutes (15..1440) times 60.
	DeadManMinSeconds = 15 * 60
	DeadManMaxSeconds = 1440 * 60
	// DeadManWakeGrace is how long the agent must have run since it started or
	// woke before the dead-man may fire, so a device that slept through its
	// window first gets a chance to reconnect.
	DeadManWakeGrace = 5 * time.Minute
	// deadManMaxTickGap is the most one tick may add to the count. Ticks run
	// every minute; anything longer is treated as sleep or a stall.
	deadManMaxTickGap = 3 * time.Minute
)

// validDeadManSeconds: 0 (off) or a window inside the policy's bounds.
func validDeadManSeconds(s int) bool {
	return s == 0 || (s >= DeadManMinSeconds && s <= DeadManMaxSeconds)
}

// deadManCount is the running count for one episode. Guarded by Manager.opMu.
type deadManCount struct {
	running     bool
	isolationID string
	seenContact uint64
	lastMono    time.Duration
	// noContact is running time since the last contact, excluding gaps.
	noContact time.Duration
	// sinceWake is running time since the count started or the last gap.
	sinceWake time.Duration
}

// NoteControlPlaneContact records an authenticated exchange with the control
// plane (a validated heartbeat response, or a verified round trip). It takes
// no lock, so the heartbeat path never waits on an isolation operation.
func (m *Manager) NoteControlPlaneContact() {
	m.contactSeq.Add(1)
}

// deadManDue advances the count and reports whether the committed episode's
// window has passed. It must run under opMu.
func (o *op) deadManDue() bool {
	m := o.m
	ep := o.j.Episode
	if ep == nil || o.state.Phase != journal.PhaseCommitted || o.state.AttemptID != "" || ep.DeadManSeconds <= 0 {
		m.deadMan = deadManCount{}
		return false
	}
	now := m.deps.Clock.Mono()
	seen := m.contactSeq.Load()
	c := &m.deadMan
	if !c.running || c.isolationID != ep.IsolationID {
		*c = deadManCount{running: true, isolationID: ep.IsolationID, seenContact: seen, lastMono: now}
		return false
	}
	delta := now - c.lastMono
	c.lastMono = now
	if delta < 0 || delta > deadManMaxTickGap {
		c.sinceWake = 0
	} else {
		c.noContact += delta
		c.sinceWake += delta
	}
	if seen != c.seenContact {
		c.seenContact, c.noContact = seen, 0
		return false
	}
	window := time.Duration(ep.DeadManSeconds) * time.Second
	return c.noContact >= window && c.sinceWake >= DeadManWakeGrace
}

// deadManRelease releases the committed episode as a dead-man release.
func (o *op) deadManRelease() {
	ep := o.j.Episode
	log.Warn("no control-plane contact within the dead-man window; releasing network isolation",
		"isolationId", ep.IsolationID, "generation", ep.Generation, "deadManSeconds", ep.DeadManSeconds)
	o.m.deadMan = deadManCount{}
	o.run(Event{Kind: EvRelease, IsolationID: ep.IsolationID, Generation: ep.Generation, ReleaseKind: ReleaseDeadMan})
}
