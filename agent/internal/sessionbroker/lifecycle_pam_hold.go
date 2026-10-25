package sessionbroker

import (
	"strconv"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// PAM hold (#8996). In on-demand mode SYSTEM helpers exist only while an
// operation holds a lease, but a UAC prompt is not an operation the agent can
// lease ahead of: it appears whenever a user asks for elevation, and the PAM
// flow needs the SYSTEM helper in that user's session at that moment to show
// the approval dialog and drive consent.exe. Without one the flow logs "no
// capable SYSTEM helper session" and the request is stranded.
//
// While UAC interception is enabled the heartbeat sets the hold, and the
// on-demand desired set adds a SYSTEM helper for every session a user is
// signed into, recomputed from each fresh detector snapshot — so sessions that
// log on later are covered without per-session bookkeeping, and turning
// interception off releases every held helper in one step. Remote-desktop and
// script leases are untouched: the hold is a separate standing term of the
// desired set, not entries in the lease table, so it can neither extend nor
// cut short an operation's lease.
//
// Always-on mode already keeps a SYSTEM helper in every eligible session, so
// the hold changes nothing there.

// SetPAMHelperHold turns the PAM hold on or off. Idempotent; the heartbeat
// calls it every time it applies the PAM policy. A change kicks a reconcile so
// helpers come up (or are reaped) without waiting for the 30 s tick.
func (m *HelperLifecycleManager) SetPAMHelperHold(enabled bool) {
	m.mu.Lock()
	changed := m.pamHold != enabled
	m.pamHold = enabled
	m.mu.Unlock()
	if !changed {
		return
	}
	log.Info("helper lifecycle PAM hold changed", "enabled", enabled, "mode", string(m.currentMode()))
	m.kickReconcile()
}

// pamHoldEligible reports whether a session needs a SYSTEM helper for PAM: an
// interactive session a user is signed into. An active session counts even
// when its username query failed — failing toward a helper keeps elevation
// working, failing away would silently strand it. A WTSConnected session counts
// only with a known user: without one it is a logon screen, where nobody can
// raise a UAC prompt. Disconnected sessions have no input desktop for the
// dialog, so they are excluded (the SCM disconnect handler stops their SYSTEM
// helper in on-demand mode for the same reason).
func pamHoldEligible(s DetectedSession) bool {
	if !leaseRoleEligible(s, ipc.HelperRoleSystem) {
		return false
	}
	switch s.State {
	case "active":
		return true
	case "connected":
		return s.Username != ""
	default:
		return false
	}
}

// addPAMHeldKeys adds the SYSTEM-helper key of every PAM-eligible session to
// desired.
func addPAMHeldKeys(desired map[HelperKey]bool, sessions []DetectedSession) {
	for _, s := range sessions {
		if !pamHoldEligible(s) {
			continue
		}
		id, err := strconv.ParseUint(s.Session, 10, 32)
		if err != nil || id == 0 {
			continue
		}
		desired[HelperKey{WindowsSessionID: uint32(id), Role: ipc.HelperRoleSystem}] = true
	}
}
