package desktop

import (
	"log/slog"
	"time"
)

// Revocation lease for the WebSocket fallback stream.
//
// The WebSocket fallback carries the same server-issued lease as a WebRTC
// session (the start payload's revocationLease block) and keeps it alive the
// same way: renew on the lease's own cadence over the agent's command socket,
// stop when the control plane revokes it, when it lapses past its grace
// window, or at the hard deadline. The server's relay also re-checks
// authorization on its own tick, but that only stops frames reaching the
// viewer; it cannot stop the capture itself. The lease is what ends a capture
// that no viewer is receiving — for example a start that ran after the stop
// meant to cancel it — because the session it belongs to is no longer
// renewable.

// startLeaseWatchdog attaches lease state to a stream and runs its watchdog.
// Called with the stream already registered under id.
func (m *WsSessionManager) startLeaseWatchdog(id string, session *WsStreamSession, lease *RevocationLease) {
	if lease == nil {
		return
	}
	session.leaseState = newRevocationLeaseState(*lease)
	go m.watchLease(id, session, lease.RenewEvery, watchdogTickInterval)
}

func (m *WsSessionManager) watchdogNow() time.Time {
	if m.clock != nil && m.clock.now != nil {
		return m.clock.now()
	}
	return time.Now()
}

func (m *WsSessionManager) watchdogTicks(tick time.Duration) (<-chan time.Time, func()) {
	if m.clock != nil && m.clock.ticks != nil {
		return m.clock.ticks(tick)
	}
	t := time.NewTicker(tick)
	return t.C, t.Stop
}

// watchLease is the per-stream lease watchdog. Same decision function and
// renew cadence as the WebRTC watchdog (watchSessionLifetime); there is no
// idle/max-duration policy on this path beyond the lease's hard deadline.
func (m *WsSessionManager) watchLease(id string, session *WsStreamSession, renewEvery, tick time.Duration) {
	var lastRenewRequest time.Time
	ticks, stopTicks := m.watchdogTicks(tick)
	defer stopTicks()
	for {
		select {
		case <-session.done:
			return
		case <-ticks:
			now := m.watchdogNow()
			if shouldRequestRenewal(now, lastRenewRequest, renewEvery) {
				lastRenewRequest = now
				if m.RequestRevocationLeaseRenew != nil {
					m.RequestRevocationLeaseRenew(id)
				}
			}
			stop, reason := evaluateRevocationLease(now, session.leaseState.snapshot())
			if !stop {
				continue
			}
			slog.Warn("Desktop WS stream stopped by its revocation lease",
				"sessionId", id, "reason", reason,
				"revokedReason", session.leaseState.snapshot().revokedReason)
			if m.stopExact(id, session) && m.OnSessionStopped != nil {
				go m.OnSessionStopped(id, reason)
			}
			return
		}
	}
}

// stopExact stops session and unregisters it only if id still maps to this
// exact stream, so a watchdog can never tear down a replacement started under
// the same id. Reports whether this call removed it.
func (m *WsSessionManager) stopExact(id string, session *WsStreamSession) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.sessions[id]
	if !ok || current != session {
		session.Stop()
		return false
	}
	delete(m.sessions, id)
	session.Stop()
	m.notifyActivityLocked()
	return true
}

func (m *WsSessionManager) leaseStateFor(id string) *revocationLeaseState {
	m.mu.RLock()
	defer m.mu.RUnlock()
	session := m.sessions[id]
	if session == nil {
		return nil
	}
	return session.leaseState
}

// WsLeaseStatus is a read of a stream's lease state.
type WsLeaseStatus struct {
	ExpiresAt    time.Time
	HardDeadline time.Time
	Revoked      bool
}

// LeaseStatus reports the lease state of the running stream for sessionID.
func (m *WsSessionManager) LeaseStatus(sessionID string) (WsLeaseStatus, bool) {
	state := m.leaseStateFor(sessionID)
	if state == nil {
		return WsLeaseStatus{}, false
	}
	snap := state.snapshot()
	return WsLeaseStatus{ExpiresAt: snap.expiresAt, HardDeadline: snap.hardDeadline, Revoked: snap.revoked}, true
}

// ApplyRevocationLease records a successful renewal for a live stream.
// Unknown session ids are ignored (the stream already ended, or the id
// belongs to a WebRTC session).
func (m *WsSessionManager) ApplyRevocationLease(sessionID string, expiresAt, hardDeadline time.Time) {
	if state := m.leaseStateFor(sessionID); state != nil {
		state.applyRenewal(expiresAt, hardDeadline)
	}
}

// NoteLeaseUnavailable records that the control plane could not answer a
// renewal. Before the first successful renewal this ends the stream; after,
// the grace window governs.
func (m *WsSessionManager) NoteLeaseUnavailable(sessionID string) {
	if state := m.leaseStateFor(sessionID); state != nil {
		state.noteRenewalUnavailable()
	}
}

// RevokeSession marks a stream revoked by the control plane; the watchdog
// stops it on its next tick.
func (m *WsSessionManager) RevokeSession(sessionID, reason string) {
	if state := m.leaseStateFor(sessionID); state != nil {
		state.revoke(reason)
	}
}
