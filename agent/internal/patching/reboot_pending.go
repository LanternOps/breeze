// A pending restart survives an agent restart (#12827).
//
// Untagged for the reason reboot_plan.go is. Only the file-trust check is
// platform-specific (reboot_pending_unix.go / reboot_pending_windows.go).
//
// The warning ladder and the OS timer live in this process. Before #12827 an
// agent service restart, crash or upgrade in the middle of a campaign took
// them with it: no further reminders, no restart, and the next heartbeat
// reported rebootStatus null, which is the server's signal that nothing is
// scheduled any more — so the console stopped showing the restart too. The
// server never re-issues a schedule_reboot it already saw complete.
//
// The fix extends the on-disk deferral ledger (reboot_deferral.go), which
// already carried the postponement count across an agent restart, into a
// record of the whole pending schedule. One file, one atomic write: the
// count and the schedule can never disagree after a crash, and an older
// agent still reads the same file as a plain ledger.
//
// Invariants, each pinned in reboot_manager_restore_test.go:
//   - A restored restart fires at the time the person was last told, never
//     earlier, and its reminders keep their wall-clock times.
//   - A restart whose time passed while the agent was down gets a fresh
//     warning period (restoredOverdueWarning), never an immediate restart;
//     one more than maxRestoreOverdue late is dropped.
//   - Postponements already spent are neither given back nor counted twice.
//   - A cancelled, completed, blocked or held restart is not resurrected: the
//     record is cleared on every one of those paths, and it is tied to the
//     boot it was written in, so a machine that restarted for any reason
//     (including this restart) never restarts again because of it.
//   - A record that is corrupt, out of range, or from a boot that cannot be
//     identified is discarded and logged, never acted on. One another account
//     could have written (a link, loose permissions, a foreign owner or
//     directory) is refused and logged without being read or rewritten.
//   - A write that fails removes the file rather than leave a stale record:
//     a lost restore is today's behaviour, a stale one is a resurrected or
//     early restart.
package patching

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	// pendingRecordVersion is the shape of PendingRebootRecord. A record of
	// any other version is discarded rather than guessed at.
	pendingRecordVersion = 1

	// restoredOverdueWarning is the warning period a restart gets when its
	// time passed while the agent was down. The person may have been told
	// "restarting at 14:00" an hour ago and then heard nothing; restarting the
	// moment the agent comes back would be a restart with no warning they
	// could act on. Fifteen minutes is a lead warning, the 5-minute reminder
	// and the closing minute.
	restoredOverdueWarning = 15 * time.Minute

	// maxRestoreOverdue is how late a restart may be and still be restored.
	// Past it the agent was stopped deliberately for a long time (an
	// administrator, a support session); restarting the machine a day later
	// without anyone asking again is not what the operator scheduled.
	maxRestoreOverdue = 24 * time.Hour

	// maxRecordHorizon bounds every time in a record. The longest schedule
	// the API sends is seven days and a deadline is not much further out;
	// anything beyond this is corruption, not a schedule.
	maxRecordHorizon = 31 * 24 * time.Hour

	// Sanity bounds on a record's budget and text: a record past them was not
	// written by this manager.
	maxRecordDeferrals       = 100
	maxRecordDeferralMinutes = 7 * 24 * 60
	maxRecordText            = 4096
)

// PendingRebootRecord is the schedule part of the on-disk ledger: everything
// needed to re-arm the restart a person was warned about. The deadline and the
// postponement count stay where they always were (DeferralLedger.Deadline and
// .Used), so the ledger's existing readers see no change.
type PendingRebootRecord struct {
	Version int `json:"version"`
	// Campaign is the operator's restart (RestartRung.Campaign). Restoring it
	// keeps the restart card, its tombstones and the after-restart entry
	// keyed to the same restart.
	Campaign uint64 `json:"campaign"`
	// ScheduledAt is when the restart fires, as last announced.
	ScheduledAt time.Time `json:"scheduledAt"`
	Reason      string    `json:"reason"`
	Source      string    `json:"source"`

	DeferralAllowed bool `json:"deferralAllowed"`
	MaxDeferrals    int  `json:"maxDeferrals"`
	DeferralMinutes int  `json:"deferralMinutes"`

	PromptTitle  string `json:"promptTitle,omitempty"`
	PromptBody   string `json:"promptBody,omitempty"`
	PromptButton string `json:"promptButton,omitempty"`

	DeadlineAction string `json:"deadlineAction,omitempty"`

	// BootID is the boot the record was written in. A record from any other
	// boot describes a restart that already happened, or one the machine's
	// own restart made moot.
	BootID string `json:"bootId"`
}

// SetBootID installs the boot identity source. Without one nothing is ever
// restored: the manager cannot tell a restart still owed from one the machine
// already took.
func (r *RebootManager) SetBootID(f func() string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bootID = f
}

func (r *RebootManager) currentBootIDLocked() string {
	if r.bootID == nil {
		return ""
	}
	return r.bootID()
}

// usableBootID reports whether id identifies a boot. A process-scoped id is
// the boot-identity source's own fallback when the OS would not say, and is
// different in every process by construction.
func usableBootID(id string) bool {
	return id != "" && !strings.HasPrefix(id, "process:")
}

// persistPendingLocked writes the current schedule (or, with nothing
// scheduled, clears the schedule part) to the ledger. Callers hold r.mu.
// Best-effort: the in-memory schedule is the truth for this process. A write
// that fails removes the file instead, because the record it would have
// replaced describes an EARLIER time (before a postponement) or a different
// restart (before a new schedule): restoring that is worse than restoring
// nothing. Losing the file costs the restore and, at most, one postponement.
func (r *RebootManager) persistPendingLocked() error {
	if !r.state.RebootScheduled || r.state.ScheduledAt.IsZero() || r.campaign == 0 {
		return r.clearPendingLocked()
	}
	path := r.ledgerPath()
	if path == "" {
		return nil
	}
	ledger := DeferralLedger{
		Deadline: r.state.Deadline,
		Used:     r.deferralsUsed,
		Pending: &PendingRebootRecord{
			Version:         pendingRecordVersion,
			Campaign:        r.campaign,
			ScheduledAt:     r.state.ScheduledAt,
			Reason:          r.state.Reason,
			Source:          r.state.Source,
			DeferralAllowed: r.deferral.Allowed,
			MaxDeferrals:    r.deferral.MaxDeferrals,
			DeferralMinutes: r.deferral.DeferralMinutes,
			PromptTitle:     r.promptText.Title,
			PromptBody:      r.promptText.Body,
			PromptButton:    r.promptText.Button,
			DeadlineAction:  string(r.deadlineAction),
			BootID:          r.currentBootIDLocked(),
		},
	}
	if !usableBootID(ledger.Pending.BootID) {
		// Written anyway (the count still matters), but say now that it
		// cannot be restored, not at the next start when it is too late.
		log.Warn("no boot identity: this restart will not survive an agent restart",
			"bootId", ledger.Pending.BootID, "campaign", r.campaign)
	}
	return writeOrRemoveLedger(path, ledger)
}

// savePendingLocked is persistPendingLocked for the paths where a failure is
// only worth a warning.
func (r *RebootManager) savePendingLocked(why string) {
	if err := r.persistPendingLocked(); err != nil {
		log.Warn("pending restart record not written; an agent restart before the restart drops it",
			"path", r.ledgerPath(), "after", why, "error", err.Error())
	}
}

// clearPendingLocked removes the schedule part of the ledger, keeping the
// deadline and count exactly as a pre-#12827 ledger would have them. Callers
// hold r.mu.
func (r *RebootManager) clearPendingLocked() error {
	path := r.ledgerPath()
	if path == "" {
		return nil
	}
	ledger, err := readDeferralLedger(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if errors.Is(err, errLedgerCorrupt) {
		// Corrupt is as good as gone for a restore, but leaving it would
		// make every later clear and restore trip over it again.
		return removeLedger(path)
	}
	if err != nil {
		return err
	}
	if ledger.Pending == nil {
		return nil
	}
	ledger.Pending = nil
	return writeOrRemoveLedger(path, ledger)
}

// writeOrRemoveLedger writes the ledger and, if that fails, removes the file:
// a record left behind by a failed rewrite is a restart that was cancelled,
// superseded or moved, and an agent restart in the same boot would re-arm it.
// The error says whether the fallback worked.
func writeOrRemoveLedger(path string, ledger DeferralLedger) error {
	err := writeLedger(path, ledger)
	if err == nil {
		return nil
	}
	if rmErr := removeLedger(path); rmErr != nil {
		return fmt.Errorf("%w; the previous record could not be removed either and may be restored after an agent restart in this boot: %v", err, rmErr)
	}
	return fmt.Errorf("%w; the previous record was removed instead (the postponement count is lost)", err)
}

// writeLedger is the ledger write, a seam for the failure tests.
var writeLedger = writeDeferralLedger

// dropPendingLocked clears the record on a path that has already decided
// nothing will be restored, logging a failure instead of returning it. Error,
// not Warn: if both the rewrite and the removal failed, an agent restart in
// this boot brings the restart back.
func (r *RebootManager) dropPendingLocked(why string) {
	if err := r.clearPendingLocked(); err != nil {
		log.Error("pending restart record not cleared",
			"path", r.ledgerPath(), "after", why, "error", err.Error())
	}
}

// RestorePendingReboot re-arms the restart this agent had scheduled before it
// last stopped, if there is one and it is still owed. Called once at agent
// start, after the restart surface is installed and before the first
// heartbeat, so the console never sees the restart disappear. It reports
// whether a restart was restored.
func (r *RebootManager) RestorePendingReboot() bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.stopped || r.state.RebootScheduled || r.osInvoked || r.osInvoking || r.osAborting {
		// A schedule this process already holds is newer than anything on
		// disk (Schedule is last-writer-wins).
		return false
	}
	path := r.ledgerPath()
	if path == "" {
		return false
	}
	// Trust before content: a file that fails it is neither read nor
	// rewritten, only reported.
	if err := r.trustStateFile(path); errors.Is(err, os.ErrNotExist) {
		return false
	} else if err != nil {
		log.Warn("pending restart record is not trusted; not restoring it", "path", path, "error", err.Error())
		return false
	}
	ledger, err := readDeferralLedger(path)
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	if errors.Is(err, errLedgerCorrupt) {
		log.Warn("pending restart record is corrupt; discarding it", "path", path, "error", err.Error())
		if rmErr := removeLedger(path); rmErr != nil {
			log.Warn("corrupt pending restart record could not be removed", "path", path, "error", rmErr.Error())
		}
		return false
	}
	if err != nil {
		// Not readable (permissions, I/O): leave it alone. Nothing here can
		// tell whether it is ours, so it is neither acted on nor deleted.
		log.Warn("pending restart record could not be read; not restoring it", "path", path, "error", err.Error())
		return false
	}
	rec := ledger.Pending
	if rec == nil {
		return false
	}
	discard := func(msg string, args ...any) bool {
		log.Warn(msg, append(args, "path", path, "campaign", rec.Campaign, "scheduledAt", rec.ScheduledAt)...)
		r.dropPendingLocked("discarding a pending restart record")
		return false
	}

	now := r.nowFn()
	opts, err := rec.restoreOptions(ledger, now)
	if err != nil {
		return discard("pending restart record is invalid; discarding it", "error", err.Error())
	}
	boot := r.currentBootIDLocked()
	if !usableBootID(rec.BootID) || !usableBootID(boot) {
		return discard("cannot tell whether the machine restarted since this restart was scheduled; not restoring it",
			"recordBoot", rec.BootID, "currentBoot", boot)
	}
	if rec.BootID != boot {
		log.Info("the machine restarted since this restart was scheduled; it is not restored",
			"campaign", rec.Campaign, "scheduledAt", rec.ScheduledAt)
		r.dropPendingLocked("a restart from an earlier boot")
		return false
	}

	delay := rec.ScheduledAt.Sub(now)
	overdue := delay <= 0
	if overdue {
		if -delay > maxRestoreOverdue {
			return discard("pending restart is more than a day overdue; not restoring it", "overdueBy", (-delay).String())
		}
		delay = restoredOverdueWarning
	}
	// The re-announcement warns without a dialog, as after a postponement
	// (#4941): the person may have answered one moments before the agent
	// stopped. The next reminder rung offers the choice again.
	if err := r.scheduleLockedAt(now, delay, ledger.Deadline, rec.Reason, rec.Source, opts, leadRungWarnsOnly); err != nil {
		return discard("pending restart could not be re-armed; discarding it", "error", err.Error())
	}
	// scheduleLockedAt reloads the count only for a live deadline; the record
	// is the authority here, past deadline or not.
	r.deferralsUsed = ledger.Used
	r.state.DeferralsUsed = ledger.Used
	r.campaign = rec.Campaign
	noteCampaignID(rec.Campaign)
	// An overdue restore moved the time: record it, so another agent restart
	// inside the warning period does not push the restart out again.
	r.savePendingLocked("restoring a pending restart")

	log.Info("restored a pending restart after an agent restart",
		"campaign", rec.Campaign,
		"scheduledAt", r.state.ScheduledAt,
		"originalScheduledAt", rec.ScheduledAt,
		"overdue", overdue,
		"deadline", ledger.Deadline,
		"deferralsUsed", ledger.Used,
		"source", rec.Source)
	return true
}

// restoreOptions validates the record against the ledger it sits in and
// rebuilds the schedule's options. Any error discards the record.
func (rec *PendingRebootRecord) restoreOptions(ledger DeferralLedger, now time.Time) (RebootOptions, error) {
	if rec.Version != pendingRecordVersion {
		return RebootOptions{}, fmt.Errorf("unknown record version %d", rec.Version)
	}
	if rec.Campaign == 0 {
		return RebootOptions{}, errors.New("no campaign")
	}
	if rec.ScheduledAt.IsZero() || ledger.Deadline.IsZero() {
		return RebootOptions{}, errors.New("no scheduled time or deadline")
	}
	if rec.ScheduledAt.Sub(now) > maxRecordHorizon || ledger.Deadline.Sub(now) > maxRecordHorizon {
		return RebootOptions{}, errors.New("scheduled time or deadline is implausibly far ahead")
	}
	if len(rec.Reason) > maxRecordText || len(rec.Source) > maxRecordText {
		return RebootOptions{}, errors.New("reason or source too long")
	}
	if ledger.Used < 0 {
		return RebootOptions{}, errors.New("negative postponement count")
	}
	var policy DeferralPolicy
	if rec.DeferralAllowed {
		if rec.MaxDeferrals < 1 || rec.MaxDeferrals > maxRecordDeferrals ||
			rec.DeferralMinutes < 1 || rec.DeferralMinutes > maxRecordDeferralMinutes {
			return RebootOptions{}, errors.New("postponement budget out of range")
		}
		if ledger.Used > rec.MaxDeferrals {
			return RebootOptions{}, errors.New("more postponements used than allowed")
		}
		policy = DeferralPolicy{Allowed: true, MaxDeferrals: rec.MaxDeferrals, DeferralMinutes: rec.DeferralMinutes}
	} else if rec.MaxDeferrals != 0 || rec.DeferralMinutes != 0 || ledger.Used != 0 {
		return RebootOptions{}, errors.New("postponement figures on a restart that cannot be postponed")
	}
	action, err := ParseDeadlineAction(rec.DeadlineAction, rec.DeadlineAction != "")
	if err != nil {
		return RebootOptions{}, err
	}
	// The same sanitiser the schedule_reboot payload went through: a field
	// that fails it falls back to the built-in text, the safe direction for
	// copy.
	text, dropped := SanitizeRebootPromptText(RebootPromptText{
		Title: rec.PromptTitle, Body: rec.PromptBody, Button: rec.PromptButton,
	})
	if len(dropped) > 0 {
		log.Warn("pending restart record's prompt text failed validation; using the built-in text for those fields",
			"fields", dropped)
	}
	return RebootOptions{Deferral: policy, Prompt: text, DeadlineAction: action}, nil
}

// trustStateFile resolves the trust check through the test seam.
func (r *RebootManager) trustStateFile(path string) error {
	if r.stateFileTrusted != nil {
		return r.stateFileTrusted(path)
	}
	return trustPendingRecordFile(path)
}

func readDeferralLedger(path string) (DeferralLedger, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return DeferralLedger{}, err
	}
	var ledger DeferralLedger
	if err := json.Unmarshal(data, &ledger); err != nil {
		return DeferralLedger{}, fmt.Errorf("%w: %s: %v", errLedgerCorrupt, path, err)
	}
	return ledger, nil
}

// errLedgerCorrupt marks a ledger that was read but does not parse.
var errLedgerCorrupt = errors.New("reboot ledger is corrupt")

func removeLedger(path string) error {
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}
