// The restart prompt surface (#10190 W05, spec §3.3; #10181).
//
// Untagged for the reason reboot_plan.go is: the decisions here are pure and
// tested on every OS.
//
// The warning ladder itself — which rungs exist, which may be postponed, how
// a postponement re-plans, the deadline — is unchanged. What changes is who
// draws a rung: the manager hands it to a RestartSurface first (the prompt
// host's branded restart card in every session that can draw it), and only a
// rung the surface did not take goes out as today's notification or dialog,
// byte for byte. The surface answers through UserPostpone / UserRestartNow,
// which apply to the operator's restart (the campaign) rather than to one
// re-plan of it, so a card stays valid across the person's own
// postponements.
package patching

import (
	"fmt"
	"runtime"
	"sync"
	"time"
)

// RestartSurface draws the restart card. Implementations must not call back
// into the manager while the manager holds its lock: every method is called
// with no manager lock held.
type RestartSurface interface {
	// ShowRung puts one rung on the card for the sessions that can draw it.
	// It reports whether it took the rung; false means the manager sends
	// today's warning for this rung to every session instead.
	ShowRung(r RestartRung) bool
	// Cancelled tells the surface an operator cancelled the campaign.
	Cancelled(campaign uint64)
	// BeforeOSRestart runs just before the OS restart command, so the
	// after-the-fact list entry is on disk when the machine goes down.
	BeforeOSRestart(campaign uint64, at time.Time)
	// OSRestartFailed reports that the OS restart command failed (or this
	// platform has none) after BeforeOSRestart: the machine is not going
	// down, so the after-the-fact entry must go. A cancel during the OS
	// grace minute is reported through Cancelled.
	OSRestartFailed(campaign uint64)
}

// RebootSeams injects the OS- and disk-touching parts of a manager, for
// tests in other packages that drive a real manager (the restart card's
// end-to-end tests). Zero fields keep the real implementation.
type RebootSeams struct {
	Now           func() time.Time
	AfterFunc     func(time.Duration, func()) *time.Timer
	ExecOSReboot  func(grace time.Duration) error
	AbortOSReboot func() error
	HistoryPath   string
	LedgerPath    string
}

// NewRebootManagerWithSeams is NewRebootManagerWithPrompt with injected
// seams. Production code uses NewRebootManagerWithPrompt.
func NewRebootManagerWithSeams(notifyFn NotifyFunc, promptFn PromptFunc, maxRebootsPerDay int, seams RebootSeams) *RebootManager {
	rm := NewRebootManagerWithPrompt(notifyFn, promptFn, maxRebootsPerDay)
	rm.mu.Lock()
	defer rm.mu.Unlock()
	if seams.Now != nil {
		rm.nowFn = seams.Now
	}
	if seams.AfterFunc != nil {
		rm.afterFunc = seams.AfterFunc
	}
	if seams.ExecOSReboot != nil {
		rm.execOSReboot = seams.ExecOSReboot
	}
	if seams.AbortOSReboot != nil {
		rm.abortOSReboot = seams.AbortOSReboot
	}
	if seams.HistoryPath != "" {
		path := seams.HistoryPath
		rm.historyPath = func() string { return path }
	}
	if seams.LedgerPath != "" {
		path := seams.LedgerPath
		rm.deferralLedger = func() string { return path }
	}
	return rm
}

// RestartRung is one rung as the card sees it.
type RestartRung struct {
	// Campaign identifies the operator's restart: one Schedule, stable across
	// the person's postponements and Restart now. Unique across agent
	// restarts (it is a Unix-millisecond stamp), so a prompt tombstone that
	// survived a reboot never matches the next campaign.
	Campaign uint64
	// Final is the closing rung: the OS countdown is running.
	Final bool
	// Resurface is false for the lead rung a postponement re-planned (#4941):
	// the card is updated where it is, not shown again.
	Resurface bool
	// ScheduledAt is when the restart fires; Deadline the hard cutoff (zero
	// when none).
	ScheduledAt, Deadline time.Time
	// PostponeUntil is where a Postpone would move the restart to (the
	// ComputeDeferral clamp); zero when the card offers no Postpone.
	PostponeUntil time.Time
	// DeferralAllowed / DeferralsLeft drive the card's budget line.
	DeferralAllowed bool
	DeferralsLeft   int
	// Text is the operator's copy, sanitised but not rendered: the card
	// turns {{countdown}} into its own live countdown.
	Text RebootPromptText
	// LegacyTitle/Body/Urgency are today's warning for this rung, for a
	// session that cannot draw the card.
	LegacyTitle, LegacyBody, LegacyUrgency string
}

// minPostponeGap is the least a Postpone must move the restart by for the
// card to offer it (spec §3.3: the action is hidden when the clamp leaves
// less than the minimum gap). ComputeDeferral still grants a smaller move to
// today's dialog; the card simply does not offer a Postpone that postpones
// by a few seconds.
const minPostponeGap = minReminderGap

// User decisions, as reported to the console (RebootState.LastUserAction).
const (
	UserActionPostponed  = "postponed"
	UserActionRestartNow = "restart_now"
)

// RebootUserAction is the most recent decision the person at the keyboard
// made on a restart prompt. Renderer is assist, native or headless.
type RebootUserAction struct {
	Action   string    `json:"action"`
	At       time.Time `json:"at"`
	Renderer string    `json:"renderer"`
}

// legacyPromptRenderer names the renderer of today's dialog: the desktop
// helper, except on Linux, which ships none and draws the dialog from the
// daemon (DesktopPrompt).
func legacyPromptRenderer() string {
	if runtime.GOOS == "linux" {
		return "headless"
	}
	return "native"
}

var (
	campaignMu   sync.Mutex
	lastCampaign uint64
)

// newCampaignID is a Unix-millisecond stamp, strictly increasing within the
// process.
func newCampaignID(now time.Time) uint64 {
	campaignMu.Lock()
	defer campaignMu.Unlock()
	id := uint64(now.UnixMilli())
	if id <= lastCampaign {
		id = lastCampaign + 1
	}
	lastCampaign = id
	return id
}

// SetRestartSurface installs the restart card. Nil keeps today's ladder.
func (r *RebootManager) SetRestartSurface(s RestartSurface) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.surface = s
}

// currentCampaign is the live campaign (tests).
func (r *RebootManager) currentCampaign() uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.campaign
}

// restartRungLocked builds the card's view of the schedule. Callers hold r.mu.
func (r *RebootManager) restartRungLocked(final, resurface bool) RestartRung {
	rung := RestartRung{
		Campaign:        r.campaign,
		Final:           final,
		Resurface:       resurface,
		ScheduledAt:     r.state.ScheduledAt,
		Deadline:        r.state.Deadline,
		DeferralAllowed: r.deferral.Allowed && r.deferral.MaxDeferrals > 0,
		Text:            r.promptText,
	}
	if rung.DeferralAllowed {
		rung.DeferralsLeft = r.deferral.MaxDeferrals - r.deferralsUsed
		if rung.DeferralsLeft < 0 {
			rung.DeferralsLeft = 0
		}
	}
	if final || r.osInvoked || r.osInvoking || r.osAborting {
		return rung
	}
	now := r.nowFn()
	out := ComputeDeferral(r.deferral, r.deferralsUsed, now, r.state.ScheduledAt, r.state.Deadline)
	if !out.Granted {
		return rung
	}
	base := r.state.ScheduledAt
	if base.Before(now) {
		base = now
	}
	until := now.Add(out.NewDelay)
	if until.Sub(base) >= minPostponeGap {
		rung.PostponeUntil = until
	}
	return rung
}

// RestartRungNow is the card's view of the campaign as it stands (after a
// postponement: the new time and budget, not re-surfaced). ok is false when
// the campaign is no longer the scheduled one.
func (r *RebootManager) RestartRungNow(campaign uint64) (RestartRung, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if campaign == 0 || campaign != r.campaign || !r.state.RebootScheduled {
		return RestartRung{}, false
	}
	return r.restartRungLocked(false, false), true
}

// liveGeneration returns the generation of the campaign's current schedule.
func (r *RebootManager) liveGeneration(campaign uint64) (uint64, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if campaign == 0 || campaign != r.campaign || !r.state.RebootScheduled {
		return 0, fmt.Errorf("the restart was cancelled or replaced while the prompt was open")
	}
	return r.generation, nil
}

// UserPostpone applies a Postpone the person chose on the restart card of
// campaign, through the same atomic path as today's dialog (deferSchedule):
// refused once the campaign was cancelled or replaced, the budget is spent,
// the deadline leaves no room, or the OS countdown has started.
func (r *RebootManager) UserPostpone(campaign uint64, renderer string) error {
	gen, err := r.liveGeneration(campaign)
	if err != nil {
		return err
	}
	if _, err := r.deferForGeneration(gen); err != nil {
		return err
	}
	r.recordUserAction(UserActionPostponed, renderer)
	return nil
}

// UserRestartNow applies Restart now from the restart card of campaign: the
// countdown collapses to the shortest schedule (the closing card and the OS
// grace minute still run).
func (r *RebootManager) UserRestartNow(campaign uint64, renderer string) error {
	gen, err := r.liveGeneration(campaign)
	if err != nil {
		return err
	}
	if err := r.restartNow(gen); err != nil {
		return err
	}
	r.recordUserAction(UserActionRestartNow, renderer)
	return nil
}

func (r *RebootManager) recordUserAction(action, renderer string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.lastUserAction = &RebootUserAction{Action: action, At: r.nowFn(), Renderer: renderer}
}
