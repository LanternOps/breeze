package sessionbroker

// Bounds on what root accepts from a Linux per-session desktop helper
// (#12117). The helper runs under a user manager its user fully controls, so
// after admission it is treated as an untrusted peer: only the message types
// below are accepted, each with a size bound, and desktop-session traffic must
// name a session root itself started on this very connection. Untagged so the
// decisions are tested on every host.

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	// preAuthMaxRecv caps the frame a peer may send before it is admitted,
	// on every connection and platform.
	preAuthMaxRecv = ipc.PreAuthMaxMessageSize

	// linuxDesktopHelperMaxRecv caps every frame from an admitted helper,
	// checked against the header before allocation.
	linuxDesktopHelperMaxRecv       = 256 << 10
	linuxDesktopMaxControl          = 1 << 10
	linuxDesktopMaxCapabilities     = 4 << 10
	linuxDesktopMaxHelperLog        = 32 << 10 // a full record, JSON-escaped
	linuxDesktopMaxCommandResponse  = 128 << 10
	linuxDesktopMaxSDPAnswer        = 64 << 10
	linuxDesktopMaxICECandidate     = 2 << 10
	linuxDesktopMaxICEPerSession    = 256
	linuxDesktopMaxLeaseRenew       = 1 << 10
	linuxDesktopLeaseRenewInterval  = 5 * time.Second
	linuxDesktopMaxPeerDisconnected = 1 << 10
	// linuxDesktopPeerDisconnectReasonMax is the longest disconnect reason
	// root relays; a longer one is truncated, not refused.
	linuxDesktopPeerDisconnectReasonMax = 128

	// linuxDesktopInboundStrikeLimit is how many protocol violations end the
	// session.
	linuxDesktopInboundStrikeLimit = 3
	// linuxDesktopInboundQuietDropLimit is how many benign-looking drops
	// (late replies, traffic racing a stop) a connection gets before further
	// ones count as violations, so "benign" cannot be used to flood root.
	linuxDesktopInboundQuietDropLimit = 1024
	// linuxDesktopMaxTrackedSessions is how many desktop sessions one
	// connection remembers before finished ones are forgotten.
	linuxDesktopMaxTrackedSessions = 64
)

// linuxDesktopHelperFrameDeadline bounds one frame from its first byte to its
// last, so a trickling peer cannot hold a partial frame open.
const linuxDesktopHelperFrameDeadline = 10 * time.Second

// linuxDesktopInboundDrop is the refusal of one inbound message. strike
// marks a protocol violation; otherwise the drop is an expected race.
type linuxDesktopInboundDrop struct {
	reason string
	strike bool
}

func (d *linuxDesktopInboundDrop) Error() string { return d.reason }

// linuxDesktopInboundSession is root's record of one desktop session it
// started on this connection.
type linuxDesktopInboundSession struct {
	generation string // the start generation root sent, never the helper's
	terminal   bool
	iceCount   int
	lastRenew  time.Time
}

// linuxDesktopInboundState is the per-connection state behind the filter.
// Being per connection is what binds desktop-session ownership to this broker
// connection instance: a helper that reconnects starts with no sessions.
type linuxDesktopInboundState struct {
	mu         sync.Mutex
	now        func() time.Time
	strikes    int
	quietDrops int
	sessions   map[string]*linuxDesktopInboundSession
}

func newLinuxDesktopInboundState(now func() time.Time) *linuxDesktopInboundState {
	if now == nil {
		now = time.Now
	}
	return &linuxDesktopInboundState{now: now, sessions: make(map[string]*linuxDesktopInboundSession)}
}

// noteDesktopStart records that root is starting sessionID on this
// connection at generation. A restart gets fresh budgets.
func (st *linuxDesktopInboundState) noteDesktopStart(sessionID, generation string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if _, known := st.sessions[sessionID]; !known && len(st.sessions) >= linuxDesktopMaxTrackedSessions {
		for id, sess := range st.sessions {
			if sess.terminal {
				delete(st.sessions, id)
			}
		}
	}
	st.sessions[sessionID] = &linuxDesktopInboundSession{generation: generation}
}

// noteDesktopStop records that root ended sessionID.
func (st *linuxDesktopInboundState) noteDesktopStop(sessionID string) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if sess, ok := st.sessions[sessionID]; ok {
		sess.terminal = true
	}
}

// startGeneration is the generation root recorded for a live session.
func (st *linuxDesktopInboundState) startGeneration(sessionID string) (string, bool) {
	st.mu.Lock()
	defer st.mu.Unlock()
	sess, ok := st.sessions[sessionID]
	if !ok || sess.terminal {
		return "", false
	}
	return sess.generation, true
}

func (st *linuxDesktopInboundState) struckOut() bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.strikes >= linuxDesktopInboundStrikeLimit
}

func (st *linuxDesktopInboundState) strikeLocked(format string, args ...any) error {
	st.strikes++
	return &linuxDesktopInboundDrop{reason: fmt.Sprintf(format, args...), strike: true}
}

func (st *linuxDesktopInboundState) quietLocked(format string, args ...any) error {
	st.quietDrops++
	if st.quietDrops > linuxDesktopInboundQuietDropLimit {
		return st.strikeLocked("too many dropped messages: "+format, args...)
	}
	return &linuxDesktopInboundDrop{reason: fmt.Sprintf(format, args...)}
}

// liveSessionLocked finds the session a desktop message names. A session
// root never started here is a violation; one it already ended is a race.
func (st *linuxDesktopInboundState) liveSessionLocked(msgType, sessionID string) (*linuxDesktopInboundSession, error) {
	sess, ok := st.sessions[sessionID]
	if !ok {
		return nil, st.strikeLocked("%s names a desktop session not started on this connection", msgType)
	}
	if sess.terminal {
		return nil, st.quietLocked("%s for a desktop session that already ended", msgType)
	}
	return sess, nil
}

// checkLinuxDesktopInbound decides one message from a Linux desktop helper.
// frameSize is the frame's body length on the wire, and pendingCmd the type
// of the root command this message answers ("" when it answers none). nil
// accepts it; a *linuxDesktopInboundDrop drops it. It may rewrite env.Payload
// to truncate a field.
func checkLinuxDesktopInbound(env *ipc.Envelope, frameSize int, pendingCmd string, st *linuxDesktopInboundState) error {
	st.mu.Lock()
	defer st.mu.Unlock()

	if pendingCmd != "" {
		return st.checkCommandResponseLocked(env, frameSize, pendingCmd)
	}

	limit := 0
	switch env.Type {
	case ipc.TypePing, ipc.TypePong, ipc.TypeDisconnect:
		limit = linuxDesktopMaxControl
	case ipc.TypeCapabilities:
		limit = linuxDesktopMaxCapabilities
	case ipc.TypeHelperLog:
		limit = linuxDesktopMaxHelperLog
	case ipc.TypeDesktopLocalICECandidate:
		limit = linuxDesktopMaxICECandidate
	case ipc.TypeDesktopLeaseRenew:
		limit = linuxDesktopMaxLeaseRenew
	case ipc.TypeDesktopPeerDisconnected:
		limit = linuxDesktopMaxPeerDisconnected
	case ipc.TypeDesktopStart, ipc.TypeDesktopStop, ipc.TypeDesktopFenceSync:
		// A reply that lost the race with root's own timeout.
		return st.quietLocked("%s reply with no pending command", env.Type)
	case ipc.TypeDesktopClipboardSummary:
		// The stock helper reports this at every session teardown. Root does
		// not accept clipboard data here, but the report is not a violation.
		return st.quietLocked("clipboard summary is not accepted from a Linux desktop helper")
	default:
		return st.strikeLocked("message type %q is not accepted from a Linux desktop helper", env.Type)
	}
	if frameSize > limit {
		return st.strikeLocked("%s frame of %d bytes exceeds %d", env.Type, frameSize, limit)
	}

	switch env.Type {
	case ipc.TypeDesktopLocalICECandidate:
		var notice ipc.DesktopLocalICECandidate
		if err := json.Unmarshal(env.Payload, &notice); err != nil {
			return st.strikeLocked("malformed %s payload", env.Type)
		}
		sess, err := st.liveSessionLocked(env.Type, notice.SessionID)
		if err != nil {
			return err
		}
		if sess.iceCount >= linuxDesktopMaxICEPerSession {
			return st.strikeLocked("more than %d ICE candidates for one desktop session", linuxDesktopMaxICEPerSession)
		}
		sess.iceCount++
	case ipc.TypeDesktopLeaseRenew:
		var renew ipc.DesktopLeaseRenewRequest
		if err := json.Unmarshal(env.Payload, &renew); err != nil {
			return st.strikeLocked("malformed %s payload", env.Type)
		}
		sess, err := st.liveSessionLocked(env.Type, renew.SessionID)
		if err != nil {
			return err
		}
		now := st.now()
		if !sess.lastRenew.IsZero() && now.Sub(sess.lastRenew) < linuxDesktopLeaseRenewInterval {
			return st.quietLocked("desktop lease renewed too soon")
		}
		sess.lastRenew = now
	case ipc.TypeDesktopPeerDisconnected:
		var notice ipc.DesktopPeerDisconnectedNotice
		if err := json.Unmarshal(env.Payload, &notice); err != nil {
			return st.strikeLocked("malformed %s payload", env.Type)
		}
		sess, err := st.liveSessionLocked(env.Type, notice.SessionID)
		if err != nil {
			return err
		}
		if len(notice.Reason) > linuxDesktopPeerDisconnectReasonMax {
			notice.Reason = truncateUTF8(notice.Reason, linuxDesktopPeerDisconnectReasonMax)
			raw, err := json.Marshal(notice)
			if err != nil {
				return st.strikeLocked("could not re-encode %s payload", env.Type)
			}
			env.Payload = raw
		}
		sess.terminal = true
	}
	return nil
}

// checkCommandResponseLocked bounds the reply to a command root has pending.
func (st *linuxDesktopInboundState) checkCommandResponseLocked(env *ipc.Envelope, frameSize int, pendingCmd string) error {
	switch pendingCmd {
	case ipc.TypeDesktopStart, ipc.TypeDesktopStop, ipc.TypeDesktopFenceSync:
	default:
		return st.strikeLocked("reply to %q is not accepted from a Linux desktop helper", pendingCmd)
	}
	if frameSize > linuxDesktopMaxCommandResponse {
		return st.strikeLocked("%s reply of %d bytes exceeds %d", pendingCmd, frameSize, linuxDesktopMaxCommandResponse)
	}
	if pendingCmd == ipc.TypeDesktopStart && env.Error == "" {
		var resp ipc.DesktopStartResponse
		if err := json.Unmarshal(env.Payload, &resp); err != nil {
			return st.strikeLocked("malformed %s reply", pendingCmd)
		}
		if len(resp.Answer) > linuxDesktopMaxSDPAnswer {
			return st.strikeLocked("SDP answer of %d bytes exceeds %d", len(resp.Answer), linuxDesktopMaxSDPAnswer)
		}
	}
	return nil
}

// truncateUTF8 cuts s to at most max bytes without splitting a rune.
func truncateUTF8(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// enableLinuxDesktopInbound marks s as an admitted Linux desktop helper. Set
// once, before the session is registered and its receive loop starts.
func (s *Session) enableLinuxDesktopInbound(binding LinuxDesktopBinding, captureAuthorized func() bool) {
	s.LinuxDesktop = &binding
	s.linuxInbound = newLinuxDesktopInboundState(nil)
	s.linuxCaptureAuthorized = captureAuthorized
}

// MarkLinuxDesktopForTest turns s into an admitted Linux desktop helper that
// hosts desktopSessionID at startGeneration, for tests in other packages.
func (s *Session) MarkLinuxDesktopForTest(binding LinuxDesktopBinding, desktopSessionID, startGeneration string) {
	s.enableLinuxDesktopInbound(binding, func() bool { return false })
	s.linuxInbound.noteDesktopStart(desktopSessionID, startGeneration)
}

// LinuxDesktopStartGeneration is the start generation root recorded for a
// live desktop session on this connection. Root forwards this value rather
// than the one a Linux desktop helper supplies. ok is false for any other
// helper and for a session this connection does not host.
func (s *Session) LinuxDesktopStartGeneration(desktopSessionID string) (generation string, ok bool) {
	if s.linuxInbound == nil {
		return "", false
	}
	return s.linuxInbound.startGeneration(desktopSessionID)
}

// noteLinuxDesktopCommand records root's own desktop commands before they
// are sent, so a helper's first reply cannot outrun the record.
func (s *Session) noteLinuxDesktopCommand(cmdType string, payload any) {
	if s.linuxInbound == nil {
		return
	}
	switch cmdType {
	case ipc.TypeDesktopStart:
		if req, ok := payload.(ipc.DesktopStartRequest); ok {
			s.linuxInbound.noteDesktopStart(req.SessionID, req.StartGeneration)
		}
	case ipc.TypeDesktopStop:
		if req, ok := payload.(ipc.DesktopStopRequest); ok {
			s.linuxInbound.noteDesktopStop(req.SessionID)
		}
	}
}

// pendingCommandType is the type of the command awaiting a reply with this
// envelope id, or "" when there is none.
func (s *Session) pendingCommandType(id string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.pending[id].cmdType
}

// admitLinuxDesktopInbound applies the filter to one received message and
// reports whether it may be processed. Reaching the strike limit closes the
// session.
func (s *Session) admitLinuxDesktopInbound(env *ipc.Envelope) bool {
	err := checkLinuxDesktopInbound(env, s.conn.LastRecvFrameSize(), s.pendingCommandType(env.ID), s.linuxInbound)
	if err == nil {
		return true
	}
	if drop, ok := err.(*linuxDesktopInboundDrop); ok && !drop.strike {
		log.Debug("dropped message from Linux desktop helper",
			"type", env.Type, "sessionId", s.SessionID, "reason", err.Error())
		return false
	}
	log.Warn("refused message from Linux desktop helper",
		"type", env.Type, "sessionId", s.SessionID, "uid", s.UID, "reason", err.Error())
	if s.linuxInbound.struckOut() {
		log.Warn("closing Linux desktop helper after repeated protocol violations",
			"sessionId", s.SessionID, "uid", s.UID)
		if closeErr := s.Close(); closeErr != nil {
			log.Warn("closing Linux desktop helper failed", "sessionId", s.SessionID, "error", closeErr.Error())
		}
	}
	return false
}
