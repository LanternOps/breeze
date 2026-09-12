package desktop

import (
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// DefaultSessionPolicy returns the baseline policy used by every decoder:
// clipboard permissive in both directions, lifetime timers unset (caller layers
// explicit limits on top). Centralizing this prevents the IPC decoder
// (ResolveSessionPolicyFromIPC) and the map-payload decoder
// (parseDesktopSessionPolicy) from disagreeing on defaults.
//
// Note: a zero-value SessionPolicy{} is fail-CLOSED for clipboard (both
// directions disabled) and would be fail-OPEN for lifetime, so construct via
// this function rather than the zero value: MaxDuration defaults to the
// absolute 12h cap, never to "no limit". Policy may shorten it; nothing may
// extend it.
func DefaultSessionPolicy() SessionPolicy {
	return SessionPolicy{
		ClipboardHostToViewer: true,
		ClipboardViewerToHost: true,
		MaxDuration:           MaxSessionDurationCap,
	}
}

// clampMaxDuration is the single place both decoders resolve a caller-supplied
// max-session-duration.
//
// A value of 0 used to mean "unlimited"; it now means the 12h cap, as does any
// value above the cap and any negative value. Keeping this in one function is
// what stops the map-payload decoder and the IPC decoder from drifting apart —
// they disagreed on "0" for as long as "0 = unlimited" existed.
func ClampMaxDuration(d time.Duration) time.Duration {
	if d <= 0 || d > MaxSessionDurationCap {
		return MaxSessionDurationCap
	}
	return d
}

// clipboardEnabled reports whether the policy permits any clipboard transfer.
func (p SessionPolicy) clipboardEnabled() bool {
	return p.ClipboardHostToViewer || p.ClipboardViewerToHost
}

// shouldStopForLifetime is the pure per-tick decision for the lifetime
// watchdog. It returns true (with a reason) when the session must be torn down
// because the max-duration or idle-timeout threshold has been crossed.
//
// Max-duration is enforced UNCONDITIONALLY against the 12h cap: a policy value
// of 0 no longer means "run forever", and a policy that somehow arrived larger
// than the cap is clamped back to it here as well as in the decoders. A zero
// idle timeout still legitimately means "idle timeout disabled". Max-duration
// takes precedence over idle.
func shouldStopForLifetime(now, startWall, lastActivity time.Time, policy SessionPolicy) (bool, string) {
	if now.Sub(startWall) >= ClampMaxDuration(policy.MaxDuration) {
		return true, "max_session_duration_exceeded"
	}
	if policy.IdleTimeout > 0 && now.Sub(lastActivity) >= policy.IdleTimeout {
		return true, "idle_timeout_exceeded"
	}
	return false, ""
}

// ResolveSessionPolicyFromIPC is the single authoritative decoder that turns an
// ipc.DesktopStartRequest into a SessionPolicy. Callers (the user helper) must
// NOT inline the nil→permissive logic — funnel through here so it can't drift
// from the map-payload decoder (parseDesktopSessionPolicy). Both start from
// DefaultSessionPolicy().
//
//   - nil *bool clipboard fields resolve to the permissive default (true);
//     an explicit false disables that direction.
//   - idleTimeoutMinutes <= 0 means "idle timeout disabled".
//   - maxSessionDurationHours 0 or > 12 resolves to the 12h cap (this REPLACES
//     the old "0 = unlimited" reading; see clampMaxDuration).
//   - the revocation lease is carried through verbatim; a start with no lease
//     is rejected by the caller (helper: validateDesktopStartRequest; direct
//     mode: handleStartDesktop), not silently downgraded here.
func ResolveSessionPolicyFromIPC(r ipc.DesktopStartRequest) SessionPolicy {
	p := DefaultSessionPolicy()
	if r.ClipboardHostToViewer != nil {
		p.ClipboardHostToViewer = *r.ClipboardHostToViewer
	}
	if r.ClipboardViewerToHost != nil {
		p.ClipboardViewerToHost = *r.ClipboardViewerToHost
	}
	if r.IdleTimeoutMinutes > 0 {
		p.IdleTimeout = time.Duration(r.IdleTimeoutMinutes) * time.Minute
	}
	p.MaxDuration = ClampMaxDuration(time.Duration(r.MaxSessionDurationHours) * time.Hour)
	// An unusable lease resolves to NO lease rather than to a half-populated
	// one: StartSession then refuses the start outright, which is the
	// fail-closed outcome. Callers that can report an error (the helper's
	// validateDesktopStartRequest) reject it before ever getting here.
	if lease, err := NormalizeRevocationLease(r.RevocationLease); err == nil {
		p.RevocationLease = lease
	}
	return p
}

// DefaultRevocationLeaseGrace is the outage budget applied when the server
// omits graceSec. Mirrors the API's REVOCATION_LEASE_GRACE_MS.
const DefaultRevocationLeaseGrace = 90 * time.Second

// NormalizeRevocationLease is the ONE validate-and-back-fill function every
// lease decoder funnels through — the IPC decoder below, the agent's
// map-payload decoder (heartbeat.parseRevocationLease) and the helper's
// validateDesktopStartRequest. It plays the same role for the lease that
// ClampMaxDuration plays for the max duration.
//
// It existed as two divergent copies, and they disagreed on the case that
// matters: one accepted an all-zero block (a lease with no expiry, no deadline
// and no cadence — one the watchdog can neither renew nor ever enforce, i.e. an
// unrevokable session), the other refused it. Anything unusable is rejected
// here so a caller cannot start a session it could never end.
//
// Deadlines are converted from wall clock to the MONOTONIC clock at receipt:
// the server sends absolute epoch milliseconds, but a time.Time built from
// time.UnixMilli carries no monotonic reading, so an NTP step or a hostile
// local clock would move the expiry and the hard deadline. Storing
// time.Now().Add(ttl) pins them to elapsed time instead, so a clock jump can
// neither extend a lease nor push out the 12h ceiling.
func NormalizeRevocationLease(l *ipc.RevocationLease) (*RevocationLease, error) {
	if l == nil {
		return nil, ErrRevocationLeaseRequired
	}
	// A lease with no expiry can never lapse and one with no renew cadence can
	// never be kept alive; either way the watchdog has nothing to enforce.
	if l.ExpiresAtUnixMs <= 0 || l.RenewEverySec <= 0 {
		return nil, fmt.Errorf("%w: expiresAt=%d renewEverySec=%d",
			ErrRevocationLeaseRequired, l.ExpiresAtUnixMs, l.RenewEverySec)
	}
	lease := &RevocationLease{
		Token:      l.Token,
		ExpiresAt:  MonotonicDeadline(l.ExpiresAtUnixMs),
		RenewEvery: time.Duration(l.RenewEverySec) * time.Second,
		Grace:      time.Duration(l.GraceSec) * time.Second,
	}
	// A missing hard deadline falls back to the local 12h cap from now, so the
	// absolute ceiling always exists even against an older or partial server.
	lease.HardDeadline = MonotonicDeadline(l.HardDeadlineUnixMs)
	if lease.HardDeadline.IsZero() {
		lease.HardDeadline = time.Now().Add(MaxSessionDurationCap)
	}
	if lease.Grace <= 0 {
		lease.Grace = DefaultRevocationLeaseGrace
	}
	return lease, nil
}

// MonotonicDeadline turns a server-supplied epoch-millisecond deadline into a
// time.Time anchored to this process's monotonic clock. Non-positive input (an
// absent field) yields the zero time. See NormalizeRevocationLease for why.
func MonotonicDeadline(unixMs int64) time.Time {
	if unixMs <= 0 {
		return time.Time{}
	}
	return time.Now().Add(time.Until(time.UnixMilli(unixMs)))
}

// revocationLeaseToIPC is the inverse, used when the service hands a start over
// to the user helper.
func revocationLeaseToIPC(l *RevocationLease) *ipc.RevocationLease {
	if l == nil {
		return nil
	}
	out := &ipc.RevocationLease{
		Token:         l.Token,
		RenewEverySec: int64(l.RenewEvery / time.Second),
		GraceSec:      int64(l.Grace / time.Second),
	}
	if !l.ExpiresAt.IsZero() {
		out.ExpiresAtUnixMs = l.ExpiresAt.UnixMilli()
	}
	if !l.HardDeadline.IsZero() {
		out.HardDeadlineUnixMs = l.HardDeadline.UnixMilli()
	}
	return out
}

// RevocationLeaseToIPC exposes the conversion to the heartbeat layer, which
// builds the helper's DesktopStartRequest.
func RevocationLeaseToIPC(l *RevocationLease) *ipc.RevocationLease {
	return revocationLeaseToIPC(l)
}
