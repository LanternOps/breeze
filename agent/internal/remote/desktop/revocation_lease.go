package desktop

import (
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// ErrRevocationLeaseRequired is returned when a start_desktop payload carries
// no revocation-lease block.
//
// The lease is the ONLY mechanism by which the control plane can end a live
// peer-to-peer desktop session after the operator's authorization changes —
// the API is not in the media/input path. A start without one would be an
// unrevokable remote-control session, so the agent refuses it outright rather
// than degrading to the old always-on behaviour.
var ErrRevocationLeaseRequired = errors.New("start_desktop is missing the required revocationLease block")

// Absolute session ceiling the agent enforces locally, regardless of what the
// server sent and regardless of whether any lease traffic is flowing. Policy
// may SHORTEN a session, never extend it past this.
//
// This replaces the old "0 = unlimited" semantics on both decoders: a
// max-duration of zero (or anything above the cap) now means exactly this.
const MaxSessionDurationCap = 12 * time.Hour

// RevocationLease is the server-issued lease a desktop session must keep alive
// to keep streaming. Shipped inside the start_desktop payload and renewed over
// the agent's command WebSocket.
type RevocationLease struct {
	Token string
	// ExpiresAt is when the current lease lapses. Past ExpiresAt+Grace with no
	// successful renew, the session stops.
	ExpiresAt time.Time
	// HardDeadline is the absolute end of the session. Enforced locally on every
	// tick, whether or not lease traffic is flowing.
	HardDeadline time.Time
	// RenewEvery is how often to ask the control plane for a renewal.
	RenewEvery time.Duration
	// Grace is how long past ExpiresAt to keep streaming while renewals fail —
	// the outage budget that keeps an API or Redis blip from killing sessions.
	Grace time.Duration
}

// Stop reasons reported when a lease ends a session.
const (
	StopReasonLeaseRevoked = "revoked"
	StopReasonLeaseExpired = "lease_expired"
	StopReasonHardDeadline = "max_session_duration_exceeded"
)

// revocationLeaseState is the mutable half of a session's lease: what the last
// renewal said, and whether the server has revoked it outright.
type revocationLeaseState struct {
	mu            sync.Mutex
	expiresAt     time.Time
	hardDeadline  time.Time
	grace         time.Duration
	renewEvery    time.Duration
	revoked       bool
	revokedReason string
}

func newRevocationLeaseState(lease RevocationLease) *revocationLeaseState {
	return &revocationLeaseState{
		expiresAt:    lease.ExpiresAt,
		hardDeadline: lease.HardDeadline,
		grace:        lease.Grace,
		renewEvery:   lease.RenewEvery,
	}
}

// applyRenewal records a successful renewal. A renewal may only SHORTEN the
// hard deadline, never extend it: the deadline was fixed when the session
// started, and accepting a later one from the wire would defeat the cap.
func (s *revocationLeaseState) applyRenewal(expiresAt, hardDeadline time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if expiresAt.After(s.expiresAt) {
		s.expiresAt = expiresAt
	}
	if !hardDeadline.IsZero() && hardDeadline.Before(s.hardDeadline) {
		s.hardDeadline = hardDeadline
	}
}

func (s *revocationLeaseState) revoke(reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.revoked {
		return
	}
	s.revoked = true
	if reason == "" {
		reason = "unspecified"
	}
	s.revokedReason = reason
}

func (s *revocationLeaseState) snapshot() revocationLeaseSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return revocationLeaseSnapshot{
		expiresAt:     s.expiresAt,
		hardDeadline:  s.hardDeadline,
		grace:         s.grace,
		revoked:       s.revoked,
		revokedReason: s.revokedReason,
	}
}

// revocationLeaseSnapshot is an immutable read of the lease state, so the pure
// decision function below never touches a mutex.
type revocationLeaseSnapshot struct {
	expiresAt     time.Time
	hardDeadline  time.Time
	grace         time.Duration
	revoked       bool
	revokedReason string
}

// evaluateRevocationLease is the pure per-tick decision.
//
// Order matters: an explicit revocation is the most urgent signal, then the
// hard deadline (which holds even while renewals are succeeding), then lease
// expiry past its grace window.
func evaluateRevocationLease(now time.Time, snap revocationLeaseSnapshot) (bool, string) {
	if snap.revoked {
		return true, StopReasonLeaseRevoked
	}
	if !snap.hardDeadline.IsZero() && !now.Before(snap.hardDeadline) {
		return true, StopReasonHardDeadline
	}
	if !snap.expiresAt.IsZero() && !now.Before(snap.expiresAt.Add(snap.grace)) {
		return true, StopReasonLeaseExpired
	}
	return false, ""
}

// shouldRequestRenewal reports whether it is time to ask the control plane for
// a renewal. `lastRequest` is the zero time before the first request, which
// always fires immediately.
func shouldRequestRenewal(now, lastRequest time.Time, renewEvery time.Duration) bool {
	if renewEvery <= 0 {
		return false
	}
	if lastRequest.IsZero() {
		return true
	}
	return !now.Before(lastRequest.Add(renewEvery))
}

// ApplyRevocationLease records a successful renewal for a live session. Called
// by the layer that owns the command WebSocket when a `revocation_lease` frame
// arrives. Unknown session ids are ignored (the session already ended).
func (m *SessionManager) ApplyRevocationLease(sessionID string, expiresAt, hardDeadline time.Time) {
	m.mu.RLock()
	session := m.sessions[sessionID]
	m.mu.RUnlock()
	if session == nil || session.leaseState == nil {
		return
	}
	session.leaseState.applyRenewal(expiresAt, hardDeadline)
}

// RevokeSession marks a session revoked by the control plane. The watchdog
// stops it on its next tick — going through the shared decision path rather
// than tearing down inline keeps every lease-driven stop identical.
func (m *SessionManager) RevokeSession(sessionID, reason string) {
	m.mu.RLock()
	session := m.sessions[sessionID]
	m.mu.RUnlock()
	if session == nil || session.leaseState == nil {
		return
	}
	session.leaseState.revoke(reason)
}

// WireHelperRevocationLease connects a helper-hosted SessionManager to the
// agent process over IPC.
//
// A helper (Windows service install, macOS daemon install) hosts the capture
// session but holds no command WebSocket — only the agent does. Without this
// bridge the manager's RequestRevocationLeaseRenew stays nil, the watchdog asks
// nobody for a renewal, no answer ever arrives, and EVERY helper-hosted session
// is killed at expiresAt+grace (60s+90s) regardless of the operator's standing.
//
// `send` is the helper's outbound IPC channel. Renewals are fire-and-forget;
// the agent's answer comes back separately and is applied by ApplyLeaseUpdate.
// The helper's own watchdog remains authoritative either way: it stops the
// session at expiresAt+grace or the hard deadline even if the agent is silent.
func (m *SessionManager) WireHelperRevocationLease(send func(msgType string, payload any) error) {
	if send == nil {
		return
	}
	m.RequestRevocationLeaseRenew = func(sessionID string) {
		if err := send(ipc.TypeDesktopLeaseRenew, ipc.DesktopLeaseRenewRequest{SessionID: sessionID}); err != nil {
			// Not fatal: an unsent renew is indistinguishable from an
			// unanswered one, and the grace window is exactly that budget.
			slog.Debug("desktop lease renew request not sent over IPC",
				"session", sessionID, "error", err.Error())
		}
	}
}

// ApplyLeaseUpdate applies an agent-forwarded answer to a helper-hosted
// session's lease renewal. A revocation is recorded rather than torn down
// inline so every lease-driven stop goes through the same watchdog decision
// path (and so the caller — an IPC read loop — is never blocked by a teardown).
func (m *SessionManager) ApplyLeaseUpdate(u ipc.DesktopLeaseUpdate) {
	if u.SessionID == "" {
		return
	}
	if u.Revoked {
		m.RevokeSession(u.SessionID, u.Reason)
		return
	}
	m.ApplyRevocationLease(u.SessionID,
		MonotonicDeadline(u.ExpiresAtUnixMs),
		MonotonicDeadline(u.HardDeadlineUnixMs))
}

// watchdogTickInterval is how often the lifetime + lease watchdog wakes up.
// Small enough that a 25s renew cadence and a 90s grace window are both honored
// with useful resolution, large enough to cost nothing.
const watchdogTickInterval = 5 * time.Second

// watchSessionLifetime is the per-session watchdog goroutine: it asks the
// control plane to renew the revocation lease on the lease's own cadence, and
// on every tick re-decides whether the session must end — because the lease was
// revoked, because the hard deadline passed (checked locally regardless of
// lease traffic), because the lease expired past its grace window, or because
// the idle / max-duration policy says so.
//
// `tick` is a parameter rather than a constant so tests can drive the whole
// state machine on millisecond timers instead of real minutes.
func (m *SessionManager) watchSessionLifetime(
	sessionID string,
	session *Session,
	policy SessionPolicy,
	tick time.Duration,
) {
	startWall := time.Now()
	renewEvery := time.Duration(0)
	if policy.RevocationLease != nil {
		renewEvery = policy.RevocationLease.RenewEvery
	}
	var lastRenewRequest time.Time

	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-session.done:
			return
		case <-ticker.C:
			now := time.Now()

			// Ask for a renewal when due. Fire-and-forget: the answer arrives
			// asynchronously on the command socket and lands via
			// ApplyRevocationLease / RevokeSession. A control plane that never
			// answers is exactly what the grace window below is for.
			if session.leaseState != nil && shouldRequestRenewal(now, lastRenewRequest, renewEvery) {
				lastRenewRequest = now
				if m.RequestRevocationLeaseRenew != nil {
					m.RequestRevocationLeaseRenew(sessionID)
				}
			}

			stop, reason := false, ""
			if session.leaseState != nil {
				stop, reason = evaluateRevocationLease(now, session.leaseState.snapshot())
			}
			if !stop {
				lastActivity := time.Unix(0, session.lastInputUnixNano.Load())
				stop, reason = shouldStopForLifetime(now, startWall, lastActivity, policy)
			}
			if !stop {
				continue
			}

			switch reason {
			case StopReasonLeaseRevoked:
				slog.Warn("Desktop session revoked by the control plane, stopping",
					"session", sessionID, "reason", session.leaseState.snapshot().revokedReason)
			case StopReasonLeaseExpired:
				slog.Warn("Desktop session revocation lease expired past its grace window, stopping",
					"session", sessionID)
			case "idle_timeout_exceeded":
				slog.Warn("Desktop session idle timeout, stopping", "session", sessionID)
			default:
				slog.Warn("Desktop session reached max duration, stopping",
					"session", sessionID, "maxDuration", ClampMaxDuration(policy.MaxDuration))
			}

			m.StopSession(sessionID)
			if m.OnSessionStopped != nil {
				// session.LastStopReason() is "" here — a lifetime/lease stop
				// goes through the plain Stop() path, not StopWithReason
				// (#5300 is specifically about capture failures).
				go m.OnSessionStopped(sessionID, session.LastStopReason())
			}
			return
		}
	}
}
