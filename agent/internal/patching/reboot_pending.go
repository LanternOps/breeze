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
//   - Every restore leaves at least minRestoreWarning before the OS hand-off:
//     a restart due sooner than that, or whose time passed while the agent
//     was down, moves to now+minRestoreWarning (later than promised, never
//     earlier); one more than maxRestoreOverdue late is dropped.
//   - The first desktop session that connects after a restore is told about
//     it once (AudienceConnected): the announcement at agent start reaches
//     nobody until a helper is up.
//   - Postponements already spent are neither given back nor counted twice.
//   - A cancelled, completed, blocked or held restart is not resurrected: the
//     record is cleared on every one of those paths, and it is tied to the
//     boot it was written in, so a machine that restarted for any reason
//     (including this restart) never restarts again because of it.
//   - A record from another enrollment (a reinstall or re-enroll keeps the
//     data folder), or one an agent of another version may have run over
//     since it was written (a rollback: an older agent cancels without
//     clearing it), is discarded.
//   - A record that is corrupt, out of range, or from a boot that cannot be
//     identified is discarded and logged, never acted on. One another account
//     could have written (a link, loose permissions, a foreign owner or
//     directory) is refused and logged without being read or rewritten.
//   - A write that fails removes the file rather than leave a stale record:
//     a lost restore is today's behaviour, a stale one is a resurrected or
//     early restart.
package patching

import (
	"crypto/sha256"
	"encoding/hex"
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

	// minRestoreWarning is the least time a restored restart leaves before
	// the machine goes down. One rule covers every restore: a restart due
	// sooner than this, or whose time passed while the agent was down, moves
	// to now+minRestoreWarning; one due later keeps its time. At agent start
	// no desktop helper is connected yet, so the announcement made then
	// reaches nobody on Windows and macOS, and a cancel queued while the
	// agent was down arrives only with the first heartbeat; on macOS the OS
	// restart cannot be called back once handed off. Fifteen minutes is the
	// same period an overdue restart always got: a lead warning, the 5-minute
	// reminder and the closing minute, with time for a helper to connect
	// (AudienceConnected re-announces then) and a cancel to land. Firing later
	// than the person was told is the safe direction.
	minRestoreWarning = 15 * time.Minute

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

// enrollmentDigest is what the record stores of the agent id: enough to tell
// one enrollment from another, without copying the id into another file.
func enrollmentDigest(agentID string) string {
	if agentID == "" {
		return ""
	}
	sum := sha256.Sum256([]byte("breeze-pending-restart:" + agentID))
	return hex.EncodeToString(sum[:16])
}

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

	// Enrollment is a digest of the agent id the record was written under.
	// A reinstall or re-enroll keeps the data folder but gets a new agent id,
	// so the previous enrollment's restart is never restored.
	Enrollment string `json:"enrollment"`
	// WriterVersion and WriterStart identify the agent process that wrote the
	// record: its version and its agent_start audit entry. A restore is
	// refused if an agent of any other version started after that entry: an
	// agent without this record (a rollback) cancels a restart without
	// clearing it.
	WriterVersion string `json:"writerVersion"`
	WriterStart   string `json:"writerStart"`
	// FirstDueAt is when the restart was due before any restore moved it to
	// leave the minimum warning. The 24-hour cutoff counts from it, so agent
	// restarts that keep moving the restart out cannot defer it for ever.
	FirstDueAt time.Time `json:"firstDueAt"`
}

// AgentRun identifies the agent process for the pending-restart record.
type AgentRun struct {
	// Version is this binary's version.
	Version string
	// StartToken is this process's agent_start audit entry; empty when it
	// could not be written, and then nothing this process writes is restored.
	StartToken string
	// StartsAfter lists the version of every agent start recorded after the
	// start token names, in order (this process's own included). found is
	// false when the token is not in the history.
	StartsAfter func(token string) (versions []string, found bool, err error)
}

// SetEnrollment installs the source of this agent's id.
func (r *RebootManager) SetEnrollment(agentID func() string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.enrollment = agentID
}

// SetAgentRun installs this process's identity and the agent start history.
func (r *RebootManager) SetAgentRun(run AgentRun) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.agentRun = run
}

// AudienceConnected reports that a desktop session able to show a warning
// connected. After a restore it announces the restart once more, to the
// sessions now connected: the announcement made at agent start went out
// before any helper was up. Only once per restore, and never once the OS
// countdown is running (the closing rung already said so).
func (r *RebootManager) AudienceConnected() {
	r.mu.Lock()
	campaign := r.reannounce
	if campaign == 0 {
		r.mu.Unlock()
		return
	}
	r.reannounce = 0
	left := r.state.ScheduledAt.Sub(r.nowFn())
	if r.stopped || !r.state.RebootScheduled || r.campaign != campaign ||
		r.osInvoked || r.osInvoking || r.osAborting || left <= finalNoticeLead {
		r.mu.Unlock()
		return
	}
	gen := r.generation
	r.mu.Unlock()
	// Warns without a dialog, like the announcement it repeats; the next
	// reminder rung offers the choice.
	r.emitNotification(gen, rebootRung{notification: restoredAnnouncement(left), quietLead: true})
}

// restoredAnnouncement is the lead notification of a plan with left to run.
func restoredAnnouncement(left time.Duration) RebootNotification {
	return RebootNotification{
		Title:     "Restart Scheduled",
		Body:      fmt.Sprintf("A system restart for updates is scheduled in %s. Please save your work.", humanizeRebootDelay(left)),
		Urgency:   leadUrgency(left),
		Countdown: left,
	}
}

// SetBootID installs the boot identity source. Without one nothing is ever
// restored: the manager cannot tell a restart still owed from one the machine
// already took.
func (r *RebootManager) SetBootID(f func() string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.bootID = f
}

// firstDueLocked is the time the current restart was first due: the anchor a
// restore carried, or else the scheduled time. Callers hold r.mu.
func (r *RebootManager) firstDueLocked() time.Time {
	if !r.dueAnchor.IsZero() {
		return r.dueAnchor
	}
	return r.state.ScheduledAt
}

func (r *RebootManager) currentAgentIDLocked() string {
	if r.enrollment == nil {
		return ""
	}
	return r.enrollment()
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
			Enrollment:      enrollmentDigest(r.currentAgentIDLocked()),
			WriterVersion:   r.agentRun.Version,
			WriterStart:     r.agentRun.StartToken,
			FirstDueAt:      r.firstDueLocked(),
		},
	}
	// Written anyway (the count still matters), but say now that it cannot
	// be restored, not at the next start when it is too late.
	if !usableBootID(ledger.Pending.BootID) {
		log.Warn("no boot identity: this restart will not survive an agent restart",
			"bootId", ledger.Pending.BootID, "campaign", r.campaign)
	}
	if ledger.Pending.Enrollment == "" || ledger.Pending.WriterVersion == "" || ledger.Pending.WriterStart == "" {
		log.Warn("agent enrollment, version or start record unknown: this restart will not survive an agent restart",
			"campaign", r.campaign, "hasEnrollment", ledger.Pending.Enrollment != "",
			"version", ledger.Pending.WriterVersion, "hasStartRecord", ledger.Pending.WriterStart != "")
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
	// Trust before content, on the same file: the checks and the read go
	// through one descriptor opened without following links, so the file
	// cannot be swapped between them. A file that fails is neither read nor
	// rewritten, only reported.
	ledger, err := r.readTrustedLedger(path)
	if _, untrusted := errors.AsType[*untrustedRecordError](err); untrusted {
		log.Warn("pending restart record is not trusted; not restoring it", "path", path, "error", err.Error())
		return false
	}
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
	// A reinstall or re-enroll keeps the data folder but not the agent id.
	if current := enrollmentDigest(r.currentAgentIDLocked()); current == "" || rec.Enrollment != current {
		return discard("pending restart record belongs to another enrollment of this agent, or the enrollment is unknown; not restoring it",
			"enrollmentKnown", current != "")
	}
	// An agent of another version that started after the writer may not know
	// this record: an older one cancels a restart without clearing it. Every
	// agent version records its start, with its version, in the audit log, so
	// this does not depend on the older agent's cooperation.
	if foreign, err := r.otherAgentStartedSinceLocked(rec); err != nil || foreign != "" {
		args := []any{"writerVersion", rec.WriterVersion, "currentVersion", r.agentRun.Version}
		if err != nil {
			return discard("cannot tell whether another agent ran since this restart was recorded; not restoring it",
				append(args, "error", err.Error())...)
		}
		return discard("an agent of another version ran since this restart was recorded (it may have cancelled it); not restoring it",
			append(args, "otherVersion", foreign)...)
	}

	// Compared as times: a Sub against a record decades back saturates.
	// Counted from when it was first due, so restores that each moved it out
	// by the minimum warning (an agent in a crash loop) cannot defer it for
	// ever.
	firstDue := rec.FirstDueAt
	if rec.ScheduledAt.Before(now.Add(-maxRestoreOverdue)) || firstDue.Before(now.Add(-maxRestoreOverdue)) {
		return discard("pending restart is more than a day overdue; not restoring it", "firstDueAt", firstDue)
	}
	delay := rec.ScheduledAt.Sub(now)
	overdue := delay <= 0
	moved := delay < minRestoreWarning
	if moved {
		delay = minRestoreWarning
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
	// Nobody may have seen the announcement just armed: repeat it to the
	// first desktop session that connects.
	r.reannounce = rec.Campaign
	r.dueAnchor = firstDue
	// Rewritten as this process's record: the moved time (what the console
	// now shows), the first due time the day-late cutoff counts from, and this
	// process as the writer the next restore checks the history against.
	r.savePendingLocked("restoring a pending restart")

	log.Info("restored a pending restart after an agent restart",
		"campaign", rec.Campaign,
		"scheduledAt", r.state.ScheduledAt,
		"originalScheduledAt", rec.ScheduledAt,
		"overdue", overdue,
		"moved", moved,
		"deadline", ledger.Deadline,
		"deferralsUsed", ledger.Used,
		"source", rec.Source)
	return true
}

// otherAgentStartedSinceLocked returns the version of an agent that started
// after the record's writer and is neither the writer's version nor this
// one's ("" when none did). This process's own start is in the history with
// the current version, and a same-version agent always clears the record on
// a cancel. An error, or a writer the history does not contain, means it
// cannot tell. Callers hold r.mu.
func (r *RebootManager) otherAgentStartedSinceLocked(rec *PendingRebootRecord) (string, error) {
	run := r.agentRun
	if run.StartsAfter == nil || run.Version == "" {
		return "", errors.New("no agent start history")
	}
	versions, found, err := run.StartsAfter(rec.WriterStart)
	if err != nil {
		return "", err
	}
	if !found {
		return "", errors.New("the agent start that wrote the record is not in the history")
	}
	for _, v := range versions {
		if v != rec.WriterVersion && v != run.Version {
			if v == "" {
				return "(unknown)", nil
			}
			return v, nil
		}
	}
	return "", nil
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
	// Compared as times, not durations: a Sub against a time centuries back
	// saturates and would read as merely late.
	if floor := now.Add(-maxRecordHorizon); rec.ScheduledAt.Before(floor) || ledger.Deadline.Before(floor) {
		return RebootOptions{}, errors.New("scheduled time or deadline is implausibly far in the past")
	}
	// A campaign is the Unix-millisecond time it was scheduled. One past the
	// horizon is not a schedule, and restoring it would let newCampaignID
	// wrap to zero (no campaign).
	if ceiling := now.Add(maxRecordHorizon).UnixMilli(); ceiling <= 0 || rec.Campaign > uint64(ceiling) {
		return RebootOptions{}, errors.New("campaign is implausibly far ahead")
	}
	if rec.Enrollment == "" || rec.WriterVersion == "" || rec.WriterStart == "" {
		return RebootOptions{}, errors.New("no enrollment, writer version or writer start")
	}
	if rec.FirstDueAt.IsZero() || rec.FirstDueAt.After(rec.ScheduledAt) {
		return RebootOptions{}, errors.New("first due time missing or after the scheduled time")
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

// untrustedRecordError is a record refused by the trust check, as opposed to
// one that could not be read or does not parse.
type untrustedRecordError struct{ err error }

func (e *untrustedRecordError) Error() string { return e.err.Error() }
func (e *untrustedRecordError) Unwrap() error { return e.err }

// readTrustedLedger reads the record only if the trust check passes, through
// the test seam when one is installed. The real check
// (readTrustedRecordFile, per platform) checks and reads one descriptor.
func (r *RebootManager) readTrustedLedger(path string) (DeferralLedger, error) {
	var data []byte
	if r.stateFileTrusted != nil {
		if err := r.stateFileTrusted(path); err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return DeferralLedger{}, err
			}
			return DeferralLedger{}, &untrustedRecordError{err}
		}
		d, err := os.ReadFile(path)
		if err != nil {
			return DeferralLedger{}, err
		}
		data = d
	} else {
		d, err := readTrustedRecordFile(path)
		if err != nil {
			return DeferralLedger{}, err
		}
		data = d
	}
	return parseDeferralLedger(data, path)
}

func readDeferralLedger(path string) (DeferralLedger, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return DeferralLedger{}, err
	}
	return parseDeferralLedger(data, path)
}

func parseDeferralLedger(data []byte, path string) (DeferralLedger, error) {
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
