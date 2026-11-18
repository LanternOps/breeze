package sessionbroker

import (
	"encoding/json"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// sendCommandAbandoningLateReply is SendCommand for a caller that stops
// waiting at the timeout but must not let a late reply escape. A reply that
// matches no registration reaches the unsolicited handler, which for a backup
// result forwards it to the server as a second terminal result.
//
// On timeout, or when the send itself fails and delivery is uncertain, the
// registration becomes a discard-only tombstone. No goroutine waits on it, so
// a helper that hangs with its session still connected leaves nothing
// running. HandleResponse consumes a late reply of the expected type, logs it
// and drops the tombstone. A reply of another type is dropped as a type
// mismatch and the tombstone stays, so an expected reply that follows is still
// consumed rather than forwarded. A tombstone whose reply never comes is dropped when the
// session closes; until then its id stays reserved (ErrDuplicateCommand), as a
// live registration's would.
//
// Callers that need the late outcome, such as the PAM dismiss gate, use
// sendCommandWithQuiescence instead.
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
		s.abandonPending(id, cmdType, ch, "send failed", "error", err.Error())
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
		if resp := s.abandonPending(id, cmdType, ch, "timed out", "timeout", timeout.String()); resp != nil {
			return resp, nil
		}
		return nil, ErrCommandTimeout
	}
}

// abandonPending turns id's live registration into a tombstone. A reply that
// was delivered before the swap is returned so the caller reports it instead
// of the timeout, and the tombstone is released again. HandleResponse delivers
// under s.mu after re-reading the registration, so every reply lands either
// before the swap (seen here) or after it (consumed through the tombstone).
func (s *Session) abandonPending(id, cmdType string, ch chan *ipc.Envelope, reason string, attrs ...any) *ipc.Envelope {
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
			append([]any{
				"id", id,
				"type", cmdType,
				"reason", reason,
				"sessionId", s.SessionID,
			}, attrs...)...,
		)
	}
	return nil
}

// discardLateReply drops the tombstone a late reply was matched to and logs
// what the helper finally answered. The server already recorded the command's
// failure, so this log is the only record of the real outcome.
func (s *Session) discardLateReply(env *ipc.Envelope, abandonedAt time.Time) {
	s.releaseTombstone(env.ID)
	attrs := []any{
		"id", env.ID,
		"type", env.Type,
		"lateBy", time.Since(abandonedAt).Round(time.Second).String(),
		"sessionId", s.SessionID,
	}
	if env.Error != "" {
		attrs = append(attrs, "envelopeError", truncateForLog(env.Error))
	}
	if env.Type == backupipc.TypeBackupResult {
		var result backupipc.BackupCommandResult
		if err := json.Unmarshal(env.Payload, &result); err == nil {
			attrs = append(attrs, "success", result.Success)
			if result.Stderr != "" {
				attrs = append(attrs, "stderr", truncateForLog(result.Stderr))
			}
		}
	}
	log.Warn("discarded late reply to an abandoned command", attrs...)
}

// lateReplyLogMax bounds helper-supplied text copied into a log line.
const lateReplyLogMax = 512

func truncateForLog(s string) string {
	if len(s) <= lateReplyLogMax {
		return s
	}
	cut := lateReplyLogMax
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut] + "…"
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
