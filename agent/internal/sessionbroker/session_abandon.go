package sessionbroker

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// sendCommandAbandoningLateReply is SendCommand for a caller that stops
// waiting at the timeout but must not let a late reply escape. A reply that
// matches no registration reaches the unsolicited handler, which for a backup
// result forwards it to the server as a second terminal result.
//
// On timeout, or when the send itself fails and delivery is uncertain, the
// registration becomes a discard-only tombstone. No goroutine waits on it.
// HandleResponse consumes a late reply, logs it and drops the tombstone. A
// tombstone whose reply never comes is dropped when the session closes, and
// until then its id stays reserved (ErrDuplicateCommand), as a live
// registration's would.
//
// This replaced sendCommandWithQuiescence for the backup verifications
// (#6106). That function's late-response goroutine waits for the reply or
// the session close, so a helper that hung with its session still connected
// parked the goroutine for the rest of the session. Callers that need the late
// outcome, such as the PAM dismiss gate, keep using sendCommandWithQuiescence.
func (s *Session) sendCommandAbandoningLateReply(id, cmdType string, payload any, timeout time.Duration) (*ipc.Envelope, error) {
	ch := make(chan *ipc.Envelope, 1)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return nil, fmt.Errorf("session closed")
	}
	if _, exists := s.pending[id]; exists {
		s.mu.Unlock()
		return nil, fmt.Errorf("%w: %q (session %q)", ErrDuplicateCommand, id, s.SessionID)
	}
	s.pending[id] = pendingResponse{
		ch:           ch,
		expectedType: expectedResponseType(cmdType),
		validate:     responseValidator(cmdType, payload),
	}
	done := s.done
	s.mu.Unlock()

	if err := s.conn.SendTyped(id, cmdType, payload); err != nil {
		s.abandonPending(id, cmdType, ch, "send failed")
		return nil, err
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case resp, ok := <-ch:
		s.releasePending(id, ch)
		if !ok || resp == nil {
			return nil, fmt.Errorf("session closed while waiting for response")
		}
		return resp, nil
	case <-done:
		// Close already cleared the registration. Prefer a reply delivered
		// concurrently with teardown (see deliveredResponse).
		if resp := deliveredResponse(ch); resp != nil {
			return resp, nil
		}
		return nil, fmt.Errorf("session closed while waiting for response")
	case <-timer.C:
		if resp := s.abandonPending(id, cmdType, ch, "timed out"); resp != nil {
			return resp, nil
		}
		return nil, ErrCommandTimeout
	}
}

// abandonPending turns id's live registration into a tombstone. A reply that
// was delivered before the swap is returned so the caller reports it instead
// of the timeout, and the tombstone is released again.
//
// A reply HandleResponse is delivering at the moment of the swap can still
// land in the old channel after the check below. It is then dropped silently
// (never forwarded as unsolicited) and the tombstone stays until the session
// closes.
func (s *Session) abandonPending(id, cmdType string, ch chan *ipc.Envelope, reason string) *ipc.Envelope {
	s.mu.Lock()
	current, ok := s.pending[id]
	swapped := ok && current.ch == ch
	if swapped {
		s.pending[id] = pendingResponse{
			expectedType: current.expectedType,
			discard:      true,
			abandonedAt:  time.Now(),
		}
	}
	s.mu.Unlock()

	if resp := deliveredResponse(ch); resp != nil {
		s.releaseTombstone(id)
		return resp
	}
	if swapped {
		log.Warn("stopped waiting for helper reply; a late reply will be discarded",
			"id", id,
			"type", cmdType,
			"reason", reason,
			"sessionId", s.SessionID,
		)
	}
	return nil
}

// releasePending drops id's registration if it is still the one that owns ch.
func (s *Session) releasePending(id string, ch chan *ipc.Envelope) {
	s.mu.Lock()
	if current, ok := s.pending[id]; ok && current.ch == ch {
		delete(s.pending, id)
	}
	s.mu.Unlock()
}

// releaseTombstone drops id's registration if it is a tombstone.
func (s *Session) releaseTombstone(id string) {
	s.mu.Lock()
	if current, ok := s.pending[id]; ok && current.discard {
		delete(s.pending, id)
	}
	s.mu.Unlock()
}
