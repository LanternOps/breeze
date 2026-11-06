// deadlineAction "hold" (#11065 W06): what the deadline means for an overnight
// vendor-update restart.
//
// With no action, which is every caller before W06 and every patch reboot, the
// deadline only bounds postponements (#3207): a restart that runs late, because
// the machine slept or a firmware flash held it, still happens whenever its
// timer gets to it. That is right for a patch reboot, and wrong overnight: it
// pushes the restart into the working day.
//
// With "hold" the deadline is the close of the device's maintenance window. A
// restart that can no longer begin by then is dropped, the user is told it
// moved, and the state reports reboot_held; the API retries it the next night.
// It is never forced. Postponements are still clamped to the deadline exactly
// as before, so a postponement can never carry the restart past the close.
//
// Untagged, like the rest of the manager, so it tests on every platform.
package patching

import (
	"fmt"
	"time"
)

// DeadlineAction says what happens when a scheduled restart can no longer
// begin by its deadline. The zero value is today's behaviour.
type DeadlineAction string

const (
	// DeadlineActionForce is today's behaviour: the restart happens, late.
	DeadlineActionForce DeadlineAction = ""
	// DeadlineActionHold drops a restart that cannot begin by the deadline.
	DeadlineActionHold DeadlineAction = "hold"
)

// ParseDeadlineAction maps the schedule_reboot payload value. Absent means
// force; anything it does not know is an error, so a newer API's action is
// never silently read as "force the restart".
func ParseDeadlineAction(s string, present bool) (DeadlineAction, error) {
	if !present {
		return DeadlineActionForce, nil
	}
	switch DeadlineAction(s) {
	case DeadlineActionHold:
		return DeadlineActionHold, nil
	}
	return "", fmt.Errorf("unknown deadlineAction %q", s)
}

const (
	// RebootHeldReason prefixes RebootState.LastError for a dropped restart.
	RebootHeldReason = "reboot_held"

	// holdDeadlineSlack absorbs timer jitter for a restart scheduled to land
	// exactly on the window close, which a postponement clamped to the deadline
	// does. It is small next to any window: the restart still begins inside it.
	holdDeadlineSlack = 2 * time.Minute

	rebootHeldTitle = "Restart Moved"
	rebootHeldBody  = "The scheduled restart could not start before the maintenance window closed. It will be tried again in the next maintenance window."
)

// holdOverdueLocked reports that a hold schedule's restart, beginning at at,
// would start after the window closed. Callers hold r.mu.
func (r *RebootManager) holdOverdueLocked(at time.Time) bool {
	if r.deadlineAction != DeadlineActionHold || r.state.Deadline.IsZero() {
		return false
	}
	return at.After(r.state.Deadline.Add(holdDeadlineSlack))
}

// heldRestart is what dropHeldLocked hands back for the work done after the
// lock is released.
type heldRestart struct {
	notifyFn NotifyFunc
	surface  RestartSurface
	campaign uint64
}

// dropHeldLocked drops the current schedule as held. It orphans every timer of
// the schedule, so neither a later rung nor a flash-hold retry can bring the
// restart back. Callers hold r.mu and must call announce after unlocking.
func (r *RebootManager) dropHeldLocked(now time.Time) heldRestart {
	held := heldRestart{notifyFn: r.notifyFn, surface: r.surface, campaign: r.campaign}
	deadline, source := r.state.Deadline, r.state.Source
	r.cancelLocked()
	r.state.RebootScheduled = false
	r.state.ScheduledAt = time.Time{}
	r.state.NotificationsPlanned = 0
	r.state.Held = true
	r.state.HeldAt = now
	r.state.LastError = RebootHeldReason + ": the maintenance window closed before the restart could begin; it is retried in the next window"
	// Nothing left to postpone: a prompt answered after this is refused.
	r.deferral = DeferralPolicy{}
	r.deferralsUsed = 0
	r.state.DeferralAllowed = false
	r.state.DeferralsUsed = 0
	r.state.MaxDeferrals = 0
	r.state.DeferralMinutes = 0
	log.Info("restart held: the maintenance window closed before it could begin",
		"deadline", deadline, "now", now, "source", source)
	return held
}

// announce tells the user the restart they were warned about moved, and
// withdraws its card. Called with no lock held.
func (h heldRestart) announce(r *RebootManager) {
	if h.notifyFn != nil {
		h.notifyFn(rebootHeldTitle, rebootHeldBody, "normal")
	} else {
		log.Warn("restart held, and there is no way to tell the user it moved")
	}
	r.tellCancelled(h.surface, h.campaign)
}

// checkHoldSchedule refuses a hold schedule that could not begin inside its
// window even on time. Without it the restart would warn the user and then be
// dropped at the first timer.
func checkHoldSchedule(now time.Time, delay time.Duration, deadline time.Time, action DeadlineAction) error {
	switch action {
	case DeadlineActionForce:
		return nil
	case DeadlineActionHold:
	default:
		return fmt.Errorf("unknown deadline action %q", action)
	}
	if deadline.IsZero() {
		return fmt.Errorf("a hold restart needs a deadline")
	}
	if delay < MinRebootDelay {
		delay = MinRebootDelay
	}
	if now.Add(delay).After(deadline.Add(holdDeadlineSlack)) {
		return fmt.Errorf("the restart cannot begin before its window closes at %s", deadline.Format(time.RFC3339))
	}
	return nil
}
