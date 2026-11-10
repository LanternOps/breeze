package backup

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// Verification records (#11043). A resume pass re-hashes every journaled source
// file and, for a snapshot continued from another job, reads every stored object
// back before the first upload. On a large selection that outlasts the job's
// storage session, and without a record of it the next job starts over, so the
// run never reaches its uploads. These records let the next job carry on where
// the pass stopped.
//
// A record is a journal entry line written again with one more member:
//
//	{...the SnapshotFile fields..., "verification":{"storedObjectCheck":"ok","verifiedAt":"...","baseGeneration":"..."}}
//
// The size, modification time and content hash it vouches for are that line's
// own size, modTime and checksum, so they cannot disagree with the entry.
//
// Compatibility, in both directions, without a format bump (see
// journalFormatVersion):
//   - A line with no record, from any earlier helper or from an upload, means
//     never verified: the entry gets the full check, once.
//   - An older helper ignores the member and last-entry-wins hands it the entry
//     it had, so a rollback costs a full check and nothing else. Whatever it
//     appends cannot be trusted to keep records honest (it does not know to
//     retract them before overwriting an object), so readJournal drops every
//     record older than a header update that lacks VerificationAware.
//   - A torn last line drops every record too, since it may be a lost retraction
//     (see journal_tail.go). The entries stay.
//
// What a record does not prove: the source can change without moving its size or
// modification time, and a stored object can change in place while its key stays
// listed. Skipping accepts both inside the window. The source side is the trust
// decideFile already places in size and modification time when it references an
// older snapshot's object; the stored side is bounded by storedCheckMaxAge and
// confirmStoredBeforePublish.

// storedObjectCheck is the verdict of reading a journaled object back.
type storedObjectCheck string

const (
	// storedCheckNone: not read back, or the read failed. An I/O error is
	// not a verdict about the object.
	storedCheckNone     storedObjectCheck = ""
	storedCheckOK       storedObjectCheck = "ok"
	storedCheckMissing  storedObjectCheck = "missing"
	storedCheckMismatch storedObjectCheck = "mismatch"
)

const (
	// storedCheckMaxAge is how long a stored object's "ok" is trusted before
	// it is read back again. A constant until a backup policy can set it.
	//
	// journalMaxAge is also 7 days and a journal is refused past it, so today
	// this cannot expire on a journal that opened: it is a backstop, and it
	// starts to matter once a policy sets it below journalMaxAge.
	storedCheckMaxAge = 7 * 24 * time.Hour

	// racyModTimeMargin keeps a file written moments before it was hashed out
	// of the records: another write within the same timestamp tick would
	// leave size and modification time unchanged (git's "racy" problem). Long
	// enough for coarse clocks (2 s on FAT) and lazily updated timestamps.
	racyModTimeMargin = time.Minute

	// verificationSemantics is mixed into every base generation. Change it
	// when what a record proves changes, and older records stop counting.
	verificationSemantics = "1"
)

// journalVerification is what a resume pass proved about an entry. A record
// exists only after the source hashed to the entry's checksum, so it always
// stands for that, whatever StoredObjectCheck says.
type journalVerification struct {
	StoredObjectCheck storedObjectCheck `json:"storedObjectCheck,omitempty"`
	// VerifiedAt is when the record was written. Only a stored "ok" has its age
	// judged, and that write is the read that produced it: reusing a record
	// never rewrites it, so reuse cannot renew the "ok".
	VerifiedAt time.Time `json:"verifiedAt"`
	// BaseGeneration is the context the evidence holds in, see
	// journalBaseGeneration.
	BaseGeneration string `json:"baseGeneration"`
}

// journalEntryLine is a journal data line: an entry, with its record if it has
// one. Journal-only: SnapshotFile itself goes into manifests.
type journalEntryLine struct {
	SnapshotFile
	Verification *journalVerification `json:"verification,omitempty"`
}

// journalBaseGeneration identifies what a record was verified against: the
// snapshot whose prefix holds the object and the base the control plane
// dispatched. The base the run ended up using is left out on purpose: journal
// entries are objects under the snapshot's own prefix, whatever the base, and a
// transient failure to read the previous manifest must not cost a re-verify.
func journalBaseGeneration(snapshotID, dispatchedBaseSnapshotID string) string {
	return identityFingerprint(verificationSemantics + "\x00" + snapshotID + "\x00" + dispatchedBaseSnapshotID)
}

func (j *snapshotJournal) baseGeneration() string {
	return journalBaseGeneration(j.snapshotID, j.header.DispatchedBaseSnapshotID)
}

// internVerification points a record read from disk at shared strings: a
// journal can hold millions of them, all with the same generation.
func internVerification(v *journalVerification, generation *string) {
	if v.BaseGeneration == *generation {
		v.BaseGeneration = *generation
	} else {
		*generation = v.BaseGeneration
	}
	switch v.StoredObjectCheck {
	case storedCheckOK:
		v.StoredObjectCheck = storedCheckOK
	case storedCheckMissing:
		v.StoredObjectCheck = storedCheckMissing
	case storedCheckMismatch:
		v.StoredObjectCheck = storedCheckMismatch
	}
}

// recordVerification appends entry with its record, flushed like Record so a
// pass killed at any point keeps everything before it.
func (j *snapshotJournal) recordVerification(entry SnapshotFile, v journalVerification) error {
	if j == nil {
		return nil
	}
	key := journalEntryKey(entry)
	if err := j.appendEvidenceLine(key, journalEntryLine{SnapshotFile: entry, Verification: &v}); err != nil {
		return err
	}
	if j.verifications == nil {
		j.verifications = make(map[string]journalVerification)
	}
	j.verifications[key] = v
	return nil
}

// clearVerification retracts key's record. The caller is about to upload over
// the object it vouched for, which must happen only after the retraction: if
// that upload dies before Record, nothing may vouch for the object it left.
func (j *snapshotJournal) clearVerification(key string) {
	if j == nil {
		return
	}
	if _, ok := j.verifications[key]; !ok {
		return
	}
	// A plain line supersedes the record, here and in any older reader.
	if err := j.appendEvidenceLine(key, journalEntryLine{SnapshotFile: j.entries[key]}); err != nil {
		return
	}
	delete(j.verifications, key)
}

// appendEvidenceLine writes a line that changes key's record. If the line
// retracts trust the record holds and the write fails, that record stays on disk
// and may come to vouch for an object it never saw. A journal is never worth
// that, so it is poisoned (see Complete): the next run starts a new snapshot.
// Truncating works where appending failed, on a full disk for one. A write that
// keeps or adds trust is merely lost, like any other journal write: the record
// left behind is still true, and the next job checks again what it does not cover.
func (j *snapshotJournal) appendEvidenceLine(key string, line journalEntryLine) error {
	err := j.appendLine(line)
	if err == nil {
		return nil
	}
	if j.retractsTrust(key, line) {
		if poisonErr := poisonJournalFile(j.path); poisonErr != nil {
			slog.Error("could not retract a backup verification record or poison the journal",
				"path", j.path, "error", errors.Join(err, poisonErr).Error())
		} else {
			slog.Warn("could not retract a backup verification record; discarded the checkpoint journal",
				"path", j.path, "error", err.Error())
		}
	}
	return err
}

// retractsTrust reports whether line takes away something key's record lets a
// later job skip: the whole record (a plain line), or its stored "ok". Any other
// change leaves the read-back owing either way, so losing it is harmless.
func (j *snapshotJournal) retractsTrust(key string, line journalEntryLine) bool {
	old, ok := j.verifications[key]
	if !ok {
		return false
	}
	if line.Verification == nil {
		return true
	}
	return old.StoredObjectCheck == storedCheckOK && line.Verification.StoredObjectCheck != storedCheckOK
}

// resumeVerifier decides, entry by entry, whether a resumed run may reuse a
// journaled object, doing only the checks the journal's records leave owing.
type resumeVerifier struct {
	journal         *snapshotJournal
	digester        providers.StoredObjectDigester
	canVerifyStored bool
	// verifyStored: the snapshot was continued from another job, so an entry
	// is reused only if the stored object also holds the recorded bytes.
	verifyStored bool
	// tainted names BackupPaths a case twin shares, see foldCollidingKeys.
	tainted    map[string]bool
	generation string
	snapshotID string
	// reliedOnCachedStored is set once an entry was reused on a recorded "ok"
	// without reading its object back, see confirmStoredBeforePublish.
	reliedOnCachedStored bool
}

func newResumeVerifier(journal *snapshotJournal, provider providers.BackupProvider, snapshotID string) *resumeVerifier {
	digester, canVerify := storedObjectDigesterOf(provider)
	return &resumeVerifier{
		journal:         journal,
		digester:        digester,
		canVerifyStored: canVerify,
		verifyStored:    journal.VerifyStoredEntries(),
		tainted:         journal.foldCollidingKeys(),
		generation:      journal.baseGeneration(),
		snapshotID:      snapshotID,
	}
}

// standingRecord returns entry's record if it can stand in for hashing the
// source. Anything else gets the whole check: no record, one from another base
// generation, one whose stored check failed, and any Volatile entry (it kept
// changing while uploaded, so size and modification time say nothing about it).
func (v *resumeVerifier) standingRecord(key string, entry SnapshotFile) (journalVerification, bool) {
	rec, ok := v.journal.verifications[key]
	if !ok || entry.Volatile || rec.BaseGeneration != v.generation || rec.VerifiedAt.IsZero() {
		return journalVerification{}, false
	}
	if rec.StoredObjectCheck != storedCheckOK && rec.StoredObjectCheck != storedCheckNone {
		return journalVerification{}, false
	}
	return rec, true
}

// storedCheckFresh reports whether rec's "ok" can still be trusted. A timestamp
// from the future is not: the clock it came from cannot be reasoned about.
func storedCheckFresh(rec journalVerification, now time.Time) bool {
	if rec.StoredObjectCheck != storedCheckOK {
		return false
	}
	age := now.Sub(rec.VerifiedAt)
	return age >= 0 && age <= storedCheckMaxAge
}

// prepareReadBacks lets a batching provider authorize, ahead of the pass, the
// reads it will actually have to make.
func (v *resumeVerifier) prepareReadBacks(provider providers.BackupProvider, files []backupFile) {
	if !v.verifyStored || !v.canVerifyStored {
		return
	}
	now := time.Now()
	var keys []string
	for _, file := range files {
		key := journalLookupKey(file)
		entry, ok := v.journal.Lookup(key, file.size, file.modTime)
		if !ok || entry.BackupPath == "" {
			continue
		}
		if rec, standing := v.standingRecord(key, entry); standing && storedCheckFresh(rec, now) {
			continue
		}
		keys = append(keys, entry.BackupPath)
	}
	providers.PrepareDownloads(unwrapProvider(provider), keys)
}

// reusable reports whether entry, which Lookup matched to file, can be reused
// without uploading. New evidence is journaled as soon as it exists, so a pass
// that dies part way loses at most the file it was on. When the answer is no,
// the file is about to be uploaded over the object, so no record may be left
// that lets a later job skip checking that object: at most one that still owes
// the read-back.
//
// checked is false when a read the decision needed failed: the entry is not
// reused, and the check did not complete. An entry a record let through without
// a read did complete: an earlier pass did that work (#11014).
func (v *resumeVerifier) reusable(ctx context.Context, file backupFile, entry SnapshotFile) (reuse, checked bool) {
	key := journalLookupKey(file)
	rec, standing := v.standingRecord(key, entry)
	started := time.Now()

	// Size and modification time can match a file whose content changed.
	// Without a standing record, reuse the entry only when the source still
	// hashes to the recorded digest (the digest of the uploaded source bytes,
	// the same quantity sha256File computes). This costs one full read of the
	// file, still far cheaper than uploading it again; a mismatch or read
	// error uploads the file afresh and the recorded digest is never replaced
	// by anything but a new upload's.
	match := entry.Checksum != ""
	if match && !standing {
		var err error
		match, err = checksumMatches(file.sourcePath, entry.Checksum)
		if err != nil {
			log.Warn("could not read journaled file to check it; uploading it again",
				"path", file.sourcePath,
				"snapshotId", v.snapshotID,
				"error", err.Error(),
			)
			v.journal.clearVerification(key)
			return false, false
		}
	}
	if !match {
		log.Info("journaled file changed since it was uploaded; uploading it again",
			"path", file.sourcePath,
			"snapshotId", v.snapshotID,
		)
		v.journal.clearVerification(key)
		return false, true
	}
	if v.tainted[entry.BackupPath] {
		// A pre-#5582 journal stored this file and a case twin at keys one
		// object answers to; re-upload rather than resume a
		// possibly-overwritten object.
		log.Warn("not resuming journaled file whose object key collides with a case twin; re-uploading",
			"path", file.sourcePath,
			"backupPath", entry.BackupPath,
			"snapshotId", v.snapshotID,
		)
		v.journal.clearVerification(key)
		return false, true
	}
	if !v.verifyStored {
		if !standing {
			v.recordEvidence(file, entry, storedCheckNone, started)
		}
		return true, true
	}
	if !v.canVerifyStored || isReferenceEntry(entry, v.snapshotID) {
		// Only a literal entry, through a provider that can read it back, can
		// be shown to hold the recorded bytes.
		log.Info("journaled object from an earlier job cannot be checked; uploading it again",
			"path", file.sourcePath,
			"backupPath", entry.BackupPath,
			"snapshotId", v.snapshotID,
		)
		v.journal.clearVerification(key)
		return false, true
	}
	if standing && storedCheckFresh(rec, time.Now()) {
		v.reliedOnCachedStored = true
		return true, true
	}
	check, err := readBackStoredObject(ctx, v.digester, entry)
	if err != nil {
		// A stop cancels the read mid-flight; that says nothing about the
		// object and is not worth a warning.
		if ctx.Err() == nil {
			log.Warn("could not read back a journaled object from an earlier job; uploading it again",
				"path", file.sourcePath,
				"backupPath", entry.BackupPath,
				"snapshotId", v.snapshotID,
				"error", err.Error(),
			)
		}
		v.recordEvidence(file, entry, storedCheckNone, started)
		return false, false
	}
	v.recordEvidence(file, entry, check, started)
	if check != storedCheckOK {
		log.Info("journaled object from an earlier job does not match its record; uploading it again",
			"path", file.sourcePath,
			"backupPath", entry.BackupPath,
			"snapshotId", v.snapshotID,
			"storedObjectCheck", string(check),
		)
		return false, true
	}
	return true, true
}

// recordEvidence journals what the pass just established about entry, unless
// the entry cannot hold a record (see racyModTimeMargin and standingRecord): any
// record it has is retracted then, since the caller may upload next. checksStarted
// is when the checks began, which is what the margin is about: a long hash must
// not carry a file past it. The journal's own writes are best effort, as
// everywhere: a lost record costs a re-verify next time.
func (v *resumeVerifier) recordEvidence(file backupFile, entry SnapshotFile, check storedObjectCheck, checksStarted time.Time) {
	if entry.Volatile || checksStarted.Sub(file.modTime) < racyModTimeMargin {
		v.journal.clearVerification(journalEntryKey(entry))
		return
	}
	_ = v.journal.recordVerification(entry, journalVerification{
		StoredObjectCheck: check,
		VerifiedAt:        time.Now().UTC(),
		BaseGeneration:    v.generation,
	})
}

// readBackStoredObject reads entry's object back and compares it with the
// record. Only an answer about the object is a verdict; an error is not.
func readBackStoredObject(ctx context.Context, digester providers.StoredObjectDigester, entry SnapshotFile) (storedObjectCheck, error) {
	stored, err := digester.StoredObjectDigest(ctx, entry.BackupPath)
	if errors.Is(err, providers.ErrObjectNotFound) {
		return storedCheckMissing, nil
	}
	if err != nil {
		return storedCheckNone, err
	}
	if stored.SHA256 != entry.Checksum || stored.Size != entry.Size {
		return storedCheckMismatch, nil
	}
	return storedCheckOK, nil
}

// confirmStoredBeforePublish is the manifest-level check for a run that reused
// objects without reading them back: every object under the snapshot's own
// prefix that the manifest names must still be listed. It proves existence, not
// content (a listing has keys only); content stands on the recorded read-back,
// inside storedCheckMaxAge.
//
// It fails closed. A listing error says nothing about the objects, so nothing is
// recorded and the next job checks again. A missing object is recorded as such,
// so the next job, which reuses everything else in moments, re-uploads it. Either
// way publishing a manifest could name an object that is not there, and retrying
// costs little now that the pass is not repeated.
//
// A run that read every object back or uploaded it does not list: the check
// guards what skipping the read-back gives up, and any other run keeps exactly
// the behaviour it had.
func (v *resumeVerifier) confirmStoredBeforePublish(provider providers.BackupProvider, snapshot *Snapshot) error {
	if v == nil || !v.reliedOnCachedStored {
		return nil
	}
	items, err := listSnapshotPrefixItems(provider, snapshot.ID)
	if err != nil {
		return fmt.Errorf("could not confirm the objects of snapshot %s are stored, nothing was published: %w", snapshot.ID, err)
	}
	listed := make(map[string]struct{}, len(items))
	for _, item := range items {
		listed[item] = struct{}{}
	}
	var missing []SnapshotFile
	for _, f := range snapshot.Files {
		if !f.HasContent() || isReferenceEntry(f, snapshot.ID) {
			continue
		}
		if _, ok := listed[f.BackupPath]; !ok {
			missing = append(missing, f)
		}
	}
	if len(missing) == 0 {
		return nil
	}
	now := time.Now().UTC()
	for _, f := range missing {
		key := journalEntryKey(f)
		entry, ok := v.journal.entries[key]
		if !ok {
			continue
		}
		_ = v.journal.recordVerification(entry, journalVerification{
			StoredObjectCheck: storedCheckMissing,
			VerifiedAt:        now,
			BaseGeneration:    v.generation,
		})
	}
	return fmt.Errorf("%d objects of snapshot %s are missing from storage (first: %s), nothing was published; the next run uploads them again",
		len(missing), snapshot.ID, missing[0].BackupPath)
}
