package backup

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// uploadConcurrency is how many files the snapshot's file pass uploads at
// once (#8381). Object-store round trips, not bandwidth, bound a backup of
// many small files: one PUT at a time ran at ~3.5 files/s whatever the link.
// Eight matches restoreDownloadConcurrency and verifyDownloadConcurrency.
// The providers are the same and so is the reasoning: it stays below the AWS
// SDK's default of 10 idle connections per host, and a brokered session's
// URL batches (storagesession.PrepareUploads) and control budget already
// allow for it. It is a package variable, not an operator setting, like its
// restore and verify counterparts.
var uploadConcurrency = 8

// uploadWindowPerWorker bounds how far uploads may run ahead of the entry
// the manifest is waiting for, in files per worker. Manifest entries are
// assembled strictly in walk order, so one slow file at the head holds back
// accounting (not uploading) of everything behind it. The window keeps the
// number of finished-but-unaccounted outcomes bounded.
const uploadWindowPerWorker = 4

// uploadStagedBytesBudget bounds the walk-time bytes of files being uploaded
// at once. A provider that cannot report a digest (Azure, GCS, B2) uploads a
// staged copy of each file, and an S3 multipart upload buffers parts, so N
// large files at once would need N times the staging space or memory the
// serial loop did. A new upload starts only while the total stays under the
// budget, except that one upload may always run: a file larger than the
// budget uploads alone, exactly as before. Large files are bandwidth bound,
// so serializing them costs little.
var uploadStagedBytesBudget int64 = 256 << 20

// setUploadConcurrencyForTest overrides uploadConcurrency. Call the returned
// func (typically via defer) to restore it.
func setUploadConcurrencyForTest(n int) (restore func()) {
	old := uploadConcurrency
	uploadConcurrency = n
	return func() { uploadConcurrency = old }
}

// fileUploadTask is one file handed to an upload worker: the walk entry and
// the object key the coordinator assigned it, in walk order.
type fileUploadTask struct {
	file       backupFile
	backupPath string
}

// fileUploadOutcome is what a worker hands back for one file. At most one of
// writerStillActive, sourceGone, stopped and err is set; none set means the
// upload succeeded and stored/volatile describe it. The coordinator acts on
// it in walk order, exactly where the serial loop acted on the same result.
type fileUploadOutcome struct {
	stored   providers.UploadDigest
	volatile bool

	// writerStillActive ends the run: the snapshot cannot be written at all.
	writerStillActive error
	// sourceGone ends the run: the snapshot the file was read from is gone.
	sourceGone error
	// stopped: the job (or the coordinator, while aborting) cancelled it.
	stopped bool
	// err skips the file; reconcileFailed says it was the re-upload of a
	// file that changed while it was read, not the upload itself.
	err             error
	reconcileFailed bool

	// For the skip warning.
	uploadSize int64
	elapsed    time.Duration
}

// uploadSlotKind says how the file pass handles one walk entry.
type uploadSlotKind int

const (
	slotUpload      uploadSlotKind = iota // uploaded by a worker
	slotContentless                       // symlink/directory: nothing to upload
	slotResumed                           // journaled by an interrupted run
	slotReference                         // unchanged since the base snapshot
)

// uploadSlot is one walk entry inside the upload window, from admission
// until the coordinator accounts for it.
type uploadSlot struct {
	kind  uploadSlotKind
	entry SnapshotFile // slotResumed, slotReference

	// slotUpload only.
	backupPath string
	charged    int64 // bytes counted against uploadStagedBytesBudget
	progress   inFlightSlot
	done       bool
	outcome    fileUploadOutcome
}

type uploadDone struct {
	index   int
	outcome fileUploadOutcome
}

// fileUploader uploads one file on a worker goroutine: measure, upload, at
// most one retry, and the post-upload reconcile, each exactly as the serial
// loop did them. It touches nothing the coordinator owns: no manifest, key
// claims, counters, journal or progress totals.
type fileUploader struct {
	provider       providers.BackupProvider
	stagingDir     string
	sourceLiveness sourceLivenessFn
	snapshotID     string
}

func (u *fileUploader) upload(ctx context.Context, task fileUploadTask) fileUploadOutcome {
	file, backupPath := task.file, task.backupPath

	// Measure (stat + hash) the source immediately before handing it to
	// the upload, so the manifest entry can describe the SAME read that
	// is about to be uploaded rather than a walk-time stat plus a
	// separate post-upload hash from a third point in time (#5581). A
	// measurement failure here (source vanished/unreadable since the
	// walk) is not fatal on its own: fall through with the walk-time
	// size/modTime and let the upload attempt itself surface (and
	// classify) the failure the way it always has.
	//
	// Only uploadFile.size is adjusted (feeds uploadDeadline below) —
	// the manifest entry's ModTime stays file.modTime (the walk-time
	// value, unchanged) even when a measurement is available. The
	// journal's resume matching (journal.Lookup) keys on that walk-time
	// (sourcePath, size, modTime) triple; a live-mutating file's
	// pre-upload modTime would never match on a later resumed run
	// anyway (the file has moved on again), so there is nothing to gain
	// by substituting it here — only Size/Checksum need to describe the
	// uploaded bytes (#5581).
	pre, preErr := statBeforeUpload(file.sourcePath)
	uploadFile := file
	haveMeasurement := preErr == nil
	if haveMeasurement {
		uploadFile.size = pre.size
	}
	out := fileUploadOutcome{uploadSize: uploadFile.size}

	// Log the file we are ABOUT to upload, at debug, before we block on it.
	// This is the line that makes a wedged backup diagnosable: the deadline
	// below scales with file size (capped at uploadTimeoutCeiling), so a
	// large file whose upload stalls mid-body can hold a worker for hours
	// with no other output. Without a start line there is no way to tell
	// which file is stuck (#2790, #2798).
	deadline := uploadDeadline(uploadFile.size)
	log.Debug("uploading file",
		"path", file.sourcePath,
		"backupPath", backupPath,
		"bytes", uploadFile.size,
		"deadlineMs", deadline.Milliseconds(),
		"snapshotId", u.snapshotID,
	)

	uploadStart := time.Now()
	uploaded, uploadErr := attemptFileUploadFenced(ctx, u.provider, u.stagingDir, uploadFile, backupPath)
	if errors.Is(uploadErr, errWriterStillActive) {
		// Not this file's fault: the snapshot cannot be written at all.
		out.writerStillActive = uploadErr
		return out
	}
	if uploadErr != nil && !errors.Is(uploadErr, errBackupStopped) {
		// Before spending anything else on this failure, make sure the
		// source we are reading from still exists. If the shadow copy died,
		// this file is not bad and neither is any file after it — sleeping
		// on a retry, and then blaming the file, is exactly the behaviour
		// that turned 15 unreadable files into 40 lost ones (#3260).
		if goneErr := u.sourceLiveness(file.sourcePath); goneErr != nil {
			out.sourceGone = goneErr
			return out
		}
		policy, reason := classifyUploadFailure(uploadErr, file.sourcePath)
		if policy == skipWithoutRetry {
			// The source is locked by a live process, already gone, or an
			// unhydratable cloud placeholder. A retry cannot change that,
			// so skip immediately instead of burning uploadRetryDelay on a
			// foregone conclusion — a real 123,600-file C:\Users run spent
			// 2h38m of its 2h41m asleep here for 316 such files (#2997).
			//
			// This ONLY removes the sleep. The file is still skipped the
			// usual way: counted in UploadFailures (and so job.ErrorCount),
			// job carries on.
			log.Warn("file upload failed permanently, skipping without retry",
				"path", file.sourcePath,
				"bytes", uploadFile.size,
				"elapsedMs", time.Since(uploadStart).Milliseconds(),
				"reason", reason,
				"error", uploadErr.Error(),
			)
		} else {
			// Exactly one retry, only for a non-cancel failure (including a
			// per-file deadline expiry, which attemptFileUpload has already
			// converted to a plain error). Job-context cancel during the
			// backoff wait aborts immediately — never retried.
			//
			// retryDelayFor picks the wait: the full backoff for an
			// unrecognised (probably transient) failure, or the short one
			// for a source-permission denial, which is nearly always a
			// structural ACL (#3259).
			//
			// Warn, not debug: a single retry is the first observable symptom
			// of a stalling destination, and it is the point at which we have
			// already burned the full per-file deadline.
			retryDelay := retryDelayFor(policy)
			if reason == "" {
				// The failure was not attributable to the source file (a
				// destination outage, a provider-side error, an
				// unrecognised errno). Say so rather than logging an empty
				// field, which reads like a dropped value.
				reason = "unclassified"
			}
			log.Warn("file upload failed, retrying once",
				"path", file.sourcePath,
				"bytes", uploadFile.size,
				"elapsedMs", time.Since(uploadStart).Milliseconds(),
				"deadlineMs", deadline.Milliseconds(),
				"retryDelayMs", retryDelay.Milliseconds(),
				"reason", reason,
				"error", uploadErr.Error(),
			)
			timer := time.NewTimer(retryDelay)
			select {
			case <-ctx.Done():
				uploadErr = errBackupStopped
			case <-timer.C:
				uploaded, uploadErr = attemptFileUploadFenced(ctx, u.provider, u.stagingDir, uploadFile, backupPath)
				if errors.Is(uploadErr, errWriterStillActive) {
					out.writerStillActive = uploadErr
					return out
				}
			}
			timer.Stop()
		}
	}
	if uploadErr != nil {
		if errors.Is(uploadErr, errBackupStopped) {
			out.stopped = true
			return out
		}
		// Probed a second time on purpose: the retry above is the window in
		// which the snapshot most often dies, and #3260's own tell was a
		// file whose error flipped from ACCESS_DENIED to PATH_NOT_FOUND
		// between the first attempt and the retry. Costs one stat per
		// failing file.
		if goneErr := u.sourceLiveness(file.sourcePath); goneErr != nil {
			out.sourceGone = goneErr
			return out
		}
		out.err = uploadErr
		out.elapsed = time.Since(uploadStart)
		return out
	}
	uploadMs := time.Since(uploadStart).Milliseconds()

	// The manifest's Size/Checksum describe the bytes the upload stored
	// (the digest uploadWithDigest returned for the attempt that
	// succeeded), never a separate read of a source that may have moved
	// on. Volatile only says the source did not hold still while it was
	// read (see reconcileAfterUpload). ModTime is deliberately NOT
	// touched — the coordinator records file.modTime (the walk-time
	// value) in every case; see the comment above the pre-measurement.
	stored := uploaded
	volatile := false
	if haveMeasurement {
		reconciled, isVolatile, reconcileErr := reconcileAfterUpload(ctx, u.provider, u.stagingDir, file.sourcePath, backupPath, pre, uploaded)
		if errors.Is(reconcileErr, errBackupStopped) {
			out.stopped = true
			return out
		}
		if errors.Is(reconcileErr, errWriterStillActive) {
			// The re-upload was refused by the writer fence: like the
			// first upload's refusal, the snapshot cannot be written at
			// all, so the run ends rather than skipping file after file.
			out.writerStillActive = reconcileErr
			return out
		}
		if reconcileErr != nil {
			// The re-upload of a changing file failed: what the key now
			// holds is not known for certain, so the file is not in this
			// snapshot.
			out.err = reconcileErr
			out.reconcileFailed = true
			return out
		}
		stored = reconciled
		volatile = isVolatile
		if volatile {
			log.Warn("file was modified while being backed up, recorded as volatile",
				"path", file.sourcePath,
				"bytes", stored.Size,
				"snapshotId", u.snapshotID,
			)
		}
	}
	log.Debug("file uploaded",
		"path", file.sourcePath,
		"bytes", stored.Size,
		"uploadMs", uploadMs,
		"volatile", volatile,
		"snapshotId", u.snapshotID,
	)
	out.stored = stored
	out.volatile = volatile
	return out
}

// sharedWriterFence lets the upload workers share one wait on the brokered
// writer's fence. When an earlier writer of the snapshot is still active,
// every in-flight upload is refused at about the same moment. Each waiting
// on its own would spend a control-plane call (and a slot in the session's
// budget) on the same answer. A caller that arrives while a wait is in
// progress joins it instead. A caller that arrives after it ended starts a
// new one, since a fresh refusal means the fence is shut again.
type sharedWriterFence struct {
	fence providers.WriterFence

	mu   sync.Mutex
	wait *fenceWait
}

type fenceWait struct {
	done chan struct{}
	err  error
}

func (s *sharedWriterFence) AwaitWriteAccess(ctx context.Context) error {
	s.mu.Lock()
	if w := s.wait; w != nil {
		s.mu.Unlock()
		select {
		case <-w.done:
			return w.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	w := &fenceWait{done: make(chan struct{})}
	s.wait = w
	s.mu.Unlock()

	w.err = s.fence.AwaitWriteAccess(ctx)

	s.mu.Lock()
	s.wait = nil
	s.mu.Unlock()
	close(w.done)
	return w.err
}

type sharedWriterFenceKey struct{}

// withSharedWriterFence returns ctx carrying a sharedWriterFence over
// provider's writer fence, for attemptFileUploadFenced to use in place of
// the fence itself. ctx is returned unchanged when provider has no fence.
func withSharedWriterFence(ctx context.Context, provider providers.BackupProvider) context.Context {
	fence, ok := writerFenceOf(provider)
	if !ok {
		return ctx
	}
	return context.WithValue(ctx, sharedWriterFenceKey{}, &sharedWriterFence{fence: fence})
}

// writerFenceFor returns the fence an upload on ctx waits on: the run's
// shared fence when the upload pool attached one, else provider's own.
func writerFenceFor(ctx context.Context, provider providers.BackupProvider) (providers.WriterFence, bool) {
	if shared, ok := ctx.Value(sharedWriterFenceKey{}).(*sharedWriterFence); ok {
		return shared, true
	}
	return writerFenceOf(provider)
}
