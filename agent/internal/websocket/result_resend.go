package websocket

import (
	"encoding/json"
	"math"
	"math/rand/v2"
	"sync"
	"time"
)

// Command-result resubmission (#7365).
//
// Since #3530 the server answers a command result it received but could not
// record (the per-type persistence failed, so the terminal transition was
// rolled back) with an error frame instead of an ack:
//
//	{"type":"error","code":"RESULT_PROCESSING_FAILED","messageType":"command_result","commandId":…}
//
// and parks the device_commands row as a reopenable `result_processing_failed`.
// A resubmitted result for the same command id is accepted and reprocessed; a
// resubmission after a successful record hits a 0-row CAS and is simply acked,
// so a duplicate is harmless.
//
// Results are otherwise fire-and-forget once written to the socket, so the
// agent keeps a short-lived, bounded, in-memory record of what it sent, keyed
// by command id, and resends from it when the server asks. It deliberately does
// NOT reuse the on-disk backup-result outbox for this: that outbox is flushed
// only on reconnect (a live connection may not reconnect for hours), keeps no
// attempt count, and caps at a handful of entries shared with terminal backup
// results that a burst of resubmissions would evict. The outbox is still the
// fallback when a resend cannot even be queued (client stopped, channel full) —
// see Client.resendResult.
//
// Old servers never send this code; for them the record is written on send and
// cleared by the `ack` they already return (or by the TTL), with no resend.
const (
	resultProcessingFailedCode = "RESULT_PROCESSING_FAILED"
	// invalidMessageCode is the server's schema rejection of a frame
	// (buildAgentMessageRejection) — definitive for those exact bytes.
	invalidMessageCode = "INVALID_MESSAGE"

	// resultResendMaxAttempts caps resends per command id. The failure is a
	// server-side persistence error; one that survives three spaced retries is
	// not transient, and the row stays parked with an operator-facing reason.
	resultResendMaxAttempts = 3
	// Backoff: 5s, 15s, 45s (capped at resultResendMaxDelay), each ±25%.
	resultResendBaseDelay     = 5 * time.Second
	resultResendBackoffFactor = 3.0
	resultResendMaxDelay      = 60 * time.Second
	resultResendJitter        = 0.25

	// Memory bounds. A record normally lives for one round-trip (the ack
	// clears it), so the caps only matter when acks stop arriving. A single
	// result frame is at most ~wire.CommandResultBudget (≈1 MB), so the byte
	// cap, not the entry cap, is the binding one for large results.
	resultResendMaxEntries = 256
	resultResendMaxBytes   = 16 << 20
	// resultResendTTL is measured from the most recent send, so a record in
	// the middle of its resend schedule (≤ ~80s) never ages out.
	resultResendTTL = 10 * time.Minute
)

// resultResendNominalDelay is the un-jittered backoff before resend #attempt
// (1-based).
func resultResendNominalDelay(attempt int) time.Duration {
	if attempt < 1 {
		attempt = 1
	}
	d := float64(resultResendBaseDelay) * math.Pow(resultResendBackoffFactor, float64(attempt-1))
	if d > float64(resultResendMaxDelay) {
		d = float64(resultResendMaxDelay)
	}
	return time.Duration(d)
}

// resultResendDelay is resultResendNominalDelay with ±resultResendJitter, so a
// server-wide persistence blip does not bring every affected agent back in
// lockstep.
func resultResendDelay(attempt int) time.Duration {
	nominal := resultResendNominalDelay(attempt)
	return time.Duration(float64(nominal) * (1 + resultResendJitter*(rand.Float64()*2-1)))
}

// sentResult is one command result the agent sent and has not yet seen
// acknowledged.
type sentResult struct {
	result   CommandResult
	size     int
	lastSent time.Time
	// resends counts resends already scheduled for this command id. Kept across
	// re-records (the resend itself, an outbox flush) so the cap holds.
	resends int
	// timer is non-nil while a resend is scheduled.
	timer *time.Timer
}

// sentResultTracker is the bounded record of recently sent command results.
// All methods are safe for concurrent use: record runs on SendResult's caller,
// ack/onProcessingFailed on the read pump, and fire on a timer goroutine.
type sentResultTracker struct {
	mu         sync.Mutex
	entries    map[string]*sentResult
	totalBytes int

	// Bounds and seams; defaults set by newSentResultTracker, overridden by tests.
	maxEntries int
	maxBytes   int
	ttl        time.Duration
	now        func() time.Time
	delay      func(attempt int) time.Duration
}

func newSentResultTracker() *sentResultTracker {
	return &sentResultTracker{
		entries:    make(map[string]*sentResult),
		maxEntries: resultResendMaxEntries,
		maxBytes:   resultResendMaxBytes,
		ttl:        resultResendTTL,
		now:        time.Now,
		delay:      resultResendDelay,
	}
}

// record notes that result (size bytes on the wire) is being queued for
// sending, and reports whether it created a new record (false when it
// refreshed an existing one). Re-recording an id refreshes its result and send
// time but keeps its resend count and any scheduled resend.
func (t *sentResultTracker) record(result CommandResult, size int) (created bool) {
	id := result.CommandID
	if t == nil || id == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	now := t.now()
	t.pruneExpiredLocked(now)

	if e, ok := t.entries[id]; ok {
		t.totalBytes += size - e.size
		e.result = result
		e.size = size
		e.lastSent = now
	} else {
		t.entries[id] = &sentResult{result: result, size: size, lastSent: now}
		t.totalBytes += size
		created = true
	}

	for len(t.entries) > 1 && (len(t.entries) > t.maxEntries || t.totalBytes > t.maxBytes) {
		oldestID := ""
		var oldest *sentResult
		for k, e := range t.entries {
			if k == id {
				continue
			}
			if oldest == nil || e.lastSent.Before(oldest.lastSent) {
				oldestID, oldest = k, e
			}
		}
		if oldest.timer != nil {
			log.Warn("dropping a scheduled command result resend to stay within the resend buffer bounds",
				"commandId", oldestID)
		}
		t.removeLocked(oldestID)
	}
	return created
}

// ack forgets id: the server recorded it (ack) or definitively rejected it.
func (t *sentResultTracker) ack(id string) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	t.removeLocked(id)
}

// tracked reports whether id is currently recorded (tests and diagnostics).
func (t *sentResultTracker) tracked(id string) bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	_, ok := t.entries[id]
	return ok
}

// onProcessingFailed handles a RESULT_PROCESSING_FAILED frame for id. It
// returns false when id is not a result this agent has on record (never sent,
// already acked, evicted or expired) — those are never resent. Otherwise it
// either schedules resend(result) after a jittered backoff or, once
// resultResendMaxAttempts is spent, gives up and forgets the record.
func (t *sentResultTracker) onProcessingFailed(id string, resend func(CommandResult)) bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()

	e, ok := t.entries[id]
	if !ok {
		return false
	}
	if t.now().Sub(e.lastSent) > t.ttl {
		t.removeLocked(id)
		return false
	}
	if e.timer != nil {
		// A resend is already scheduled (e.g. the same result also went out via
		// an outbox flush and drew its own error frame); it covers this one.
		return true
	}
	if e.resends >= resultResendMaxAttempts {
		log.Warn("giving up resubmitting a command result the server could not record; the command stays failed server-side",
			"commandId", id,
			"status", e.result.Status,
			"resends", e.resends,
		)
		t.removeLocked(id)
		return true
	}

	e.resends++
	attempt := e.resends
	d := t.delay(attempt)
	log.Warn("server could not record a command result; resubmitting after backoff",
		"commandId", id,
		"attempt", attempt,
		"maxAttempts", resultResendMaxAttempts,
		"delay", d.String(),
	)
	e.timer = time.AfterFunc(d, func() { t.fire(id, e, resend) })
	return true
}

// fire runs a scheduled resend, unless the record was acked, evicted or
// replaced by a fresh one in the meantime.
func (t *sentResultTracker) fire(id string, scheduled *sentResult, resend func(CommandResult)) {
	t.mu.Lock()
	e, ok := t.entries[id]
	if !ok || e != scheduled || e.timer == nil {
		t.mu.Unlock()
		return
	}
	e.timer = nil
	result := e.result
	t.mu.Unlock()

	resend(result)
}

func (t *sentResultTracker) pruneExpiredLocked(now time.Time) {
	for id, e := range t.entries {
		if now.Sub(e.lastSent) > t.ttl {
			t.removeLocked(id)
		}
	}
}

func (t *sentResultTracker) removeLocked(id string) {
	e, ok := t.entries[id]
	if !ok {
		return
	}
	if e.timer != nil {
		e.timer.Stop()
	}
	t.totalBytes -= e.size
	delete(t.entries, id)
}

// handleAckFrame clears the resend record for an acknowledged command result.
func (c *Client) handleAckFrame(raw []byte) {
	var frame struct {
		CommandID string `json:"commandId"`
	}
	if err := json.Unmarshal(raw, &frame); err != nil || frame.CommandID == "" {
		return
	}
	c.resends.ack(frame.CommandID)
}

// handleServerErrorFrame logs a server rejection and, for a command result,
// acts on it: RESULT_PROCESSING_FAILED schedules a bounded resend of a result
// this agent sent; INVALID_MESSAGE is a definitive rejection of the frame's
// content (resending the same bytes would be rejected again), so the record is
// dropped. Any other code (e.g. a transient MESSAGE_RATE_BUDGET_EXCEEDED drop)
// leaves the record — and any resend already scheduled — alone; it ages out by
// TTL if nothing else touches it.
func (c *Client) handleServerErrorFrame(raw []byte) {
	frame, ok := logServerErrorFrame(raw)
	if !ok || frame.MessageType != "command_result" || frame.CommandID == "" {
		return
	}
	switch frame.Code {
	case resultProcessingFailedCode:
		if !c.resends.onProcessingFailed(frame.CommandID, c.resendResult) {
			log.Warn("server could not record a command result this agent holds no live record of "+
				"(never sent, already acked, evicted, or older than the resend TTL); not resending",
				"commandId", frame.CommandID)
		}
	case invalidMessageCode:
		c.resends.ack(frame.CommandID)
	}
}

// resendResult re-queues a result the server asked for again. If it cannot
// even be queued (client stopped, send channel full) it goes to the on-disk
// outbox via OnResultWriteFailed, which the next (re)connect flushes.
func (c *Client) resendResult(result CommandResult) {
	if err := c.SendResult(result); err != nil {
		log.Warn("could not queue a command result resubmission; handing it to the outbox",
			"commandId", result.CommandID, "error", err.Error())
		c.handleResultWriteFailure(result)
	}
}
