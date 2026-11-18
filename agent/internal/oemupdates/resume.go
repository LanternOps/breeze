package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"time"

	"github.com/breeze-rmm/agent/internal/oemupdates/bitlockerguard"
)

var (
	// ErrVerificationNotFound is a 404 from the verification route: an API that
	// does not have it yet, or a command it does not know yet. Retried.
	ErrVerificationNotFound = errors.New("verification route or command not found")
	// ErrVerificationRejected is a refusal that retrying cannot fix. Not retried.
	ErrVerificationRejected = errors.New("verification rejected")
)

const (
	maxVerifyAttemptsPerStart = 8
	verifyBackoffBase         = 30 * time.Second
	verifyBackoffMax          = 30 * time.Minute
)

// resumeSleep waits between report attempts; a variable for tests.
var resumeSleep = func(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ResumePending is RecoverInterrupted then VerifyPending. The agent calls the
// two separately: the first before it accepts commands, the second in the
// background.
func ResumePending(ctx context.Context, deps Deps, report func(Verification) error) error {
	if err := RecoverInterrupted(deps); err != nil {
		log.Warn("could not close an interrupted vendor update run", "error", err.Error())
	}
	return VerifyPending(ctx, deps, report)
}

// RecoverInterrupted closes the marker of a run the previous process never
// finished. Its interrupted result reaches the server through the command
// journal, which reads the marker first. It takes the run lock, so it never
// closes the marker of a run that is live in this process.
func RecoverInterrupted(deps Deps) error {
	release, err := AcquireRunLock(deps.Store)
	if err != nil {
		return nil // a run is live; its marker is its own
	}
	defer release()
	m, err := ReadMarker(deps.Store)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	if m.EndedAt != nil {
		return nil
	}
	now := deps.now()
	m.EndedAt = &now
	m.Outcome = OutcomeInterrupted
	if err := WriteMarker(deps.Store, m); err != nil {
		return fmt.Errorf("close interrupted marker: %w", err)
	}
	log.Warn("a vendor update run was interrupted by an agent stop",
		"commandId", m.CommandID, "lane", m.Lane, "stage", m.Stage, "flashStarted", m.FlashStarted)
	return nil
}

// ResumeBitLocker runs the BitLocker guard's resume pass, unless a run is live or
// a flash section is open: both may own the suspension in the record, and a resume
// under a staged capsule risks a recovery prompt. It runs at start and on a timer.
//
// A resume past the deadline is logged at WARN, which ships to the server. It is
// not reported through the verification route: that route means "the device
// rebooted" and would clear a reboot still owed. The reboot-overdue state already
// tells the tech that reboot has not happened.
func ResumeBitLocker(ctx context.Context, deps Deps, guard bitlockerguard.Deps) (bitlockerguard.Result, error) {
	held := bitlockerguard.Result{Action: bitlockerguard.ActionHeld}
	release, err := AcquireRunLock(deps.Store)
	if err != nil {
		return held, nil // a run is live; the record is its own
	}
	defer release()
	if deps.Guard != nil {
		if _, active := deps.Guard.Active(); active {
			return held, nil
		}
	}
	res, err := bitlockerguard.ResumeOnStart(ctx, guard)
	if err == nil && res.Action == bitlockerguard.ActionResumed && res.Reason == bitlockerguard.ReasonDeadline {
		log.Warn("BitLocker resumed after a firmware install because the reboot never happened; staged firmware has not applied",
			"deadline", bitlockerguard.ResumeDeadline.String())
	}
	return res, err
}

// VerifyPending reports, after the reboot each needed, BitLocker and the BIOS
// version for every recorded firmware install. It only reads: a volume still
// suspended is reported, never changed (Decision 8; ResumeBitLocker owns the
// suspensions Breeze made itself, and runs first). An entry ends when the
// report is accepted or rejected, or when it ages out; a transient failure
// keeps it for the next start. It never touches the run marker.
func VerifyPending(ctx context.Context, deps Deps, report func(Verification) error) error {
	list, err := readPendingVerifications(deps.Store)
	if err != nil {
		return fmt.Errorf("read pending verifications: %w", err)
	}
	if len(list) == 0 {
		return nil
	}
	// A volume the guard is about to resume would read "suspended" and raise an
	// alert for nothing. The entries wait for the guard's next pass.
	if deps.BitLockerHeld != nil && deps.BitLockerHeld() {
		log.Debug("vendor update verification waits for the BitLocker guard")
		return nil
	}
	if deps.System == nil || deps.Protectors == nil {
		return errors.New("verification needs system and protector readers")
	}
	boot, err := deps.System.BootTime()
	if err != nil {
		return fmt.Errorf("read boot time: %w", err)
	}
	var errs []error
	for _, p := range list {
		if deps.now().Sub(p.VerifyAfter) > maxVerifyAge {
			log.Warn("vendor update verification aged out unsent", "commandId", p.CommandID, "verifyAfter", p.VerifyAfter)
			_ = removePendingVerification(deps.Store, p.CommandID)
			continue
		}
		// Before the reboot BitLocker reads "suspended" by design and the BIOS
		// is still the old one.
		if !boot.After(p.VerifyAfter) {
			log.Debug("vendor update verification waits for a reboot", "commandId", p.CommandID)
			continue
		}
		if err := verifyOne(ctx, deps, p, report); err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func verifyOne(ctx context.Context, deps Deps, p PendingVerification, report func(Verification) error) error {
	delay := verifyBackoffBase
	var lastErr error
	for attempt := 1; attempt <= maxVerifyAttemptsPerStart; attempt++ {
		state := deps.Protectors.State()
		if !contains(bitlockerOut, state) {
			state = BitLockerUnknown // report the check, never drop it over a reading
		}
		v := Verification{CommandID: p.CommandID, BitlockerAfter: state}
		if bios, err := deps.System.BiosVersion(); err == nil && bios != "" {
			s := sanitizeToolText(bios, maxVersionLen)
			v.BiosVersionAfter = &s
		} else if err != nil {
			log.Debug("BIOS version unreadable after reboot", "commandId", p.CommandID, "error", err.Error())
		}
		if err := v.Validate(); err != nil {
			// Only a command id Run never accepts gets here; retrying cannot fix it.
			log.Error("vendor update verification is invalid; dropped", "commandId", p.CommandID, "error", err.Error())
			if rerr := removePendingVerification(deps.Store, p.CommandID); rerr != nil {
				log.Warn("could not drop an invalid pending verification", "error", rerr.Error())
			}
			return fmt.Errorf("verification for %s is invalid, dropped: %w", p.CommandID, err)
		}
		lastErr = report(v)
		if lastErr == nil {
			if p.BiosVersionBefore != "" && v.BiosVersionAfter != nil && *v.BiosVersionAfter == p.BiosVersionBefore {
				log.Info("BIOS version unchanged after a vendor update reboot", "commandId", p.CommandID, "version", p.BiosVersionBefore)
			}
			log.Info("vendor update verified after reboot", "commandId", p.CommandID, "bitlocker", v.BitlockerAfter)
			return removePendingVerification(deps.Store, p.CommandID)
		}
		if errors.Is(lastErr, ErrVerificationRejected) {
			log.Warn("vendor update verification rejected; dropped", "commandId", p.CommandID, "error", lastErr.Error())
			_ = removePendingVerification(deps.Store, p.CommandID)
			return lastErr
		}
		if attempt == maxVerifyAttemptsPerStart {
			break
		}
		if err := resumeSleep(ctx, delay); err != nil {
			return err
		}
		if delay *= 2; delay > verifyBackoffMax {
			delay = verifyBackoffMax
		}
	}
	log.Warn("vendor update verification not delivered; kept for the next start", "commandId", p.CommandID, "error", lastErr.Error())
	return lastErr
}
