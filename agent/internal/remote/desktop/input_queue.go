package desktop

import "sync"

// inputTypeMouseMove is the only event type that is safe to coalesce: it carries
// an absolute cursor position, so a newer move fully supersedes an older queued
// one. Every other type (clicks, key up/down, scroll) carries irreplaceable
// intent and is never dropped or merged.
const inputTypeMouseMove = "mouse_move"

// inputQueueSafetyCap bounds the queue's memory as a last-resort backstop. In
// normal operation the queue stays near-empty (the worker drains it in
// microseconds and consecutive moves coalesce), so this cap is only approached
// if HandleEvent blocks for a long time (e.g. a secure-desktop switch) while the
// operator is producing events fast. When the cap is hit the queue drops the
// OLDEST mouse_move to make room — it never drops a key/click/scroll.
const inputQueueSafetyCap = 1024

// inputEventQueue is a single-consumer, multi-producer FIFO of viewer input
// events. Producers (pion's SCTP read goroutine) call push() and never block; a
// single worker goroutine drains it via pop() and injects each event on its own
// goroutine, so a slow SendInput/desktop switch can't stall the datachannel read
// loop (finding T4). Order is preserved. Consecutive mouse_move events collapse
// to the latest position so a slow injector can't accumulate a backlog of stale
// cursor positions — but keys, clicks, and scrolls are never dropped or
// reordered.
type inputEventQueue struct {
	mu     sync.Mutex
	events []InputEvent
	// notify has capacity 1 and carries a single edge-triggered wakeup for the
	// worker. push() sends non-blocking; a pending signal is enough to make the
	// worker drain the whole queue, so extra pushes coalescing onto one signal
	// is correct, not lossy.
	notify chan struct{}
	closed bool

	// diagnostics (guarded by mu)
	coalesced uint64 // moves merged into a trailing queued move
	dropped   uint64 // moves discarded by the safety cap
	maxDepth  int    // high-water mark of queue length
}

func newInputEventQueue() *inputEventQueue {
	return &inputEventQueue{notify: make(chan struct{}, 1)}
}

// push enqueues an event without blocking the caller. Safe to call from any
// goroutine, including after close() (a closed queue silently ignores pushes).
func (q *inputEventQueue) push(ev InputEvent) {
	q.mu.Lock()
	if q.closed {
		q.mu.Unlock()
		return
	}
	n := len(q.events)
	if ev.Type == inputTypeMouseMove && n > 0 && q.events[n-1].Type == inputTypeMouseMove {
		// Coalesce: the trailing queued move hasn't been injected yet, and this
		// newer absolute position supersedes it. Ordering is unaffected because
		// no non-move event sits between them.
		q.events[n-1] = ev
		q.coalesced++
	} else {
		if n >= inputQueueSafetyCap {
			// Backstop: reclaim space by dropping the oldest move. Never drop a
			// key/click/scroll — if the backlog is entirely those (not possible
			// from human input), we allow growth rather than lose intent.
			if q.dropOldestMoveLocked() {
				q.dropped++
			}
		}
		q.events = append(q.events, ev)
	}
	if len(q.events) > q.maxDepth {
		q.maxDepth = len(q.events)
	}
	q.mu.Unlock()

	select {
	case q.notify <- struct{}{}:
	default: // a wakeup is already pending; the worker will drain everything
	}
}

// pop removes and returns the oldest event. ok is false when the queue is empty.
func (q *inputEventQueue) pop() (InputEvent, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if len(q.events) == 0 {
		return InputEvent{}, false
	}
	ev := q.events[0]
	// Shift the tail down and reuse the backing array so a long-lived queue
	// doesn't grow its allocation unboundedly. Sizes are tiny, so the copy is
	// cheaper than tracking a head index.
	q.events = append(q.events[:0], q.events[1:]...)
	return ev, true
}

// dropOldestMoveLocked removes the first queued mouse_move. Caller holds mu.
func (q *inputEventQueue) dropOldestMoveLocked() bool {
	for i, ev := range q.events {
		if ev.Type == inputTypeMouseMove {
			q.events = append(q.events[:i], q.events[i+1:]...)
			return true
		}
	}
	return false
}

// close marks the queue closed and discards any pending events. After close,
// push is a no-op and pop returns nothing.
func (q *inputEventQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.events = nil
	q.mu.Unlock()
}
