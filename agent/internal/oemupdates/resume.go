package oemupdates

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"time"
)

var (
	// ErrVerificationNotFound is a 404 from the verification route: an API that
	// does not have it yet, or a command it does not know yet. Retried.
	ErrVerificationNotFound = errors.New("verification route or command not found")
	// ErrVerificationRejected is a refusal that retrying cannot fix. Not retried.
	ErrVerificationRejected = errors.New("verification rejected")
)

const (
	maxVerifyAttempts = 8
	verifyBackoffBase = 30 * time.Second
	verifyBackoffMax  = 30 * time.Minute
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

// ResumePending runs once at agent start. It closes a marker for a run the
// previous process never finished (its interrupted result reaches the server
// through the command journal), and after a reboot reports BitLocker and the
// BIOS version for a firmware install. It only reads: a volume still suspended
// is reported, never changed (Decision 8).
func ResumePending(ctx context.Context, deps Deps, report func(Verification) error) error {
	m, err := ReadMarker(deps.Store)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil
		}
		return err
	}
	if m.EndedAt == nil {
		now := deps.now()
		m.EndedAt = &now
		m.Outcome = OutcomeInterrupted
		m.VerifyPending = m.FlashStarted
		// The run ended at an unknown point after it started, most likely in
		// the reboot a flash caused, so any boot since the start counts.
		m.VerifyAfter = &m.StartedAt
		if err := WriteMarker(deps.Store, m); err != nil {
			return fmt.Errorf("close interrupted marker: %w", err)
		}
		log.Warn("a vendor update run was interrupted by an agent stop",
			"commandId", m.CommandID, "lane", m.Lane, "stage", m.Stage, "flashStarted", m.FlashStarted)
	}
	if !m.VerifyPending {
		return nil
	}
	if deps.System == nil || deps.Protectors == nil {
		return errors.New("verification needs system and protector readers")
	}
	boot, err := deps.System.BootTime()
	if err != nil {
		return fmt.Errorf("read boot time: %w", err)
	}
	// Verify only after the reboot the install needed. Before it, BitLocker
	// reads "suspended" by design and the BIOS version is still the old one.
	if !boot.After(m.verifyAfter()) {
		log.Debug("vendor update verification waits for a reboot", "commandId", m.CommandID)
		return nil
	}

	v := Verification{CommandID: m.CommandID, BitlockerAfter: deps.Protectors.State()}
	if bios, err := deps.System.BiosVersion(); err == nil && bios != "" {
		s := sanitizeToolText(bios, maxVersionLen)
		v.BiosVersionAfter = &s
	}
	if err := v.Validate(); err != nil {
		m.VerifyPending = false
		_ = WriteMarker(deps.Store, m)
		return fmt.Errorf("verification is invalid, dropped: %w", err)
	}
	if m.BiosVersionBefore != "" && v.BiosVersionAfter != nil && *v.BiosVersionAfter == m.BiosVersionBefore {
		log.Info("BIOS version unchanged after a vendor update reboot", "commandId", m.CommandID, "version", m.BiosVersionBefore)
	}

	var lastErr error
	delay := verifyBackoffBase
	for attempt := 1; attempt <= maxVerifyAttempts; attempt++ {
		lastErr = report(v)
		if lastErr == nil || errors.Is(lastErr, ErrVerificationRejected) {
			break
		}
		if attempt == maxVerifyAttempts {
			break
		}
		if err := resumeSleep(ctx, delay); err != nil {
			// The agent is stopping: keep it pending for the next start.
			return err
		}
		if delay *= 2; delay > verifyBackoffMax {
			delay = verifyBackoffMax
		}
	}
	m.VerifyPending = false
	if err := WriteMarker(deps.Store, m); err != nil {
		log.Warn("could not clear the pending vendor update verification", "error", err.Error())
	}
	if lastErr != nil {
		log.Warn("vendor update verification not delivered; giving up", "commandId", m.CommandID, "error", lastErr.Error())
		return lastErr
	}
	log.Info("vendor update verified after reboot", "commandId", m.CommandID, "bitlocker", v.BitlockerAfter)
	return nil
}
