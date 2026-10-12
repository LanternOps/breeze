package desktop

// inputOrder is the W2b ordering state for one session (spec §1–2). For every
// event the worker is about to inject, it decides whether to inject it, drop it
// or (for a move) hold it until the discrete event it depends on has been
// handled.
//
// The protocol in brief:
//   - Events with Seq == 0 are legacy and behave exactly as before W2b, until
//     the session's first accepted input_reset. After that they are dropped.
//   - A sequenced stream opens with input_reset{epoch}. Sequenced input before
//     it is dropped (awaitingReset).
//   - Every agent-side reset bumps resetEpoch and closes the gate again, so a
//     press sent before the reset cannot re-latch a key after it.
//   - A move carries After, the seq of the last discrete event the viewer sent
//     before it. It waits while After > lastDiscrete and is stale once
//     After < lastDiscrete. lastDiscrete advances for every discrete seq
//     handled, whatever its fate, so a rejected event cannot freeze the pointer.
//
// It is not safe for concurrent use. SafeInput serialises every call with
// orderMu: the worker judges events, and a reset trigger calls agentReset from
// its own goroutine, so the epoch moves the instant the trigger fires, even if
// the worker is wedged (review amendment R1).
type inputOrder struct {
	v2            bool   // latched by the first accepted input_reset
	awaitingReset bool   // sequenced input is dropped until input_reset{resetEpoch}
	resetEpoch    uint32 // never 0: 0 means "absent" on the wire
	geoEpoch      uint32 // never 0
	lastDiscrete  uint64 // highest discrete seq handled (injected, dropped, rejected or skipped)
	lastMove      uint64 // highest move seq judged ready
}

type orderVerdict int

const (
	orderInject      orderVerdict = iota
	orderDrop                     // not injected; the reason says why
	orderAcceptReset              // input_reset accepted: release held input, in order
)

type moveVerdict int

const (
	moveReady moveVerdict = iota
	moveWait              // barrier not met yet; keep it in the slot
	moveStale             // never inject
)

// Drop reasons. Fixed strings: logged and counted, never viewer content.
const (
	dropLegacyAfterV2 = "legacy_after_v2"
	dropDuplicateSeq  = "duplicate_seq"
	dropStaleEpoch    = "stale_epoch"
	dropAwaitingReset = "awaiting_reset"
	dropStaleGeometry = "stale_geometry"
	dropBehindBarrier = "behind_barrier"
	dropOlderMove     = "older_move"
	dropInvalidReset  = "invalid_reset"
)

func newInputOrder() *inputOrder {
	return &inputOrder{awaitingReset: true, resetEpoch: 1, geoEpoch: 1}
}

// isPointerEvent reports whether the event's coordinates are used, and so
// whether it must carry the current geometry epoch.
func isPointerEvent(eventType string) bool {
	switch eventType {
	case "mouse_move", "mouse_click", "mouse_down", "mouse_up", "mouse_scroll":
		return true
	}
	return false
}

// resyncNeeded reports whether a drop means the viewer holds a stale reset
// epoch and should be told the current one (input_epoch).
func resyncNeeded(reason string) bool {
	return reason == dropStaleEpoch || reason == dropAwaitingReset
}

// discrete judges every event type except mouse_move. For sequenced events it
// advances lastDiscrete first, so a dropped event still moves the barrier.
func (o *inputOrder) discrete(ev InputEvent) (orderVerdict, string) {
	if ev.Seq == 0 {
		if ev.Type == "input_reset" {
			return orderDrop, dropInvalidReset
		}
		if o.v2 {
			return orderDrop, dropLegacyAfterV2
		}
		return orderInject, ""
	}
	if ev.Seq <= o.lastDiscrete {
		return orderDrop, dropDuplicateSeq
	}
	o.lastDiscrete = ev.Seq
	if ev.Type == "input_reset" {
		if ev.Epoch != o.resetEpoch {
			return orderDrop, dropStaleEpoch
		}
		o.v2 = true
		o.awaitingReset = false
		return orderAcceptReset, ""
	}
	if o.awaitingReset {
		return orderDrop, dropAwaitingReset
	}
	if ev.Epoch != o.resetEpoch {
		return orderDrop, dropStaleEpoch
	}
	if isPointerEvent(ev.Type) && ev.GeoEpoch != o.geoEpoch {
		return orderDrop, dropStaleGeometry
	}
	return orderInject, ""
}

// move judges a pending mouse_move. A ready verdict records the move's seq, so
// the caller must inject it.
//
// The epoch and geometry checks come BEFORE the barrier wait (review amendment
// R2). A reset discards queued discrete events without advancing lastDiscrete,
// so a pre-reset move can carry an After that will never be reached. If it
// waited, it would never be dropped, never ask for a resync, and a viewer that
// only moves the mouse would never learn the new epoch. A move with the CURRENT
// epoch still waits; that is how moves sent right after a handshake wait for it.
func (o *inputOrder) move(ev InputEvent) (moveVerdict, string) {
	if ev.Seq == 0 {
		if o.v2 {
			return moveStale, dropLegacyAfterV2
		}
		return moveReady, ""
	}
	if ev.Seq <= o.lastMove {
		return moveStale, dropOlderMove
	}
	if ev.Epoch != o.resetEpoch {
		return moveStale, dropStaleEpoch
	}
	if ev.GeoEpoch != o.geoEpoch {
		return moveStale, dropStaleGeometry
	}
	if ev.After > o.lastDiscrete {
		return moveWait, ""
	}
	if ev.After < o.lastDiscrete {
		return moveStale, dropBehindBarrier
	}
	if o.awaitingReset {
		return moveStale, dropAwaitingReset
	}
	o.lastMove = ev.Seq
	return moveReady, ""
}

// skip advances the barrier past a discrete seq that never reached discrete()
// (rejected before the worker). It never moves the barrier backwards.
func (o *inputOrder) skip(seq uint64) {
	if seq > o.lastDiscrete {
		o.lastDiscrete = seq
	}
}

// agentReset starts a new reset epoch and closes the gate. With geometry, it
// also starts a new geometry epoch in the same step. A geometry change always
// comes with a reset, so a press made under the old geometry has already been
// released before its old-geometry release starts being dropped.
func (o *inputOrder) agentReset(geometry bool) {
	o.resetEpoch = nextEpoch(o.resetEpoch)
	if geometry {
		o.geoEpoch = nextEpoch(o.geoEpoch)
	}
	o.awaitingReset = true
}

func nextEpoch(e uint32) uint32 {
	e++
	if e == 0 {
		e = 1
	}
	return e
}
