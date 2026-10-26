package websocket

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"time"
)

// The drain hint (W09, #8148, design D4). Wire shape, owned by W09 and sent
// by W5c's draining API instance BEFORE it closes the socket:
//
//	{"type":"drain","reconnectWithinMs":<int>,"reason":"<string>"}
//
// reconnectWithinMs must be a present, non-negative JSON integer; above
// maxDrainWithin it is clamped, anything else ignores the frame. reason is
// optional, logged (truncated) and never parsed. The agent never closes the
// socket itself: on the server's next close of that socket it spreads its
// redial uniformly over max(reconnectWithinMs, 5000) ms from the close. The
// first valid hint on a socket wins; it lapses reconnectWithinMs + 30 s after
// receipt. Agents that predate W09 skip the id-less frame.
const (
	maxDrainWithin   = 600 * time.Second
	drainHintGrace   = 30 * time.Second
	drainReasonLimit = 64
	// minDrainSpread widens a drain window below 5 s: a fleet told N < 5 s
	// (or 0) would otherwise return within N, undoing #9145's 1–5 s spread.
	minDrainSpread = serverCloseSpreadMax
)

// drainHint is the hint stored for the current socket. It is owned by the
// reconnect-loop goroutine: readPump runs on it (reconnectLoop calls readPump
// synchronously), so no lock is needed.
type drainHint struct {
	within  time.Duration
	expires time.Time
	set     bool
}

// parseDrainHint validates a drain frame and returns its window.
func parseDrainHint(raw []byte) (time.Duration, bool) {
	var msg struct {
		ReconnectWithinMs json.RawMessage `json:"reconnectWithinMs"`
	}
	if err := json.Unmarshal(raw, &msg); err != nil {
		return 0, false
	}
	v := bytes.TrimSpace(msg.ReconnectWithinMs)
	// Integers only: reject a missing field, null, strings, booleans, and a
	// fraction or exponent form (1.5, 1e3) that ParseInt would also refuse.
	if len(v) == 0 || (v[0] != '-' && (v[0] < '0' || v[0] > '9')) {
		return 0, false
	}
	ms, err := strconv.ParseInt(string(v), 10, 64)
	if err != nil || ms < 0 {
		return 0, false
	}
	if ms > maxDrainWithin.Milliseconds() {
		return maxDrainWithin, true
	}
	return time.Duration(ms) * time.Millisecond, true
}

// drainReason extracts the optional reason for logging, truncated.
func drainReason(raw []byte) string {
	var msg struct {
		Reason string `json:"reason"`
	}
	_ = json.Unmarshal(raw, &msg)
	r := msg.Reason
	if len(r) > drainReasonLimit {
		r = r[:drainReasonLimit]
	}
	return strings.ToValidUTF8(r, "")
}

// handleDrainMessage stores the first valid hint for the current socket.
// Called from readPump on the reconnect-loop goroutine.
func (c *Client) handleDrainMessage(raw []byte) {
	within, ok := parseDrainHint(raw)
	if !ok {
		log.Warn("ignoring malformed drain hint")
		return
	}
	if c.drain.set {
		log.Debug("ignoring repeated drain hint; the first on a socket wins",
			"withinMs", within.Milliseconds())
		return
	}
	c.drain = drainHint{within: within, expires: wsClock.Now().Add(within + drainHintGrace), set: true}
	log.Info("drain hint received", "withinMs", within.Milliseconds(), "reason", drainReason(raw))
	if c.testHooks.drainStored != nil {
		select {
		case c.testHooks.drainStored <- struct{}{}:
		default:
		}
	}
}

// takeDrainHint returns the live hint for the connection that just ended and
// clears it, so it never outlives its socket.
func (c *Client) takeDrainHint() (time.Duration, bool) {
	h := c.drain
	c.drain = drainHint{}
	if !h.set || wsClock.Now().After(h.expires) {
		return 0, false
	}
	return h.within, true
}

// afterDrainedDisconnect is afterDisconnect for a connection that ended with a
// live drain hint of window within (A3 drain rows). The spread starts at the
// close, not at receipt, so a server that closes late in its window does not
// collapse its fleet into a burst. The step bookkeeping is exactly
// afterDisconnect's; a local close ignores the hint.
func (b *reconnectBackoff) afterDrainedDisconnect(kind disconnectKind, lasted, within time.Duration) time.Duration {
	if kind == disconnectLocal {
		return b.afterDisconnect(kind, lasted)
	}
	spread := max(within, minDrainSpread)
	if lasted <= stableConnectionThreshold {
		// A short-lived socket keeps #9145's escalation; the hint can only
		// lengthen the wait.
		d := b.afterDisconnect(kind, lasted)
		return max(d, b.uniform(0, spread))
	}
	b.step = initialBackoff
	d := b.uniform(0, spread)
	if kind == disconnectAbnormal {
		d = max(d, b.jitteredStep())
		b.advance()
	}
	return max(d, minReconnectDelay)
}
