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
	// LastUserAction is the person's most recent decision on a restart
	// prompt (#10190 W05): the server audits it once per atUnixMs. Omitted
	// when there is none, or when it is older than lastUserActionMaxAge (the
	// server ignores those anyway).
	LastUserAction *RebootUserActionReport `json:"lastUserAction,omitempty"`
}

// RebootUserActionReport is rebootStatus.lastUserAction on the wire.
type RebootUserActionReport struct {
	Action   string `json:"action"`   // postponed | restart_now
	AtUnixMs int64  `json:"atUnixMs"` // when the person decided
	Renderer string `json:"renderer"` // assist | native | headless
}

// lastUserActionMaxAge matches the server's cutoff for auditing a decision.
const lastUserActionMaxAge = 24 * time.Hour

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
	if a := state.LastUserAction; a != nil && !a.At.IsZero() && time.Since(a.At) <= lastUserActionMaxAge {
		report.LastUserAction = &RebootUserActionReport{Action: a.Action, AtUnixMs: a.At.UnixMilli(), Renderer: a.Renderer}
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

// RestorePendingReboot re-arms the restart this agent had scheduled before it
// last stopped (#12827). The agent's startup calls it once, before Start, so
// the first heartbeat already reports the restart: a null rebootStatus is the
// server's signal that nothing is scheduled, and it clears the device row.
// Not called from New, so a test that builds a Heartbeat never reads the real
// agent data directory.
//
// startToken is this process's agent_start audit entry (audit.LogEntry). It
// goes into every record this process writes, and the restore checks the
// audit log for an agent of another version that started after the record's
// writer: an older agent cancels a restart without clearing the record.
func (h *Heartbeat) RestorePendingReboot(startToken string) bool {
	if h.rebootMgr == nil {
		return false
	}
	startsAfter := h.agentStartsAfter
	if startsAfter == nil {
		startsAfter = h.auditLog.AgentStartsAfter // nil-safe: a disabled log restores nothing
	}
	h.rebootMgr.SetAgentRun(patching.AgentRun{
		Version:     h.agentVersion,
		StartToken:  startToken,
		StartsAfter: startsAfter,
	})
	return h.rebootMgr.RestorePendingReboot()
}

// announceRestoredRestart tells the first desktop session that connects
// after a restore about the restored restart (#12827): the announcement at
// agent start went out before any helper was up. A session that cannot show
// a warning (no notify target yet) does not use up the one announcement.
func (h *Heartbeat) announceRestoredRestart() {
	if h.rebootMgr == nil || h.sessionBroker == nil {
		return
	}
	if len(h.sessionBroker.NotifyTargetsExcept("")) == 0 {
		return
	}
	h.rebootMgr.AudienceConnected()
}
