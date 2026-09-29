package backup

import (
	"context"
	"errors"
	"fmt"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// errJournalUnusable reports that the checkpoint journal could not be bound
// to a brokered run's snapshot id; the run proceeds without one.
var errJournalUnusable = errors.New("checkpoint journal could not be bound to the issued snapshot id")

// bindBrokeredJournal binds the run's checkpoint journal when the snapshot id
// is issued by the control plane (a brokered writer). It runs right after
// the journal is opened, before anything reads or writes storage:
//
//   - a fresh journal, or one already naming the issued id, is bound like any
//     other (same job and base resume, anything else starts afresh) and
//     always names the issued id;
//   - a journal naming another id, written for the same dispatched base, is
//     offered to the control plane (ResumeSnapshot). Only the control plane
//     decides whether this run may continue it: ResumeWrite continues it
//     (entries from another job are then reused only after the stored
//     objects are checked — see ContinueRun), ResumeReadOnlyCompletion lets
//     the run only report its published manifest (readOnly), and a refusal
//     starts afresh under the issued id;
//   - a journal written for another dispatched base is never offered.
//
// An error other than errJournalUnusable fails the run: the control plane
// could not be asked.
func (m *BackupManager) bindBrokeredJournal(ctx context.Context, journal *snapshotJournal, issuer providers.SnapshotIDIssuer, dispatched string) (readOnly bool, err error) {
	jobID := m.config.JobID
	issued := issuer.SnapshotID()
	if journal.resumed && journal.snapshotID != issued {
		previous := journal.Header()
		reason := "dispatched base"
		if previous.DispatchedBaseSnapshotID == dispatched {
			mode, resumeErr := issuer.ResumeSnapshot(ctx, journal.snapshotID)
			switch {
			case resumeErr == nil && mode == providers.ResumeReadOnlyCompletion:
				// Nothing will be written: the journal keeps the bindings
				// of the job that published the snapshot, so its manifest
				// is adopted — and attested only when it was this job's.
				log.Info("interrupted snapshot is already published; reporting it", "snapshotId", journal.snapshotID)
				return true, nil
			case resumeErr == nil:
				if err := journal.ContinueRun(jobID, dispatched); err != nil {
					log.Warn("failed to bind checkpoint journal to this run", "error", err.Error())
				}
				if previous.JobID != jobID {
					log.Info("continuing an interrupted snapshot of an earlier job, as the control plane allowed",
						"snapshotId", journal.snapshotID)
				}
				return false, nil
			case errors.Is(resumeErr, providers.ErrSnapshotNotResumable), errors.Is(resumeErr, providers.ErrPreviousWriterActive):
				log.Warn("the control plane did not let this run continue the interrupted snapshot; starting a new one",
					"snapshotId", journal.snapshotID, "error", resumeErr.Error())
				reason = "job"
				if previous.JobID == jobID {
					reason = "snapshot"
				}
			default:
				return false, fmt.Errorf("could not ask to continue interrupted snapshot %s: %w", journal.snapshotID, resumeErr)
			}
		}
		if err := journal.restartFreshWithID(issued); err != nil {
			return false, fmt.Errorf("%w: %v", errJournalUnusable, err)
		}
		journal.discardedOtherRun = reason
		if err := journal.BindRun(jobID, dispatched); err != nil {
			log.Warn("failed to bind checkpoint journal to this run", "error", err.Error())
		}
		return false, nil
	}

	if err := journal.BindRun(jobID, dispatched); err != nil {
		log.Warn("failed to bind checkpoint journal to this run", "error", err.Error())
	}
	if journal.snapshotID != issued {
		reason := journal.discardedOtherRun
		if err := journal.restartFreshWithID(issued); err != nil {
			return false, fmt.Errorf("%w: %v", errJournalUnusable, err)
		}
		journal.discardedOtherRun = reason
		if err := journal.BindRun(jobID, dispatched); err != nil {
			log.Warn("failed to bind checkpoint journal to this run", "error", err.Error())
		}
	}
	return false, nil
}
