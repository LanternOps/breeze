// Package bitlockerguard suspends BitLocker for a firmware install and guarantees
// it comes back. It is shared by every lane whose vendor tool does not manage
// BitLocker itself (Surface now; HP and Lenovo when they need it).
//
// The guarantee rests on one durable record, written before the volume changes:
//
//	record → suspend → mark installing → install → reboot → resume → remove record
//
// A record is the only proof a suspension is ours. A volume found suspended with
// no record belongs to someone else and is never touched, and Suspend refuses it
// outright, because a suspension of unknown count may run out mid-flash.
//
// Windows resumes by itself only after RebootCount reboots. A machine that gets
// fewer, or none, would stay unprotected, so ResumeOnStart runs at every agent
// start and on a timer until the record is gone.
package bitlockerguard

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/security"
)

var log = logging.L("bitlockerguard")

const (
	// MinRebootCount is the lowest count Suspend accepts. Microsoft's documents
	// disagree on how many reboots a firmware update takes, and a count that
	// runs out early can end in a recovery prompt. The Surface lab counts them.
	MinRebootCount = 3
	// maxRebootCount is Suspend-BitLocker's own upper limit.
	maxRebootCount = 15
	// ResumeDeadline is how long a suspended volume waits for its reboot. The
	// reboot is retried nightly and shows as overdue after 3 nights, so this
	// covers all of those and the next morning; past it, protection comes back
	// even though the staged firmware has not applied.
	ResumeDeadline = 96 * time.Hour
	// settleAfterBoot delays a resume after a boot, because Windows can finish
	// installing a firmware device, and ask for another reboot, after it starts.
	settleAfterBoot = 10 * time.Minute
	// lateSuspendGrace is how long a record whose volume still reads "on" stays
	// open with no install started. Killing PowerShell does not cancel the WMI
	// call behind it, so a suspend can land after it was given up on, and only
	// the record can show that suspension is ours.
	lateSuspendGrace = 10 * time.Minute

	recordFile = "bitlocker-guard.json"

	maxPCR = 23
)

var (
	// ErrRebootCount refuses a count below MinRebootCount, which includes 0:
	// Suspend-BitLocker reads 0 as "suspended until someone resumes it".
	ErrRebootCount = errors.New("bitlocker suspend needs a reboot count of 3 to 15")
	// ErrHeld means an earlier suspension of ours is still open.
	ErrHeld = errors.New("an earlier bitlocker suspension is still open")
	// ErrAlreadySuspended means the volume is suspended and the suspension is
	// not ours.
	ErrAlreadySuspended = errors.New("the volume is already suspended by something else")
	// ErrBitLockerOff means the volume is not encrypted: nothing to bind or suspend.
	ErrBitLockerOff = errors.New("bitlocker is off on this volume")
	// ErrStateUnknown means the volume's state could not be read.
	ErrStateUnknown = errors.New("bitlocker state is unknown")
	// ErrPreflightUnknown means the PCR binding could not be read, including
	// manage-bde output in a language the parser does not know.
	ErrPreflightUnknown = errors.New("bitlocker PCR binding is unknown")
	// ErrSuspendUnconfirmed means the suspend returned but the volume is not suspended.
	ErrSuspendUnconfirmed = errors.New("bitlocker suspend did not take effect")
	// ErrResumeUnconfirmed means the resume returned but the volume is not on.
	ErrResumeUnconfirmed = errors.New("bitlocker resume did not take effect")
	// ErrIndeterminate means a command was killed before it finished, so what it
	// asked for may still happen.
	ErrIndeterminate = errors.New("the command did not finish and may still take effect")

	errSeamsMissing = errors.New("bitlocker guard is missing a seam")
)

// Store is the durable, agent-owned file store. oemupdates.Store satisfies it.
type Store interface {
	// ReadFile returns fs.ErrNotExist when name is absent.
	ReadFile(name string) ([]byte, error)
	// WriteFile replaces name atomically and durably.
	WriteFile(name string, data []byte) error
	// Remove deletes name; an absent file is not an error.
	Remove(name string) error
}

// Deps is every external effect of the guard.
type Deps struct {
	Store Store
	// Now is the wall clock; nil means time.Now.
	Now func() time.Time
	// BootTime is when this boot started.
	BootTime func() (time.Time, error)
	// State reads the OS volume, as security.SystemDriveBitLockerState does. Any
	// error makes the reading unknown, even one that comes with "off".
	State func() (string, error)
	// Protectors returns manage-bde's TPM protector listing.
	Protectors func(ctx context.Context) (string, error)
	// SuspendVolume suspends the OS volume for count reboots.
	SuspendVolume func(ctx context.Context, count int) error
	// ResumeVolume re-enables protection on the OS volume.
	ResumeVolume func(ctx context.Context) error
	// RebootPending reports a reboot Windows still wants.
	RebootPending func() (bool, error)
}

func (d Deps) now() time.Time {
	if d.Now == nil {
		return time.Now()
	}
	return d.Now()
}

// readState collapses every failure to ErrStateUnknown. A host without the
// BitLocker module reports "off" with an error and may still be encrypted by
// device encryption, so the state alone is never trusted when an error came too.
func (d Deps) readState() (string, error) {
	state, err := d.State()
	if err != nil {
		return "", fmt.Errorf("%w: %v", ErrStateUnknown, err)
	}
	switch state {
	case security.BitLockerStateOn, security.BitLockerStateSuspended, security.BitLockerStateOff:
		return state, nil
	}
	return "", fmt.Errorf("%w: state %q", ErrStateUnknown, state)
}

// record is the durable proof of a suspension of ours.
type record struct {
	SuspendedAt time.Time `json:"suspendedAt"`
	Deadline    time.Time `json:"deadline"`
	RebootCount int       `json:"rebootCount"`
	// Installing is set before the first firmware install starts. Until then
	// nothing can be staged, so a restart may resume without waiting for a reboot.
	Installing bool `json:"installing"`
}

func readRecord(store Store) (record, bool, error) {
	data, err := store.ReadFile(recordFile)
	if errors.Is(err, fs.ErrNotExist) {
		return record{}, false, nil
	}
	if err != nil {
		return record{}, false, err
	}
	var r record
	if err := json.Unmarshal(data, &r); err != nil {
		return record{}, false, fmt.Errorf("bitlocker guard record is corrupt: %w", err)
	}
	if r.SuspendedAt.IsZero() || r.Deadline.IsZero() {
		return record{}, false, errors.New("bitlocker guard record has no times")
	}
	return r, true, nil
}

func writeRecord(store Store, r record) error {
	data, err := json.Marshal(r)
	if err != nil {
		return err
	}
	return store.WriteFile(recordFile, data)
}

// Token is a suspension Suspend made. A zero Token, or one from a volume with
// BitLocker off, is inactive: there is nothing to resume.
type Token struct {
	active bool
}

// Active reports whether this token holds a suspension of ours.
func (t Token) Active() bool { return t.active }

// Held reports an open record. An unreadable record comes back as an error, and
// the caller decides which way that fails.
func Held(deps Deps) (bool, error) {
	if deps.Store == nil {
		return false, errSeamsMissing
	}
	_, ok, err := readRecord(deps.Store)
	return ok, err
}

// Preflight reads whether BitLocker is bound to PCR 7 from manage-bde. Surface
// capsules are refused when it is not (vendor doc). Anything but a clean reading
// of the English labels, which includes every localized Windows, is
// ErrPreflightUnknown, so the caller fails closed.
func Preflight(ctx context.Context, deps Deps) (PCR7Bound bool, err error) {
	if deps.State == nil || deps.Protectors == nil {
		return false, errSeamsMissing
	}
	state, err := deps.readState()
	if err != nil {
		return false, err
	}
	switch state {
	case security.BitLockerStateOff:
		return false, ErrBitLockerOff
	case security.BitLockerStateSuspended:
		return false, ErrAlreadySuspended
	}
	out, err := deps.Protectors(ctx)
	if err != nil {
		return false, fmt.Errorf("%w: manage-bde: %v", ErrPreflightUnknown, err)
	}
	return parsePCR7(out)
}

const pcrProfileLabel = "pcr validation profile:"

// parsePCR7 reads every TPM protector's validation profile. All of them must
// include PCR 7. Errors here must never repeat the output, which on a misbehaving
// manage-bde could hold a recovery password.
func parsePCR7(out string) (bool, error) {
	lines := strings.Split(strings.ReplaceAll(out, "\r\n", "\n"), "\n")
	found, bound := false, true
	for i, line := range lines {
		if strings.ToLower(strings.TrimSpace(line)) != pcrProfileLabel {
			continue
		}
		found = true
		list := ""
		if i+1 < len(lines) {
			list = strings.TrimSpace(lines[i+1])
		}
		has7, err := listHasPCR7(list)
		if err != nil {
			return false, err
		}
		bound = bound && has7
	}
	if !found {
		return false, fmt.Errorf("%w: no validation profile in the output", ErrPreflightUnknown)
	}
	return bound, nil
}

func listHasPCR7(list string) (bool, error) {
	has7 := false
	for _, field := range strings.Split(list, ",") {
		n, err := strconv.Atoi(strings.TrimSpace(field))
		if err != nil || n < 0 || n > maxPCR {
			return false, fmt.Errorf("%w: the validation profile is not a list of PCRs", ErrPreflightUnknown)
		}
		has7 = has7 || n == 7
	}
	return has7, nil
}

// Suspend suspends the OS volume for rebootCount reboots and returns the token
// that resumes it. The record is durable before the volume changes, so a crash
// at any point leaves something ResumeOnStart can act on. A volume with BitLocker
// off gets an inactive token and no error. On any error the token is inactive and
// no firmware may be installed.
func Suspend(ctx context.Context, rebootCount int, deps Deps) (Token, error) {
	if rebootCount < MinRebootCount || rebootCount > maxRebootCount {
		return Token{}, fmt.Errorf("%w: got %d", ErrRebootCount, rebootCount)
	}
	if deps.Store == nil || deps.State == nil || deps.SuspendVolume == nil || deps.ResumeVolume == nil {
		return Token{}, errSeamsMissing
	}
	switch _, ok, err := readRecord(deps.Store); {
	case err != nil:
		return Token{}, err
	case ok:
		return Token{}, ErrHeld
	}
	state, err := deps.readState()
	if err != nil {
		return Token{}, err
	}
	switch state {
	case security.BitLockerStateOff:
		return Token{}, nil
	case security.BitLockerStateSuspended:
		return Token{}, ErrAlreadySuspended
	}
	now := deps.now()
	if err := writeRecord(deps.Store, record{SuspendedAt: now, Deadline: now.Add(ResumeDeadline), RebootCount: rebootCount}); err != nil {
		return Token{}, fmt.Errorf("record the bitlocker suspension: %w", err)
	}
	suspendErr := deps.SuspendVolume(ctx, rebootCount)
	after, stateErr := deps.readState()
	if suspendErr == nil && stateErr == nil && after == security.BitLockerStateSuspended {
		log.Info("bitlocker suspended for a firmware install", "rebootCount", rebootCount)
		return Token{active: true}, nil
	}
	failure := suspendErr
	if failure == nil {
		failure = ErrSuspendUnconfirmed
	}
	switch {
	case stateErr != nil:
		// The volume may be ours and suspended. The record stays so the next
		// pass finds out, and no firmware is installed.
		return Token{}, errors.Join(failure, stateErr)
	case after == security.BitLockerStateSuspended:
		// It failed, then took effect. Ours, so it goes straight back.
		return Token{}, errors.Join(failure, resumeNow(ctx, deps))
	case errors.Is(failure, ErrIndeterminate) || ctx.Err() != nil:
		// It reads on now, but the suspend may still land. ResumeOnStart settles
		// it; removing the record here would make a late suspend look like
		// someone else's, and it would never be resumed.
		return Token{}, failure
	}
	return Token{}, errors.Join(failure, deps.Store.Remove(recordFile))
}

// MarkInstalling records that a firmware install is about to start. From here a
// restart waits for the reboot rather than resuming under a staged capsule. It
// must be durable, so an error means no install.
func MarkInstalling(t Token, deps Deps) error {
	if !t.active {
		return nil
	}
	r, ok, err := readRecord(deps.Store)
	if err != nil {
		return err
	}
	if !ok {
		return errors.New("bitlocker guard record is gone")
	}
	r.Installing = true
	return writeRecord(deps.Store, r)
}

// Resume puts back a suspension right away, for a run that ended with nothing
// staged. On an error the record stays and ResumeOnStart keeps trying, without
// waiting for a reboot nothing needs. With no record the suspension is no longer
// ours, so a token alone resumes nothing.
func Resume(ctx context.Context, t Token, deps Deps) error {
	if !t.active {
		return nil
	}
	r, ok, err := readRecord(deps.Store)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	if r.Installing {
		r.Installing = false
		if err := writeRecord(deps.Store, r); err != nil {
			log.Warn("could not record that nothing is staged; a failed resume would wait for a reboot", "error", err.Error())
		}
	}
	return resumeNow(ctx, deps)
}

// RebootOwed reports a firmware install still waiting for its reboot: a record
// whose install started, with no boot since the suspend. An unreadable boot time
// counts as owed, because a flash started and nothing shows the reboot happened.
func RebootOwed(deps Deps) (bool, error) {
	if deps.Store == nil {
		return false, errSeamsMissing
	}
	r, ok, err := readRecord(deps.Store)
	if err != nil || !ok || !r.Installing {
		return false, err
	}
	if deps.BootTime == nil {
		return true, nil
	}
	boot, err := deps.BootTime()
	if err != nil {
		return true, nil
	}
	return !boot.After(r.SuspendedAt), nil
}

// resumeNow re-enables a volume whose record is ours, confirms it, and only then
// removes the record.
func resumeNow(ctx context.Context, deps Deps) error {
	state, err := deps.readState()
	if err != nil {
		return err
	}
	if state != security.BitLockerStateSuspended {
		return deps.Store.Remove(recordFile)
	}
	if err := deps.ResumeVolume(ctx); err != nil {
		return fmt.Errorf("resume bitlocker: %w", err)
	}
	after, err := deps.readState()
	if err != nil {
		return err
	}
	if after == security.BitLockerStateSuspended {
		return ErrResumeUnconfirmed
	}
	return deps.Store.Remove(recordFile)
}

// Action is what ResumeOnStart did.
type Action string

const (
	// ActionNone: no record, so nothing of ours to do.
	ActionNone Action = "none"
	// ActionHeld: a record is open and it is not time yet, or the reading failed.
	ActionHeld Action = "held"
	// ActionResumed: this call re-enabled protection.
	ActionResumed Action = "resumed"
	// ActionCleared: the volume was no longer suspended, so the record was closed.
	ActionCleared Action = "cleared"
)

// Why it did it.
const (
	ReasonWaitingForReboot = "waiting_for_reboot"
	ReasonSettling         = "boot_settling"
	ReasonRebootPending    = "reboot_still_pending"
	ReasonSuspendMayLand   = "suspend_may_still_land"
	ReasonRebooted         = "rebooted"
	ReasonNoInstall        = "no_install_started"
	// ReasonDeadline is the one a person must hear about: protection is back but
	// the reboot never came, so any staged firmware has not applied.
	ReasonDeadline = "reboot_never_happened"
)

// Result is what ResumeOnStart did and why.
type Result struct {
	Action Action
	Reason string
}

// ResumeOnStart acts on the durable record, so it works whatever happened to the
// process that wrote it. The caller must not run it during a run that holds the
// record: oemupdates.ResumeBitLocker takes the run lock first.
//
// Only a volume with a record is ever resumed. The order of the checks is the
// policy:
//   - not suspended, no install started, inside the grace: hold; a killed suspend
//     may still land.
//   - not suspended: Windows (or a person) already dealt with it; close the record.
//   - past the deadline: resume, whatever else is true.
//   - no install started: nothing is staged; resume.
//   - no reboot yet: hold. Resuming under a staged capsule risks a recovery prompt.
//   - rebooted, but still settling or another reboot is flagged: hold.
//   - otherwise: resume.
func ResumeOnStart(ctx context.Context, deps Deps) (Result, error) {
	if deps.Store == nil || deps.State == nil || deps.ResumeVolume == nil {
		return Result{}, errSeamsMissing
	}
	r, ok, err := readRecord(deps.Store)
	if err != nil {
		return Result{Action: ActionHeld}, err
	}
	if !ok {
		return Result{Action: ActionNone}, nil
	}
	state, err := deps.readState()
	if err != nil {
		return Result{Action: ActionHeld}, err
	}
	if state != security.BitLockerStateSuspended {
		if !r.Installing && deps.now().Sub(r.SuspendedAt) < lateSuspendGrace {
			return Result{Action: ActionHeld, Reason: ReasonSuspendMayLand}, nil
		}
		if err := deps.Store.Remove(recordFile); err != nil {
			return Result{Action: ActionHeld}, err
		}
		return Result{Action: ActionCleared}, nil
	}

	reason := resumeReason(r, deps)
	if reason.Action == ActionHeld {
		return reason, nil
	}
	if err := resumeNow(ctx, deps); err != nil {
		return Result{Action: ActionHeld, Reason: reason.Reason}, err
	}
	log.Info("bitlocker resumed", "reason", reason.Reason)
	return reason, nil
}

func resumeReason(r record, deps Deps) Result {
	now := deps.now()
	if !now.Before(r.Deadline) {
		return Result{Action: ActionResumed, Reason: ReasonDeadline}
	}
	if !r.Installing {
		return Result{Action: ActionResumed, Reason: ReasonNoInstall}
	}
	held := func(reason string) Result { return Result{Action: ActionHeld, Reason: reason} }
	if deps.BootTime == nil {
		return held(ReasonWaitingForReboot)
	}
	boot, err := deps.BootTime()
	if err != nil {
		log.Debug("boot time unreadable; holding the bitlocker resume", "error", err.Error())
		return held(ReasonWaitingForReboot)
	}
	if !boot.After(r.SuspendedAt) {
		return held(ReasonWaitingForReboot)
	}
	if now.Sub(boot) < settleAfterBoot {
		return held(ReasonSettling)
	}
	if deps.RebootPending == nil {
		return held(ReasonRebootPending)
	}
	pending, err := deps.RebootPending()
	if err != nil {
		log.Debug("pending reboot unreadable; holding the bitlocker resume", "error", err.Error())
		return held(ReasonRebootPending)
	}
	if pending {
		return held(ReasonRebootPending)
	}
	return Result{Action: ActionResumed, Reason: ReasonRebooted}
}

var mountPointPattern = regexp.MustCompile(`^[A-Za-z]:$`)

// mountPoint is the volume the commands name: the system drive, or C: when the
// environment does not say. A value that is not a bare drive letter is refused,
// because it reaches a command line.
func mountPoint(systemDrive string) (string, error) {
	drive := strings.TrimSpace(systemDrive)
	if drive == "" {
		return "C:", nil
	}
	if !mountPointPattern.MatchString(drive) {
		return "", fmt.Errorf("system drive %q is not a drive letter", drive)
	}
	return strings.ToUpper(drive), nil
}

func suspendScript(drive string, count int) (string, error) {
	if count < MinRebootCount || count > maxRebootCount {
		return "", fmt.Errorf("%w: got %d", ErrRebootCount, count)
	}
	if !mountPointPattern.MatchString(drive) {
		return "", fmt.Errorf("mount point %q is not a drive letter", drive)
	}
	return fmt.Sprintf("Suspend-BitLocker -MountPoint '%s' -RebootCount %d -ErrorAction Stop | Out-Null", drive, count), nil
}

func resumeScript(drive string) (string, error) {
	if !mountPointPattern.MatchString(drive) {
		return "", fmt.Errorf("mount point %q is not a drive letter", drive)
	}
	return fmt.Sprintf("Resume-BitLocker -MountPoint '%s' -ErrorAction Stop | Out-Null", drive), nil
}

// boundedBuffer keeps at most limit bytes and says when it overflowed. A Write
// never fails, so a chatty process is not killed by its own pipe.
type boundedBuffer struct {
	data     []byte
	limit    int
	overflow bool
}

func (b *boundedBuffer) Write(p []byte) (int, error) {
	keep := p
	if room := b.limit - len(b.data); len(p) > room {
		b.overflow = true
		keep = p[:max(room, 0)]
	}
	b.data = append(b.data, keep...)
	return len(p), nil
}

// commandError describes how a PowerShell command ended. A process the context
// killed says nothing about the WMI call behind it, which may still land. stderr
// is included because it holds the reason; these commands print no key material.
// manage-bde's output never comes through here.
func commandError(ctx context.Context, err error, stderr *boundedBuffer) error {
	if err == nil {
		return nil
	}
	if ctx.Err() != nil {
		return fmt.Errorf("%w: %v", ErrIndeterminate, err)
	}
	if stderr != nil {
		if text := strings.Join(strings.Fields(string(stderr.data)), " "); text != "" {
			return fmt.Errorf("%w: %s", err, text)
		}
	}
	return err
}

// manageBdeArgs asks for TPM protectors only, so a recovery password is never in
// the output this process reads.
func manageBdeArgs(drive string) []string {
	return []string{"-protectors", "-get", drive, "-Type", "TPM"}
}

// SystemDeps wires the real machine. The two readers come from the caller, which
// owns those facts.
func SystemDeps(store Store, bootTime func() (time.Time, error), rebootPending func() (bool, error)) Deps {
	return Deps{
		Store:         store,
		BootTime:      bootTime,
		State:         security.SystemDriveBitLockerState,
		Protectors:    systemProtectors,
		SuspendVolume: systemSuspend,
		ResumeVolume:  systemResume,
		RebootPending: rebootPending,
	}
}
