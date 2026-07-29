package sessionbroker

import (
	"errors"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// On-demand mode replaces "spawn a helper for every session" with leases: an
// operation (remote-desktop connection, targeted script) acquires a lease on
// {session, role}, the reconcile loop spawns the helper for leased keys only,
// and the helper is reaped once the last lease reference has been released
// (or expired) for leaseLinger. Leases bind the session's username at acquire
// time — Windows recycles WTS session IDs after logoff, so a lease whose
// session now belongs to a different user is dead, not transferable.
const (
	leaseLinger     = 2 * time.Minute
	defaultLeaseTTL = 5 * time.Minute
	maxLeaseTTL     = 30 * time.Minute
)

var (
	ErrLeaseSessionNotFound  = errors.New("lease target session not found")
	ErrLeaseUnknownOwner     = errors.New("lease owner not found")
	ErrLeaseRoleNotSpawnable = errors.New("lease role is not lifecycle-spawnable")
)

type helperLease struct {
	key      HelperKey
	username string
	// owners maps operation ID -> that owner's expiry. An owner whose expiry
	// passes without renewal is dropped by leasedDesired.
	owners map[string]time.Time
	// idleSince is stamped when owners empties; the lease survives another
	// leaseLinger from that point so back-to-back operations reuse the helper.
	idleSince time.Time
}

func clampLeaseTTL(ttl time.Duration) time.Duration {
	if ttl <= 0 {
		return defaultLeaseTTL
	}
	if ttl > maxLeaseTTL {
		return maxLeaseTTL
	}
	return ttl
}

// AcquireLease records (or extends) a lease for sessionID/role owned by opID.
// The target session must exist in a fresh detector snapshot; its username is
// bound to the lease. Valid in any mode — only on-demand mode's desired set
// consumes leases. ttl<=0 uses defaultLeaseTTL; ttl is capped at maxLeaseTTL.
func (m *HelperLifecycleManager) AcquireLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	if !helperRoleSpawnable(role) {
		return ErrLeaseRoleNotSpawnable
	}
	if m.detector == nil {
		return ErrLeaseSessionNotFound
	}
	sessions, err := m.detector.ListSessions()
	if err != nil {
		return err
	}
	var username string
	found := false
	target := strconv.FormatUint(uint64(sessionID), 10)
	for _, s := range sessions {
		if s.Session == target {
			username = s.Username
			found = true
			break
		}
	}
	if !found {
		return ErrLeaseSessionNotFound
	}

	key := HelperKey{WindowsSessionID: sessionID, Role: role}
	expiry := m.now().Add(clampLeaseTTL(ttl))
	m.mu.Lock()
	lease := m.leases[key]
	if lease == nil || (lease.username != username && username != "" && lease.username != "") {
		// New lease, or the session ID was recycled to a different user —
		// the old lease is not transferable.
		lease = &helperLease{key: key, username: username, owners: make(map[string]time.Time)}
		m.leases[key] = lease
	}
	lease.owners[opID] = expiry
	lease.idleSince = time.Time{}
	m.mu.Unlock()

	log.Info("lease acquired", "helperKey", key.String(), "opID", opID, "user", username)
	m.kickReconcile()
	return nil
}

// RenewLease extends an existing owner's expiry. Unlike AcquireLease it does
// not consult the detector — renewal is on the hot path of a live stream.
func (m *HelperLifecycleManager) RenewLease(sessionID uint32, role ipc.HelperRole, opID string, ttl time.Duration) error {
	key := HelperKey{WindowsSessionID: sessionID, Role: role}
	expiry := m.now().Add(clampLeaseTTL(ttl))
	m.mu.Lock()
	defer m.mu.Unlock()
	lease := m.leases[key]
	if lease == nil {
		return ErrLeaseSessionNotFound
	}
	if _, ok := lease.owners[opID]; !ok {
		return ErrLeaseUnknownOwner
	}
	lease.owners[opID] = expiry
	return nil
}

// ReleaseLease drops one owner's reference. The helper is not stopped here:
// the lease lingers for leaseLinger and the reconcile loop reaps it after.
func (m *HelperLifecycleManager) ReleaseLease(sessionID uint32, role ipc.HelperRole, opID string) {
	key := HelperKey{WindowsSessionID: sessionID, Role: role}
	m.mu.Lock()
	if lease := m.leases[key]; lease != nil {
		delete(lease.owners, opID)
		if len(lease.owners) == 0 && lease.idleSince.IsZero() {
			lease.idleSince = m.now()
		}
	}
	m.mu.Unlock()
	log.Info("lease released", "helperKey", key.String(), "opID", opID)
}

// dropLeases removes every lease for sessionID with one of the given roles.
// Called from the SCM handlers (session logoff/disconnect) — the caller is
// responsible for stopping the helper processes.
func (m *HelperLifecycleManager) dropLeases(sessionID uint32, roles ...ipc.HelperRole) {
	m.mu.Lock()
	for _, role := range roles {
		delete(m.leases, HelperKey{WindowsSessionID: sessionID, Role: role})
	}
	m.mu.Unlock()
}

// kickReconcile nudges the run loop to reconcile now instead of waiting for
// the 30s tick. Non-blocking: a pending kick is as good as two.
func (m *HelperLifecycleManager) kickReconcile() {
	select {
	case m.kickCh <- struct{}{}:
	default:
	}
}

// leaseRoleEligible is the on-demand analogue of helperRoleDesired. It is
// deliberately stricter for the system role: on-demand SYSTEM helpers exist
// to shadow a session, and a disconnected session has no input desktop to
// capture — the SCM disconnect handler drops SYSTEM leases for the same
// reason. (Always-on retention of disconnected-RDP SYSTEM helpers is a
// helperRoleDesired concern and unchanged.)
func leaseRoleEligible(s DetectedSession, role ipc.HelperRole) bool {
	if s.Session == "0" || s.Type == "services" {
		return false
	}
	switch role {
	case ipc.HelperRoleSystem:
		return s.State == "active" || s.State == "connected"
	case ipc.HelperRoleUser:
		return s.State == "active"
	default:
		return false
	}
}

// leasedDesired is the on-demand desired-set: leases intersected with a fresh
// WTS snapshot. Mutates lease.idleSince (stamping when owners empty out) and
// returns keys whose lease is dead (session gone, session-ID reused by a
// different user, or idle past linger) for the caller to delete under m.mu.
// A live-but-ineligible session (e.g. user-role in a disconnected session)
// keeps its lease but is not desired — the session may become active again.
func leasedDesired(leases map[HelperKey]*helperLease, sessions []DetectedSession, now time.Time) (map[HelperKey]bool, []HelperKey) {
	index := make(map[string]DetectedSession, len(sessions))
	for _, s := range sessions {
		index[s.Session] = s
	}
	desired := make(map[HelperKey]bool, len(leases))
	var expired []HelperKey
	for key, lease := range leases {
		sess, ok := index[strconv.FormatUint(uint64(key.WindowsSessionID), 10)]
		if !ok {
			expired = append(expired, key)
			continue
		}
		if lease.username != "" && sess.Username != "" && sess.Username != lease.username {
			expired = append(expired, key)
			continue
		}
		for opID, expiry := range lease.owners {
			if !expiry.After(now) {
				delete(lease.owners, opID)
			}
		}
		if len(lease.owners) == 0 {
			if lease.idleSince.IsZero() {
				lease.idleSince = now
			}
			if now.Sub(lease.idleSince) >= leaseLinger {
				expired = append(expired, key)
				continue
			}
		}
		if leaseRoleEligible(sess, key.Role) {
			desired[key] = true
		}
	}
	return desired, expired
}
