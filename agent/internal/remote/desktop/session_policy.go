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
		return true, StopReasonHardDeadline
	}
	if policy.IdleTimeout > 0 && now.Sub(lastActivity) >= policy.IdleTimeout {
		return true, StopReasonIdleTimeout
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
	p.RelayOnly = r.RelayOnly
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
// Deadlines are pinned to the MONOTONIC clock at receipt (LeaseExpiry,
// LeaseHardDeadline), so a clock step after receipt can neither extend a lease
// nor push out the 12h ceiling. When the server also sends each deadline as
// the time remaining (expiresInMs / hardDeadlineInMs), that duration is used
// and the device's wall clock plays no part at all (#11840).
func NormalizeRevocationLease(l *ipc.RevocationLease) (*RevocationLease, error) {
	if l == nil {
		return nil, ErrRevocationLeaseRequired
	}
	// A lease with no expiry can never lapse and one with no renew cadence can
	// never be kept alive; either way the watchdog has nothing to enforce.
	if (l.ExpiresAtUnixMs <= 0 && l.ExpiresInMs <= 0) || l.RenewEverySec <= 0 {
		return nil, fmt.Errorf("%w: expiresAt=%d expiresInMs=%d renewEverySec=%d",
			ErrRevocationLeaseRequired, l.ExpiresAtUnixMs, l.ExpiresInMs, l.RenewEverySec)
	}
	receivedAt := time.Now()
	lease := &RevocationLease{
		Token:      l.Token,
		ExpiresAt:  LeaseExpiry(receivedAt, l.ExpiresInMs, l.ExpiresAtUnixMs),
		RenewEvery: time.Duration(l.RenewEverySec) * time.Second,
		Grace:      time.Duration(l.GraceSec) * time.Second,
	}
	// A missing hard deadline falls back to the local 12h cap from now, so the
	// absolute ceiling always exists even against an older or partial server.
	lease.HardDeadline = LeaseHardDeadline(receivedAt, l.HardDeadlineInMs, l.HardDeadlineUnixMs)
	if lease.HardDeadline.IsZero() {
		lease.HardDeadline = receivedAt.Add(MaxSessionDurationCap)
	}
	if lease.Grace <= 0 {
		lease.Grace = DefaultRevocationLeaseGrace
	}
	return lease, nil
}

// MonotonicDeadline turns an epoch-millisecond deadline into a time.Time
// anchored to this process's monotonic clock. Non-positive input (an absent
// field) yields the zero time.
//
// The conversion reads THIS device's wall clock, so it is exact only for a
// deadline produced on this device, such as one the agent resolved and
// forwarded to its helper. Applied to a server timestamp it is off by the
// device's clock skew (#11840): use LeaseExpiry / LeaseHardDeadline for
// anything read off the wire.
func MonotonicDeadline(unixMs int64) time.Time {
	return monotonicFromUnixMs(time.Now(), unixMs)
}

func monotonicFromUnixMs(receivedAt time.Time, unixMs int64) time.Time {
	if unixMs <= 0 {
		return time.Time{}
	}
	return receivedAt.Add(time.UnixMilli(unixMs).Sub(receivedAt))
}

// MaxRevocationLeaseTTL bounds a server-supplied lease duration. The API sends
// 60 s. A longer value is a malformed answer, and taking it verbatim would let
// one frame keep a silent session alive far past its outage budget.
const MaxRevocationLeaseTTL = 5 * time.Minute

// LeaseExpiry resolves a lease expiry against anchor, a time.Now() reading
// (zero means now) that the server's decision cannot precede.
//
// expiresInMs > 0 is the lease's remaining lifetime as of the server's
// decision: the clock-independent form, measured from anchor on the monotonic
// clock and capped at MaxRevocationLeaseTTL. Otherwise (an older API, or a
// missing or malformed field) it falls back to the absolute expiresAtUnixMs,
// read against this device's wall clock. The absolute form cuts a lease short
// by the device's full clock lead and would stretch it by the full lag, so the
// fallback is capped at the same anchor + MaxRevocationLeaseTTL: a slow clock
// can stretch a lease to at most that, never past it (#11840).
//
// Which anchor bounds what:
//   - A renewal answer is measured from when this agent queued the request it
//     answers (websocket.RevocationLeaseMessage.LeaseClockAnchor). The server
//     decided after that, so the lease never ends later than the server
//     granted, whatever the network or the server's own checks took. It can
//     only end early, by the round trip.
//   - The start payload answers no request, so it is measured from when the
//     command was decoded and can outlive the server's intent by the
//     command's delivery delay. Only until the first renewal answers, which
//     is asked for on the first watchdog tick: renewed re-anchors it (and the
//     hard deadline only ever moves earlier), unavailable or revoked ends the
//     session. If nothing ever answers, the session ends expiresIn+grace
//     after it started on this device.
func LeaseExpiry(anchor time.Time, expiresInMs, expiresAtUnixMs int64) time.Time {
	return resolveLeaseDeadline(anchor, expiresInMs, expiresAtUnixMs, MaxRevocationLeaseTTL)
}

// LeaseHardDeadline is LeaseExpiry for the session's hard deadline, with
// either form capped at anchor + MaxSessionDurationCap.
func LeaseHardDeadline(anchor time.Time, hardDeadlineInMs, hardDeadlineUnixMs int64) time.Time {
	return resolveLeaseDeadline(anchor, hardDeadlineInMs, hardDeadlineUnixMs, MaxSessionDurationCap)
}

func resolveLeaseDeadline(anchor time.Time, remainingMs, unixMs int64, ceiling time.Duration) time.Time {
	if anchor.IsZero() {
		anchor = time.Now()
	}
	if remainingMs > 0 {
		// Compare in milliseconds first so a huge value cannot overflow the
		// Duration multiply.
		if remainingMs > ceiling.Milliseconds() {
			return anchor.Add(ceiling)
		}
		return anchor.Add(time.Duration(remainingMs) * time.Millisecond)
	}
	// The absolute fallback is bounded by the same ceiling, so a device whose
	// clock is behind the server's cannot stretch the lease past it (#11840).
	// It is only ever a cap: a deadline the absolute field puts earlier, such
	// as one already past on a device whose clock is ahead, is kept as is.
	deadline := monotonicFromUnixMs(anchor, unixMs)
	if limit := anchor.Add(ceiling); !deadline.IsZero() && deadline.After(limit) {
		return limit
	}
	return deadline
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
