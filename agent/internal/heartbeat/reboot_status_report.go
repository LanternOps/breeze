package heartbeat

import (
	"time"

	"github.com/breeze-rmm/agent/internal/patching"
)

// RebootStatusReport is the console-facing projection of the agent's
// RebootManager state (#3207 W5).
//
// It is deliberately NOT patching.RebootState itself. RebootState carries
// agent-internal bookkeeping (NotifiedUser, NotificationSent, LastError,
// NotificationsPlanned, DeferralMinutes) that the console has no column for,
// and pinning the wire shape to an internal struct means any future field
// added there silently starts crossing the network. This projection is the
// contract; the server persists exactly these members onto the device row.
type RebootStatusReport struct {
	// ScheduledAt is when the restart will fire. Always set — the server
	// treats it as the anchor of the snapshot and drops the whole object if it
	// fails to parse, so a report is never built without one.
	ScheduledAt time.Time `json:"scheduledAt"`
	// Deadline is the absolute cutoff past which the restart happens no matter
	// how much deferral budget is left. A pointer because RebootState carries
	// the zero time.Time when no deadline was given, and marshalling that
	// would put year 0001 in the console instead of "no deadline".
	Deadline *time.Time `json:"deadline,omitempty"`
	// Source is what asked for the restart: patch_job, maintenance_window, or
	// the agent's own manual default. Echoed straight back from the
	// schedule_reboot payload, so the server re-validates it before storing.
	Source string `json:"source,omitempty"`
	// DeferralsUsed / MaxDeferrals are NOT omitempty on purpose: zero is
	// meaningful for both. MaxDeferrals of 0 means "this restart cannot be
	// postponed", which the console has to be able to tell apart from an agent
	// that predates deferral entirely (the whole rebootStatus object absent).
	DeferralsUsed int `json:"deferralsUsed"`
	MaxDeferrals  int `json:"maxDeferrals"`
}

// buildRebootStatusReport projects RebootManager state onto the wire shape.
//
// Returns nil when nothing is scheduled, which the caller marshals as an
// explicit JSON null rather than omitting — null is how the server learns a
// restart was cancelled or has already fired. See HeartbeatPayload.RebootStatus.
func buildRebootStatusReport(state patching.RebootState) *RebootStatusReport {
	if !state.RebootScheduled || state.ScheduledAt.IsZero() {
		return nil
	}

	report := &RebootStatusReport{
		ScheduledAt:   state.ScheduledAt,
		Source:        state.Source,
		DeferralsUsed: state.DeferralsUsed,
		MaxDeferrals:  state.MaxDeferrals,
	}
	if !state.Deadline.IsZero() {
		deadline := state.Deadline
		report.Deadline = &deadline
	}
	// A schedule that does not allow deferral reports a budget of zero rather
	// than whatever stale numbers the policy happened to carry, so the console
	// renders "cannot be postponed" instead of "postponed 0 of 3" on a restart
	// nobody can actually postpone.
	if !state.DeferralAllowed {
		report.DeferralsUsed = 0
		report.MaxDeferrals = 0
	}
	return report
}

// rebootStatusForHeartbeat reads the manager and projects it, tolerating a nil
// manager (no manager means nothing can be scheduled, which is the same news as
// "nothing is scheduled").
func (h *Heartbeat) rebootStatusForHeartbeat() *RebootStatusReport {
	if h.rebootMgr == nil {
		return nil
	}
	return buildRebootStatusReport(h.rebootMgr.State())
}
