package desktop

import (
	"time"
)

// #10421: when the lifetime/lease watchdog ends a session on purpose, it first
// sends the viewer a `session_ending` control message naming why. Without it
// the viewer only sees the peer drop, treats it as a network blip, retries the
// same (now terminal) session, gets 401 and shows a generic connection error
// with a Retry that can never succeed. An older viewer has no case for this
// message type and ignores it.

// StopReasonIdleTimeout is shouldStopForLifetime's idle-timeout reason.
// (StopReasonHardDeadline is the matching max-duration reason.)
const StopReasonIdleTimeout = "idle_timeout_exceeded"

// sessionEndingDetailMaxBytes bounds the control plane's revocation reason
// echoed to the viewer. The values are short codes; this only stops a
// malformed one from growing the message.
const sessionEndingDetailMaxBytes = 64

// sessionEndingFlushTimeout is how long the watchdog waits for the notice to
// leave the control channel's send buffer before it closes the peer. Bounded
// so a stalled viewer can never hold a session open past its stop decision.
const sessionEndingFlushTimeout = 500 * time.Millisecond

// sessionEndingNotice builds the `session_ending` control message.
// fromLifetime is true when the session policy (not the revocation lease)
// made the decision: only then do the policy's idle / max-duration lengths
// describe what happened. A lease hard deadline is the server's, and may not
// match the policy value, so it carries no length.
func sessionEndingNotice(reason, revokedReason string, policy SessionPolicy, fromLifetime bool) map[string]any {
	body := map[string]any{"type": "session_ending", "reason": reason}
	switch reason {
	case StopReasonIdleTimeout:
		if fromLifetime && policy.IdleTimeout > 0 {
			body["idleTimeoutMinutes"] = ceilMinutes(policy.IdleTimeout)
		}
	case StopReasonHardDeadline:
		if fromLifetime {
			body["maxDurationMinutes"] = ceilMinutes(ClampMaxDuration(policy.MaxDuration))
		}
	case StopReasonLeaseRevoked:
		if revokedReason != "" {
			if len(revokedReason) > sessionEndingDetailMaxBytes {
				revokedReason = revokedReason[:sessionEndingDetailMaxBytes]
			}
			body["detail"] = revokedReason
		}
	}
	return body
}

func ceilMinutes(d time.Duration) int {
	return int((d + time.Minute - 1) / time.Minute)
}

type bufferedAmounter interface {
	BufferedAmount() uint64
}

// waitForControlFlush polls until the channel's send buffer is empty or the
// timeout passes. Reports whether it drained.
func waitForControlFlush(dc bufferedAmounter, timeout, poll time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for {
		if dc.BufferedAmount() == 0 {
			return true
		}
		if !time.Now().Before(deadline) {
			return false
		}
		time.Sleep(poll)
	}
}

// notifySessionEnding sends body on the control channel and waits, bounded by
// sessionEndingFlushTimeout, for it to leave the send buffer, so the Stop that
// follows does not close the channel under it. A session with no control
// channel returns at once.
func (s *Session) notifySessionEnding(body map[string]any) {
	s.sendControlJSON(body)
	s.mu.RLock()
	dc := s.controlDC
	s.mu.RUnlock()
	if dc == nil {
		return
	}
	waitForControlFlush(dc, sessionEndingFlushTimeout, 10*time.Millisecond)
}

// sendSessionEnding is the watchdog's call; tests swap notifyEnding to observe it.
func (m *SessionManager) sendSessionEnding(session *Session, body map[string]any) {
	if m.notifyEnding != nil {
		m.notifyEnding(session, body)
		return
	}
	session.notifySessionEnding(body)
}
