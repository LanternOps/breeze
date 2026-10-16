package unifi

import (
	"math/rand/v2"
	"time"
)

// Config-fetch cadence for StartCollectorLoop (#7970).
//
// Almost no agent is a UniFi collector, yet every agent used to fetch
// GET /agents/:id/unifi-collectors every 30 s for its whole lifetime. Now:
//
//   - ActiveFetchInterval while the last fetch returned at least one collector
//     (and before the first fetch): unchanged from the old fixed ticker.
//   - IdleFetchInterval ± idleJitterFraction after an empty list.
//   - A Waker signal ends an idle wait early. The heartbeat fires it when the
//     server's configUpdate says this device has collectors
//     (unifi_collectors_assigned), so an assignment is picked up within about
//     one heartbeat instead of one idle interval.
//
// Pickup bound for a new assignment on an agent that is idle:
//   - server that sends the hint: next heartbeat (60 s), plus up to the API's
//     per-process negative-cache TTL (5 min) when the assigning request and
//     the heartbeat land on different API instances.
//   - server that predates the hint: IdleFetchInterval × (1 + idleJitterFraction).
//
// The idle re-check stays even with the hint: it is the backstop for a lost
// or stale hint.
const (
	ActiveFetchInterval = 30 * time.Second
	IdleFetchInterval   = 15 * time.Minute
	idleJitterFraction  = 0.25
	// minWakeGap bounds how often a wake can trigger a fetch. The heartbeat
	// repeats the hint every beat while a collector exists, so without it a
	// hint the config list disagrees with would re-fetch every beat.
	minWakeGap = ActiveFetchInterval
)

// idleFetchDelay maps rnd ∈ [0,1) onto
// [IdleFetchInterval·(1-j), IdleFetchInterval·(1+j)).
func idleFetchDelay(rnd func() float64) time.Duration {
	spread := float64(IdleFetchInterval) * idleJitterFraction
	return IdleFetchInterval - time.Duration(spread) + time.Duration(2*spread*rnd())
}

func defaultIdleFetchDelay() time.Duration { return idleFetchDelay(rand.Float64) }

// fetchSchedule is the loop's timing, injectable so tests run in milliseconds.
type fetchSchedule struct {
	first   time.Duration
	active  time.Duration
	idle    func() time.Duration
	wakeGap time.Duration
}

var defaultFetchSchedule = fetchSchedule{
	first:   ActiveFetchInterval,
	active:  ActiveFetchInterval,
	idle:    defaultIdleFetchDelay,
	wakeGap: minWakeGap,
}

// Waker carries "fetch now" signals into an idle collector loop. Wake never
// blocks and coalesces: at most one signal is pending. A nil *Waker is valid
// and inert.
type Waker struct{ ch chan struct{} }

func NewWaker() *Waker { return &Waker{ch: make(chan struct{}, 1)} }

func (w *Waker) Wake() {
	if w == nil {
		return
	}
	select {
	case w.ch <- struct{}{}:
	default:
	}
}

// C returns the signal channel; nil (blocks forever in a select) for a nil Waker.
func (w *Waker) C() <-chan struct{} {
	if w == nil {
		return nil
	}
	return w.ch
}
