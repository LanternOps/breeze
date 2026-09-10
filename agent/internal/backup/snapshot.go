package backup

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// sha256File streams a file through SHA-256 and returns the lowercase-hex
// digest. Streaming keeps memory flat for large files.
func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// checksumMatches reports whether the file at path hashes to want. A hashing
// error counts as a mismatch (fail-closed) so verification never passes a file
// it could not read.
func checksumMatches(path, want string) bool {
	got, err := sha256File(path)
	return err == nil && got == want
}

const (
	snapshotRootDir     = "snapshots"
	snapshotFilesDir    = "files"
	snapshotManifestKey = "manifest.json"
	// layoutManifestKey is mirrored by apps/api's backupSnapshotStorage.ts
	// BACKUP_LAYOUT_MANIFEST_KEY — they must stay byte-identical.
	layoutManifestKey = "layout.json"

	// publishMargin is subtracted from the lease deadline at publish time
	// (D18 §3.1): the server keeps a job's base pinned for
	// lease+publishMargin precisely so a manifest PUT that STARTS inside
	// the margin has room to finish before the server's pin lapses. Must
	// match the API's BACKUP_PUBLISH_MARGIN_MS default —
	// backupAgentContract.test.ts asserts the two stay equal.
	publishMargin = 1 * time.Hour

	// systemStateDir is the remote sub-prefix, under a snapshot, where system
	// state artifacts and their own manifest live — a dedicated tree, never
	// the ordinary files/ tree. This is Option A of the D15 bare-metal-
	// recovery contract (docs/superpowers/plans/backup/
	// 2026-09-09-bmr-system-state-contract.md): the consumer (agent/internal/
	// backup/bmr/bmr.go's systemStatePath) already expects exactly this
	// layout, so the value here MUST match that constant.
	systemStateDir = "system-state"
	// systemStateManifestKey mirrors snapshotManifestKey, scoped to
	// systemStateDir. Also caught by isManifestPath (basename match), so
	// leaseGate (D18 §3.1) fences a system-state manifest publish exactly
	// like the ordinary snapshot manifest — see leaseGate's doc comment.
	systemStateManifestKey = "manifest.json"
	// systemStateManifestSchemaVersion mirrors systemstate.manifestSchemaVersion
	// (that package's own unexported constant) — see publishSystemState's
	// doc comment for why the backup package also stamps it.
	systemStateManifestSchemaVersion = 1
)

// uploadLeaseInterval is how often createSnapshotWithProgress refreshes
// snapshots/<id>/upload.lease while uploading (D18 §3.4), so a
// long-running single-object upload keeps the prefix's newest object
// fresh. MUST stay well under the API's manifest-less-prefix GC window
// (journalMaxAge + 48h grace = 9 days) — backupAgentContract.test.ts
// asserts this. A package-level var (not const) so tests can shrink it.
var uploadLeaseInterval = 15 * time.Minute

// leaseGate wraps a BackupProvider so publishing a snapshot manifest past
// its server-granted publish lease (or, for a resumed run, past the
// checkpoint journal's max age) fails closed instead of publishing a
// manifest the server can no longer trust (D18 §3.1/§3.4). Only
// isManifestPath uploads are gated — ordinary file uploads and the
// upload.lease heartbeat object pass straight through to the wrapped
// provider.
type leaseGate struct {
	providers.BackupProvider
	// publishLeaseExpiresAt is BackupConfig.PublishLeaseExpiresAt verbatim.
	// Zero value disables the lease check (legacy server, no field sent).
	publishLeaseExpiresAt time.Time
	// journal is this run's checkpoint journal, or nil. Only a RESUMED
	// journal (journal.resumed) is checked against journalMaxAge — a fresh
	// journal's age is irrelevant here.
	journal *snapshotJournal
}

func (g *leaseGate) checkPublish(remotePath string) error {
	if !isManifestPath(remotePath) {
		return nil
	}
	if g.publishLeaseExpiresAt.IsZero() {
		// P1 fix: a zero lease reaching here means the "server-owned mode
		// implies a non-zero lease" invariant (enforced at payload
		// validation, exec_backup.go) was violated somewhere upstream.
		// Fail CLOSED — refusing to publish is always safe; treating an
		// absent lease as "no lease configured, proceed" is exactly the
		// fail-open bug this gate exists to prevent, and this gate is only
		// ever installed when server-owned mode is on (see backup.go's
		// call site), so there is no legitimate zero-lease case here.
		return ErrPublishLeaseExpired
	}
	if time.Now().Add(publishMargin).After(g.publishLeaseExpiresAt) {
		return ErrPublishLeaseExpired
	}
	if g.journal != nil && g.journal.resumed && g.journal.Age() >= journalMaxAge {
		return ErrJournalExpiredAtPublish
	}
	return nil
}

// Upload implements providers.BackupProvider.
func (g *leaseGate) Upload(localPath, remotePath string) error {
	if err := g.checkPublish(remotePath); err != nil {
		return err
	}
	return g.BackupProvider.Upload(localPath, remotePath)
}

// UploadContext implements contextUploader. Declared unconditionally (even
// when the wrapped provider doesn't support it) so uploadSnapshotFile's
// type assertion on the WRAPPER always succeeds and the lease check always
// runs; it falls back to a plain Upload when the wrapped provider lacks
// context support, exactly like uploadSnapshotFile itself does.
func (g *leaseGate) UploadContext(ctx context.Context, localPath, remotePath string) error {
	if err := g.checkPublish(remotePath); err != nil {
		return err
	}
	if u, ok := g.BackupProvider.(contextUploader); ok {
		return u.UploadContext(ctx, localPath, remotePath)
	}
	return g.BackupProvider.Upload(localPath, remotePath)
}

// Snapshot represents a point-in-time backup.
type Snapshot struct {
	ID        string         `json:"id"`
	Timestamp time.Time      `json:"timestamp"`
	Files     []SnapshotFile `json:"files"`
	Size      int64          `json:"size"`
	// FormatVersion marks manifest v2 (reference entries + BaseSnapshotID).
	// Omitted (zero value) on a full backup that never consulted a previous
	// manifest, matching a v1 manifest byte-for-byte for that case. A v1
	// reader is never required (backups have no production users yet — see
	// the design doc) but a v1 manifest still parses fine regardless, since
	// both new fields are omitempty/zero-value-safe.
	FormatVersion int `json:"formatVersion,omitempty"`
	// BaseSnapshotID is the previous snapshot this manifest was compared
	// against, for provenance/debugging. Set only when previousManifest
	// actually found and returned a usable previous snapshot — never a
	// blind "most recent snapshot ID", since a fetch/parse failure means no
	// comparison happened at all (fail-open full run).
	BaseSnapshotID string `json:"baseSnapshotId,omitempty"`
	// BackupIdentity stamps which device + destination + run-kind produced
	// this snapshot (see BackupManager.runBackupIdentity). A bucket can hold
	// snapshots from multiple devices with no key prefix between them, so
	// "the newest snapshot in the bucket" is not the same question as "the
	// newest snapshot for THIS device" — previousManifest uses this field to
	// tell the two apart when picking an incremental-dedupe base (D6):
	// referencing another device's — or another run-kind's — object bytes as
	// though they were this device's own previous backup is a correctness
	// bug, not just a missed optimization. Omitted (empty) when this run has
	// no known identity (e.g. BackupConfig.AgentID unset) or predates this
	// field; previousManifest treats an empty BackupIdentity as matching
	// NOTHING, including another empty one, rather than guessing.
	BackupIdentity string `json:"backupIdentity,omitempty"`
	// UploadFailures records this run's per-file upload failures (skipped,
	// stalled, or retry-exhausted files) when the snapshot still partially
	// succeeded. In-memory only — `json:"-"` keeps it out of both the uploaded
	// manifest and the wire command result. RunBackupContext folds it into the
	// job's Warning/ErrorCount so a partial snapshot never presents server-side
	// as a green job with zero errors (an incomplete restore point that looks
	// complete).
	UploadFailures []error `json:"-"`
}

// SnapshotFile captures metadata for a backed up file.
//
// Checksum + Mode were added so integrity/test-restore can detect silent
// corruption and so restore can reapply Unix permissions. Both are
// `omitempty`: manifests written before this change carry neither, and the
// verify/restore paths treat an absent value as "not available" and fall back
// gracefully (size-only check on verify, default mode on restore).
type SnapshotFile struct {
	SourcePath string    `json:"sourcePath"`
	BackupPath string    `json:"backupPath"`
	Size       int64     `json:"size"`
	ModTime    time.Time `json:"modTime"`
	// Checksum is the lowercase-hex SHA-256 of the ORIGINAL (uncompressed)
	// source bytes. Verify/restore compare it against the bytes returned by
	// provider.Download(), which yields the original source bytes for every
	// provider: the cloud providers (S3/B2/Azure/GCS) store the object verbatim,
	// and LocalProvider stores it gzip-compressed (the .gz suffix) but
	// decompresses on download. Do NOT assume the *stored* object equals the
	// source bytes — that holds only for the cloud providers, not LocalProvider.
	Checksum string `json:"checksum,omitempty"`
	// Mode is the file's Unix permission bits (os.FileMode.Perm(), low 9 bits
	// only — setuid/setgid/sticky are intentionally NOT captured or restored),
	// reapplied on restore. 0 means "unknown" (an older manifest) → restore
	// leaves the OS default. Caveat: a file legitimately at mode 0000 also
	// stores as 0 and is therefore treated as "unknown" (left at the OS default
	// rather than restored to 0000) — an accepted limitation.
	Mode uint32 `json:"mode,omitempty"`
	// OriginalPath is SourcePath reconstructed back through a VSS
	// shadow-copy rewrite — see backupFile.originalPath. Empty (and thus
	// omitted, keeping non-VSS manifests byte-identical to before this
	// field existed) except on Windows runs where VSS was active and this
	// file's root was actually rewritten. journalEntryKey uses this instead
	// of SourcePath when present, since SourcePath is a fresh per-run
	// shadow-copy device path under VSS and would never match across runs.
	OriginalPath string `json:"originalPath,omitempty"`
}

// journalEntryKey returns the checkpoint-journal resume key for f:
// OriginalPath when set (VSS rewrote SourcePath to a per-run-ephemeral
// shadow-copy device path), else SourcePath itself (the common, non-VSS
// case, where SourcePath is already stable across runs).
func journalEntryKey(f SnapshotFile) string {
	if f.OriginalPath != "" {
		return f.OriginalPath
	}
	return f.SourcePath
}

// journalLookupKey is journalEntryKey's backupFile-side counterpart, used
// before a file has been uploaded (and thus before a SnapshotFile exists
// for it) to look up whether a prior run's journal already has it.
func journalLookupKey(f backupFile) string {
	if f.originalPath != "" {
		return f.originalPath
	}
	return f.sourcePath
}

type contextUploader interface {
	UploadContext(ctx context.Context, localPath, remotePath string) error
}

// ProgressFn reports snapshot upload progress: files/bytes completed so far
// out of the known totals. Called from the snapshot upload loop, throttled
// (see progressThrottle) except for a final unconditional call after the
// last file.
//
// snapshotID is the ID of the snapshot currently being written, or "" for
// emissions that happen before a snapshot exists (the pre-scan whole-run
// keepalive and the "scanning done" totals notice, both in backup.go). It is
// carried on every progress emission so the SERVER learns the snapshot ID
// while the run is still in flight, instead of only from the terminal result
// (#3006): a dropped terminal result then still leaves backup_jobs.snapshot_id
// pointing at the objects that were actually uploaded, so the snapshot can be
// adopted into a restore point rather than orphaned in the bucket forever.
type ProgressFn func(filesDone, filesTotal int, bytesDone, bytesTotal int64, snapshotID string)

// progressThrottle is the minimum interval between ProgressFn invocations
// from the snapshot loop (the final call after the loop always fires
// regardless of this interval).
var progressThrottle = 3 * time.Second

// setProgressThrottleForTest overrides progressThrottle so tests can observe
// a callback on every file instead of waiting out the real interval. Call
// the returned restore func (typically via defer) to put the real value
// back.
func setProgressThrottleForTest(d time.Duration) (restore func()) {
	old := progressThrottle
	progressThrottle = d
	return func() { progressThrottle = old }
}

// progressKeepaliveInterval is how often the keepalive goroutine in
// createSnapshotWithProgress re-emits the CURRENT progress counters while a
// run with a non-nil callback is in flight. The upload loop only emits after
// each COMPLETED file, so a single file whose upload (or 30s retry backoff)
// takes longer than the server's stale-progress reaper window would look
// dead server-side and get killed mid-upload — then resume from byte 0 next
// run and get killed again, never completing. The keepalive keeps
// last_progress_at fresh with unchanged counters instead.
var progressKeepaliveInterval = 30 * time.Second

// setProgressKeepaliveIntervalForTest overrides progressKeepaliveInterval so
// tests can observe a keepalive emission without waiting out the real 30s.
// Call the returned restore func (typically via defer) to put the real value
// back.
func setProgressKeepaliveIntervalForTest(d time.Duration) (restore func()) {
	old := progressKeepaliveInterval
	progressKeepaliveInterval = d
	return func() { progressKeepaliveInterval = old }
}

// uploadMinThroughputBps is the deadline floor: assume >=64 KiB/s or declare
// the link stalled.
const uploadMinThroughputBps = 64 * 1024

var uploadTimeoutFloor = 5 * time.Minute

// setUploadTimeoutFloorForTest overrides uploadTimeoutFloor so tests can
// exercise the per-file deadline path without waiting 5 minutes. Call the
// returned restore func (typically via defer) to put the real floor back.
func setUploadTimeoutFloorForTest(d time.Duration) (restore func()) {
	old := uploadTimeoutFloor
	uploadTimeoutFloor = d
	return func() { uploadTimeoutFloor = old }
}

// uploadDeadline returns the per-file upload deadline for a file of the given
// size, scaled to size at uploadMinThroughputBps with a floor of
// uploadTimeoutFloor. A stalled per-file upload is treated as a per-file
// failure (skip and continue), not a job abort — see CreateSnapshotContext.
func uploadDeadline(size int64) time.Duration {
	d := time.Duration(size/uploadMinThroughputBps) * time.Second
	if d < uploadTimeoutFloor {
		return uploadTimeoutFloor
	}
	return d
}

// uploadRetryDelay is the backoff wait before the single per-file upload
// retry (see the retry loop in createSnapshotWithProgress). It is
// interruptible by job-context cancellation.
var uploadRetryDelay = 30 * time.Second

// setUploadRetryDelayForTest overrides uploadRetryDelay so tests can exercise
// the per-file retry path without waiting out the real backoff. Call the
// returned restore func (typically via defer) to put the real delay back.
func setUploadRetryDelayForTest(d time.Duration) (restore func()) {
	old := uploadRetryDelay
	uploadRetryDelay = d
	return func() { uploadRetryDelay = old }
}

// shortUploadRetryDelay is the backoff for a source-permission denial
// (retryAfterShortDelay — see classifyUploadFailure). An NTFS ACL never clears,
// so the wait exists purely to ride out an AV/indexer/filter-driver hold.
//
// One second is an operational tradeoff, not a guarantee: Windows promises
// nothing about how quickly such a hold clears, so this does narrow the
// recovery window compared with the 30s backoff. It is still the right call —
// the retry itself (the thing that actually recovers a transient hold) is
// preserved, and the 27-29s per denied file it removes is what let a run
// outlive its own shadow copy and lose EVERY file (#3259 -> #3260).
var shortUploadRetryDelay = 1 * time.Second

// setShortUploadRetryDelayForTest overrides shortUploadRetryDelay. Call the
// returned restore func (typically via defer) to put the real delay back.
func setShortUploadRetryDelayForTest(d time.Duration) (restore func()) {
	old := shortUploadRetryDelay
	shortUploadRetryDelay = d
	return func() { shortUploadRetryDelay = old }
}

// retryDelayFor maps a retry policy to the wall-clock the upload loop spends
// before its single retry.
func retryDelayFor(policy uploadRetryPolicy) time.Duration {
	if policy == retryAfterShortDelay {
		return shortUploadRetryDelay
	}
	return uploadRetryDelay
}

// CreateSnapshot creates a new snapshot and uploads files via the provider.
func CreateSnapshot(provider providers.BackupProvider, files []backupFile) (*Snapshot, error) {
	return CreateSnapshotContext(context.Background(), provider, files)
}

// CreateSnapshotContext creates a new snapshot using the provided context.
// It does not report progress, does not checkpoint to a journal (no
// manager/destination-identity context to key one by), and does not
// dedupe against a previous manifest (always a full backup); see
// createSnapshotWithProgress for all three.
func CreateSnapshotContext(ctx context.Context, provider providers.BackupProvider, files []backupFile) (*Snapshot, error) {
	return createSnapshotWithProgress(ctx, provider, files, nil, nil, nil, nil)
}

// createSnapshotOption customizes a single createSnapshotWithProgress call.
// Functional options rather than more positional parameters: each option is
// needed by only a handful of call sites, out of dozens across this
// package's tests, and a positional parameter would force every other call
// site to pass an explicit zero value.
type createSnapshotOption func(*createSnapshotOptions)

type createSnapshotOptions struct {
	runIdentity           string
	systemStateStagingDir string
	systemStateManifest   *systemstate.SystemStateManifest
	layoutManifest        *layout.Manifest
}

// withRunIdentity stamps identity onto the new snapshot's BackupIdentity —
// see createSnapshotWithProgress's doc comment.
func withRunIdentity(identity string) createSnapshotOption {
	return func(o *createSnapshotOptions) { o.runIdentity = identity }
}

// withSystemState arranges for the system state already collected into
// stagingDir (described by manifest) to be published under the SAME
// snapshot ID as the ordinary files this createSnapshotWithProgress call is
// snapshotting — and published BEFORE that call's own ordinary
// manifest.json. Ordering matters: the ordinary manifest.json is the
// "commit point" a concurrent GC sweep uses to decide a snapshot-id group is
// "manifest-bearing" (markLiveBackupObjects, apps/api/src/jobs/
// backupRetention.ts) and therefore eligible for the per-object grace period
// rather than the manifestless-prefix rule. Publishing it FIRST — the
// previous behavior, when backup.go called publishSystemState only after
// createSnapshotWithProgress had already returned (and therefore already
// published the ordinary manifest internally) — leaves a window where a GC
// sweep sees a manifest-bearing group whose system-state/* objects are not
// marked live yet, and can reap them.
//
// A no-op when manifest is nil or carries zero artifacts (nothing to
// publish), matching the existing gate used elsewhere in this package.
func withSystemState(stagingDir string, manifest *systemstate.SystemStateManifest) createSnapshotOption {
	return func(o *createSnapshotOptions) {
		o.systemStateStagingDir = stagingDir
		o.systemStateManifest = manifest
	}
}

// withLayout publishes the disk-layout manifest as snapshots/<id>/layout.json
// after system state and BEFORE the ordinary manifest (same GC-ordering
// argument as withSystemState). No-op when manifest is nil.
func withLayout(manifest *layout.Manifest) createSnapshotOption {
	return func(o *createSnapshotOptions) { o.layoutManifest = manifest }
}

// createSnapshotWithProgress creates a new snapshot using the provided
// context, invoking onProgress (if non-nil) as files upload. Calls are
// throttled to at most once per progressThrottle interval, except for a
// final unconditional call after the last file so the server always learns
// the true end state even if the throttle window swallowed the last delta.
//
// journal, if non-nil, is this run's checkpoint (see journal.go):
//   - Its snapshotID (fresh or resumed) becomes this snapshot's ID.
//   - Each walked file matching a journal entry on (sourcePath, size,
//     modTime) is treated as already uploaded — skipped, but still carried
//     into this run's manifest — with filesDone/bytesDone pre-seeded from
//     the matched set before the loop starts, so the very first progress
//     emission reflects the resume instead of a slow trickle of
//     skip-iterations.
//   - Every freshly uploaded file is appended to the journal as it lands.
//   - On a full success (manifest uploaded), the journal is completed
//     (closed + removed) — the checkpoint is no longer needed. On every
//     other exit — stopped, per-file exhaustion, manifest failure — the
//     journal is merely abandoned (closed, left on disk): the partial
//     remote prefix plus the journal together ARE the resume state for the
//     next run, so cleanupSnapshotPrefix is skipped for all of them.
//
// prevSnapshot, if non-nil, is the previous run's completed snapshot (see
// previousManifest) to dedupe against: every walked file is classified by
// decideFile against an index built from prevSnapshot.Files (see
// buildPreviousIndex). A decideReference file skips upload AND journal
// Record entirely — it still counts toward filesDone/bytesDone through the
// same locked markDone path used everywhere else (keepalive/progress just
// work, same instant-jump semantics as a journal resume). nil means "no
// usable previous manifest" — every file uploads, identical to this
// function's behavior before incremental backups existed.
//
// Priority when a file matches BOTH the journal's resumedFiles set and the
// reference index: the journal wins. The journal represents an object THIS
// run itself already uploaded (during an earlier, interrupted attempt at
// the very same snapshot ID) and is authoritative for it; the reference
// index only offers to point at an OLDER snapshot's object. Checking
// resumedFiles first in the loop below implements that priority.
//
// sourceLiveness, if non-nil, reports whether the point-in-time source the
// files were read from still exists (the VSS shadow copy — see
// newShadowRootLiveness). It is consulted only after a per-file upload has
// already failed, and a positive answer aborts the whole run rather than
// letting every remaining file be recorded as individually bad (#3260). nil
// means the run reads the live filesystem and has nothing to defend.
//
// opts, if provided (variadic functional options so the ~25 existing call
// sites that don't care about either option need no change — same pattern
// as main.go's `tickets ...*backupExecutionTicket`), customize the call:
// withRunIdentity stamps the new snapshot's BackupIdentity (see that field's
// doc comment and runBackupIdentity) so a LATER run can find this one via
// previousManifest without picking up another device's or run-kind's
// snapshot instead (D6); withSystemState publishes already-collected system
// state under this call's snapshot ID BEFORE the ordinary manifest.json (see
// withSystemState's doc comment for why the order matters).
func createSnapshotWithProgress(ctx context.Context, provider providers.BackupProvider, files []backupFile, onProgress ProgressFn, journal *snapshotJournal, prevSnapshot *Snapshot, sourceLiveness sourceLivenessFn, opts ...createSnapshotOption) (*Snapshot, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if sourceLiveness == nil {
		sourceLiveness = func(string) error { return nil }
	}
	var options createSnapshotOptions
	for _, opt := range opts {
		opt(&options)
	}
	identity := options.runIdentity

	// Register the journal's fd cleanup before any other return path so
	// every exit — including the validation errors just below — closes it.
	// completed flips true only after a successful journal.Complete(); every
	// other path falls through to Abandon (close, keep the file).
	completed := false
	if journal != nil {
		defer func() {
			if !completed {
				journal.Abandon()
			}
		}()
	}

	if provider == nil {
		return nil, errors.New("backup provider is required")
	}
	if len(files) == 0 {
		return nil, errors.New("no files provided for snapshot")
	}

	snapshotID := newSnapshotID()
	if journal != nil {
		snapshotID = journal.snapshotID
	}
	snapshot := &Snapshot{
		ID:             snapshotID,
		Timestamp:      time.Now().UTC(),
		BackupIdentity: identity,
	}
	if prevSnapshot != nil {
		snapshot.FormatVersion = 2
		snapshot.BaseSnapshotID = prevSnapshot.ID
	}
	prevIndex := buildPreviousIndex(prevSnapshot)

	prefix := path.Join(snapshotRootDir, snapshot.ID)

	// Resume-with-already-published-manifest (D18 §3.5): a prior attempt
	// may have published manifest.json and then crashed before
	// journal.Complete() removed the journal. Re-uploading now would
	// overwrite a COMPLETED, restorable manifest — treat its confirmed
	// presence as "this run already finished" and return it as-is,
	// uploading nothing. This is a SECOND check: RunBackupContext
	// (backup.go) performs the same one earlier, before source scanning,
	// so a source-gone resumed run reports success instead of hitting the
	// len(files)==0 reject above first — see this task's ordering note.
	// Kept here too so direct callers of this function (this package's own
	// unit tests) still exercise and prove the behavior without going
	// through RunBackupContext.
	if journal != nil && journal.resumed {
		existing, fetchErr := fetchPublishedManifest(ctx, provider, prefix)
		if fetchErr != nil {
			return nil, fmt.Errorf("resume check failed, refusing to guess whether %s was already published: %w", prefix, fetchErr)
		}
		if existing != nil {
			log.Info("resume: manifest already published, skipping upload",
				"snapshotId", existing.ID,
				"files", len(existing.Files),
			)
			if err := journal.Complete(); err != nil {
				log.Warn("failed to remove completed checkpoint journal", "error", err.Error())
			}
			completed = true
			return existing, nil
		}
		// existing == nil, fetchErr == nil: confirmed absent — fall through
		// to a normal upload below.
	}

	var errs []error

	var bytesTotal int64
	for _, file := range files {
		bytesTotal += file.size
	}
	filesTotal := len(files)

	// filesDone/bytesDone/lastProgressAt are shared between the upload loop
	// (which mutates the counters) and the keepalive goroutine below (which
	// re-emits them) — every access goes through progressMu. onProgress itself
	// is invoked WITH the mutex held, so emissions are strictly serialized and
	// the reported counters can never appear to go backwards.
	var progressMu sync.Mutex
	var filesDone int
	var bytesDone int64
	lastProgressAt := time.Now()
	emitProgress := func(force bool) {
		if onProgress == nil {
			return
		}
		progressMu.Lock()
		defer progressMu.Unlock()
		if !force && time.Since(lastProgressAt) < progressThrottle {
			return
		}
		lastProgressAt = time.Now()
		onProgress(filesDone, filesTotal, bytesDone, bytesTotal, snapshot.ID)
	}
	markDone := func(fileCount int, byteCount int64) {
		progressMu.Lock()
		filesDone += fileCount
		bytesDone += byteCount
		progressMu.Unlock()
	}

	// Keepalive: while a single large upload (or the per-file retry backoff)
	// is in flight, the loop emits nothing — but the server-side stale reaper
	// treats a silent running job as dead and cancels it. Re-emit the current
	// counters every progressKeepaliveInterval so a long in-flight upload
	// keeps the job's last_progress_at fresh. The goroutine is joined on
	// every return path (defer) so no emission can fire after this function
	// returns.
	if onProgress != nil {
		keepaliveTicker := time.NewTicker(progressKeepaliveInterval)
		keepaliveStop := make(chan struct{})
		keepaliveDone := make(chan struct{})
		go func() {
			defer close(keepaliveDone)
			for {
				select {
				case <-keepaliveStop:
					return
				case <-keepaliveTicker.C:
					emitProgress(false)
				}
			}
		}()
		defer func() {
			keepaliveTicker.Stop()
			close(keepaliveStop)
			<-keepaliveDone
		}()
	}

	// upload.lease heartbeat (D18 §3.4): refresh a tiny marker object every
	// uploadLeaseInterval while uploading, so GC's manifest-less-prefix
	// window keeps extending for a legitimately slow multi-day single-file
	// upload. leaseCtx (derived from ctx) is cancelled by stopLeaseRefresh —
	// called exactly once via leaseStopOnce, on completion or ctx
	// cancellation — cancelling leaseCtx immediately signals any in-flight
	// refresh to stop and unblocks the NEXT select iteration without
	// waiting out the full 60s bound; a refresh already inside a plain
	// Upload (a provider with no UploadContext, e.g. leaseGate's fallback,
	// mirroring uploadSnapshotFile's own pre-existing trade-off) still runs
	// to completion since a plain Upload has no cancellation hook. Skipped
	// entirely by the resume-already-published shortcut above, since that
	// path returns before this point.
	leaseKey := path.Join(prefix, "upload.lease")
	leaseCtx, leaseCancel := context.WithCancel(ctx)
	leaseDone := make(chan struct{})
	var leaseStopOnce sync.Once
	stopLeaseRefresh := func() {
		leaseStopOnce.Do(func() {
			leaseCancel()
			<-leaseDone
		})
	}
	go func() {
		defer close(leaseDone)
		ticker := time.NewTicker(uploadLeaseInterval)
		defer ticker.Stop()
		for {
			select {
			case <-leaseCtx.Done():
				return
			case <-ticker.C:
				// Each refresh is bounded to 60s AND tied to leaseCtx, so
				// stopLeaseRefresh's leaseCancel() unblocks it immediately
				// instead of this goroutine sitting in a stalled PUT for up
				// to 60s after the caller asked it to stop.
				refreshCtx, cancel := context.WithTimeout(leaseCtx, 60*time.Second)
				refreshUploadLease(refreshCtx, provider, leaseKey)
				cancel()
			}
		}
	}()
	defer stopLeaseRefresh()

	// Resume matching: build the full matched set up front (rather than
	// deciding file-by-file inside the loop below) so filesDone/bytesDone
	// can be pre-seeded with the resumed totals and reported in one jump
	// before any real upload work happens.
	resumedFiles := make(map[string]SnapshotFile)
	if journal != nil {
		var resumedBytes int64
		for _, file := range files {
			if entry, ok := journal.Lookup(journalLookupKey(file), file.size, file.modTime); ok {
				resumedFiles[journalLookupKey(file)] = entry
				resumedBytes += entry.Size
			}
		}
		if len(resumedFiles) > 0 {
			markDone(len(resumedFiles), resumedBytes)
			log.Info("resuming interrupted snapshot from checkpoint journal",
				"snapshotId", snapshot.ID,
				"resumedFiles", len(resumedFiles),
				"resumedBytes", resumedBytes,
			)
			// The forced registration emit below reports these seeded counters,
			// so no separate emission is needed here.
		}
	}

	// Register the snapshot ID with the server BEFORE the first byte is
	// uploaded (#3006). Every later emission carries it too, but this forced
	// one guarantees it is sent even if the run dies during the very first
	// file — and it is the only emission not subject to the throttle window,
	// so the server learns the ID immediately rather than up to
	// progressThrottle later.
	//
	// Placed AFTER the resume pre-seed on purpose: emitting first would report
	// filesDone/bytesDone as 0 on a resumed run and then jump up, and progress
	// that appears to go backwards is precisely what the counters are not
	// allowed to do (see startRunKeepalive in backup.go).
	emitProgress(true)

	// abortStopped is the single exit point for every errBackupStopped
	// return. See the journal parameter doc above for why cleanup is
	// conditional on journal == nil.
	abortStopped := func() (*Snapshot, error) {
		if journal == nil {
			// Stop the lease-refresh ticker BEFORE cleanup, not after (via
			// the deferred stopLeaseRefresh() at the top of this function):
			// a ticker fire racing cleanupSnapshotPrefix would re-PUT
			// upload.lease into the prefix cleanup just emptied, leaving an
			// orphan object behind and defeating the point of cleaning up.
			stopLeaseRefresh()
			cleanupSnapshotPrefix(provider, snapshot.ID)
		}
		return nil, errBackupStopped
	}

	// abortSourceGone is the single exit point for the abort taken when the
	// source snapshot goes away mid-run (#3260). The run stops either way; what
	// differs is what happens to the objects already uploaded, and that turns
	// entirely on whether this run has a checkpoint journal.
	//
	//   journal != nil — the prefix plus the journal ARE the resume state, and
	//     the next attempt resumes into this very snapshot ID. No manifest:
	//     publishing one now would stake a completed-snapshot claim on an ID
	//     the next run is still filling in. Nothing is deleted.
	//
	//   journal == nil — there is no resume state, so leaving the prefix
	//     unpublished would strand the uploaded objects as unreachable orphans.
	//     Publish a PARTIAL manifest instead, making them a real restore point.
	//     This is not a "snapshot that lies": a manifest enumerates what the
	//     snapshot contains, it does not assert completeness, and the run is
	//     still reported as FAILED with the source-loss reason and the counts.
	//     Deleting them would be a regression against the pre-#3260 behaviour,
	//     where the same run finished as a flagged partial success and left a
	//     usable restore point behind.
	//
	// The error carries the counts because #3260's whole complaint is that the
	// operator-visible failure said nothing useful about what happened.
	abortSourceGone := func(cause error) (*Snapshot, error) {
		detail := fmt.Errorf("%w (aborted after %d of %d files uploaded, %d failed)",
			cause, len(snapshot.Files), filesTotal, len(errs))
		log.Error("backup source snapshot is gone mid-run, aborting the run",
			"snapshotId", snapshot.ID,
			"filesUploaded", len(snapshot.Files),
			"filesFailed", len(errs),
			"filesTotal", filesTotal,
			"resumable", journal != nil,
			"error", cause.Error(),
		)
		if journal != nil {
			return nil, detail
		}
		if len(snapshot.Files) == 0 {
			// Nothing landed, so there is no restore point to preserve and the
			// prefix holds no recoverable data. Same disposal as any other
			// journal-less abort. Stop the lease ticker BEFORE cleanup for the
			// same reason as abortStopped above — a racing refresh would
			// re-create the prefix cleanup just emptied.
			stopLeaseRefresh()
			cleanupSnapshotPrefix(provider, snapshot.ID)
			return nil, detail
		}
		snapshot.UploadFailures = errs
		if pubErr := publishSnapshotManifest(ctx, provider, snapshot, prefix); pubErr != nil {
			// Deliberately NOT followed by cleanupSnapshotPrefix. Deletion is
			// irreversible and this is a data-protection product: retained
			// orphans cost storage, deleted backups cost the customer their
			// files. Log loudly enough that an operator can find them.
			log.Error("could not publish a partial manifest for the aborted run; the uploaded objects are RETAINED but unreachable without one",
				"snapshotId", snapshot.ID,
				"prefix", prefix,
				"filesUploaded", len(snapshot.Files),
				"error", pubErr.Error(),
			)
			return snapshot, errors.Join(detail, pubErr)
		}
		log.Warn("published a PARTIAL manifest for the aborted run; it restores the files that landed before the source snapshot went away",
			"snapshotId", snapshot.ID,
			"filesUploaded", len(snapshot.Files),
			"filesTotal", filesTotal,
		)
		stopLeaseRefresh()
		if delErr := provider.Delete(leaseKey); delErr != nil {
			log.Warn("failed to remove upload.lease after partial publish", "key", leaseKey, "error", delErr.Error())
		}
		return snapshot, detail
	}

	for _, file := range files {
		if err := ctx.Err(); err != nil {
			return abortStopped()
		}
		if entry, ok := resumedFiles[journalLookupKey(file)]; ok {
			// Already uploaded in a prior (interrupted) run with identical
			// (size, modTime) — filesDone/bytesDone already reflect this
			// file via the pre-loop seed above; do not double count.
			snapshot.Files = append(snapshot.Files, entry)
			snapshot.Size += entry.Size
			continue
		}
		if decision, refEntry := decideFile(file, prevIndex); decision == decideReference {
			// Unchanged since prevSnapshot: no upload, no journal Record
			// (there is nothing new to checkpoint — the bytes already live
			// under prevSnapshot's prefix), but bytes/files still count
			// toward progress through the same locked markDone path as a
			// real upload, so the UI sees the same instant jump a journal
			// resume produces.
			snapshot.Files = append(snapshot.Files, refEntry)
			snapshot.Size += refEntry.Size
			markDone(1, refEntry.Size)
			emitProgress(false)
			continue
		}
		backupPath := path.Join(prefix, snapshotFilesDir, file.snapshotPath)
		backupPath = ensureGzipExtension(backupPath)

		// Log the file we are ABOUT to upload, at debug, before we block on it.
		// This is the line that makes a wedged backup diagnosable: the deadline
		// below scales with file size and has no ceiling, so a large file whose
		// upload stalls mid-body can hold the loop for hours with no other
		// output. Without a start line the last thing in the log is the
		// previous file's success and there is no way to tell which file is
		// stuck (#2790, #2798).
		deadline := uploadDeadline(file.size)
		log.Debug("uploading file",
			"path", file.sourcePath,
			"backupPath", backupPath,
			"bytes", file.size,
			"deadlineMs", deadline.Milliseconds(),
			"snapshotId", snapshot.ID,
		)

		uploadStart := time.Now()
		uploadErr := attemptFileUpload(ctx, provider, file, backupPath)
		if uploadErr != nil && !errors.Is(uploadErr, errBackupStopped) {
			// Before spending anything else on this failure, make sure the
			// source we are reading from still exists. If the shadow copy died,
			// this file is not bad and neither is any file after it — sleeping
			// on a retry, and then blaming the file, is exactly the behaviour
			// that turned 15 unreadable files into 40 lost ones (#3260).
			if goneErr := sourceLiveness(file.sourcePath); goneErr != nil {
				return abortSourceGone(goneErr)
			}
			policy, reason := classifyUploadFailure(uploadErr, file.sourcePath)
			if policy == skipWithoutRetry {
				// The source is locked by a live process, already gone, or an
				// unhydratable cloud placeholder. A retry cannot change that,
				// so skip immediately instead of burning uploadRetryDelay on a
				// foregone conclusion — a real 123,600-file C:\Users run spent
				// 2h38m of its 2h41m asleep here for 316 such files (#2997).
				//
				// This ONLY removes the sleep. The file falls through to the
				// same skip-and-continue block below: counted in
				// UploadFailures (and so job.ErrorCount), job carries on.
				log.Warn("file upload failed permanently, skipping without retry",
					"path", file.sourcePath,
					"bytes", file.size,
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
					"bytes", file.size,
					"elapsedMs", time.Since(uploadStart).Milliseconds(),
					"deadlineMs", deadline.Milliseconds(),
					"retryDelayMs", retryDelay.Milliseconds(),
					"reason", reason,
					"error", uploadErr.Error(),
				)
				select {
				case <-ctx.Done():
					uploadErr = errBackupStopped
				case <-time.After(retryDelay):
					uploadErr = attemptFileUpload(ctx, provider, file, backupPath)
				}
			}
		}
		if uploadErr != nil {
			if errors.Is(uploadErr, errBackupStopped) {
				return abortStopped()
			}
			// Probed a second time on purpose: the retry above is the window in
			// which the snapshot most often dies, and #3260's own tell was a
			// file whose error flipped from ACCESS_DENIED to PATH_NOT_FOUND
			// between the first attempt and the retry. Costs one stat per
			// failing file, and the very first one to see a dead root ends the
			// run — so at most one extra stat beyond the abort itself.
			if goneErr := sourceLiveness(file.sourcePath); goneErr != nil {
				return abortSourceGone(goneErr)
			}
			err := fmt.Errorf("failed to upload %s: %w", file.sourcePath, uploadErr)
			errs = append(errs, err)
			// This is skip-and-continue: the file is dropped from the backup
			// but the job carries on. Warn so it is visible without debug
			// shipping, and count it so the summary at the end is trustworthy.
			log.Warn("file upload failed, skipping file",
				"path", file.sourcePath,
				"bytes", file.size,
				"elapsedMs", time.Since(uploadStart).Milliseconds(),
				"failedSoFar", len(errs),
				"error", uploadErr.Error(),
			)
			continue
		}
		uploadMs := time.Since(uploadStart).Milliseconds()

		// Checksum the source bytes so integrity/test-restore can detect silent
		// corruption of the stored object. A hash failure here is non-fatal —
		// the file is still backed up; it just won't carry a checksum (verify
		// falls back to a size check for it).
		//
		// NOTE: this re-reads the source after the upload above. On a host with
		// no snapshotting (Unix has no VSS), a file that mutates between the
		// upload read and this hash read yields a checksum that won't match the
		// stored object, so a later verify raises a false "corruption" alert.
		// That's the safe direction (a false alarm, not a silent pass) and is
		// consistent with the pre-existing size-from-collection vs content-from-
		// upload race. Eliminating it fully requires hashing the bytes as they
		// stream to the provider (a provider-interface change) — left as future work.
		// Timed separately from the upload: this is a second full read of the
		// source file, so on a large file or a slow/network-mounted path it is
		// a real chunk of wall-clock that produces zero network traffic and
		// zero progress movement. Without its own timing it looks identical to
		// a stalled upload from the outside.
		sumStart := time.Now()
		checksum, sumErr := sha256File(file.sourcePath)
		if sumErr != nil {
			log.Warn("checksum failed, file stored without one",
				"path", file.sourcePath,
				"bytes", file.size,
				"error", sumErr.Error(),
			)
		}
		log.Debug("file uploaded",
			"path", file.sourcePath,
			"bytes", file.size,
			"uploadMs", uploadMs,
			"checksumMs", time.Since(sumStart).Milliseconds(),
			"snapshotId", snapshot.ID,
		)

		entry := SnapshotFile{
			SourcePath:   file.sourcePath,
			OriginalPath: file.originalPath,
			BackupPath:   backupPath,
			Size:         file.size,
			ModTime:      file.modTime,
			Checksum:     checksum,
			Mode:         uint32(file.mode.Perm()),
		}
		snapshot.Files = append(snapshot.Files, entry)
		snapshot.Size += file.size
		markDone(1, file.size)
		emitProgress(false)
		if journal != nil {
			// Record logs and swallows its own write failures — a dead
			// journal degrades resume for next time, it never fails this
			// backup, whose file upload already succeeded.
			_ = journal.Record(entry)
		}
	}
	// Unconditional final call: guarantees the server observes the true end
	// state even if the last file(s) landed inside the throttle window and
	// were swallowed by the `!force` check above.
	emitProgress(true)

	if len(snapshot.Files) == 0 {
		return nil, errors.Join(errs...)
	}
	// Partial success: some files uploaded, some failed. Carry the per-file
	// failures on the snapshot (in-memory only, see UploadFailures) so the
	// manager can surface them as a job Warning/ErrorCount instead of
	// silently dropping them here (they used to be returned only when ZERO
	// files uploaded).
	snapshot.UploadFailures = errs

	if err := ctx.Err(); err != nil {
		return abortStopped()
	}

	// System state (if any was collected for this run — see withSystemState)
	// publishes BEFORE the ordinary manifest below: see withSystemState's doc
	// comment for why the order matters to a concurrent GC sweep.
	if options.systemStateManifest != nil && len(options.systemStateManifest.Artifacts) > 0 {
		if err := publishSystemState(ctx, provider, snapshot.ID, options.systemStateStagingDir, options.systemStateManifest); err != nil {
			log.Error("system state publish failed; the snapshot's ordinary files were still stored, "+
				"but the restore point is missing bare-metal recovery state",
				"snapshotId", snapshot.ID,
				"error", err.Error(),
			)
			if errors.Is(err, errBackupStopped) {
				return abortStopped()
			}
			return snapshot, fmt.Errorf("system state publish failed: %w", err)
		}
	}

	if options.layoutManifest != nil {
		if err := publishLayoutManifest(ctx, provider, snapshot.ID, options.layoutManifest); err != nil {
			if errors.Is(err, errBackupStopped) {
				return abortStopped()
			}
			return snapshot, fmt.Errorf("layout manifest publish failed: %w", err)
		}
	}

	if err := publishSnapshotManifest(ctx, provider, snapshot, prefix); err != nil {
		if errors.Is(err, errBackupStopped) {
			// A manifest-upload deadline expiry is fatal for the snapshot too
			// (unlike a per-file data upload): without the manifest the
			// snapshot isn't restorable, so there's nothing to keep going for.
			return abortStopped()
		}
		return snapshot, err
	}

	if journal != nil {
		if err := journal.Complete(); err != nil {
			log.Warn("failed to remove completed checkpoint journal", "error", err.Error())
		}
		completed = true
	}

	stopLeaseRefresh()
	if delErr := provider.Delete(leaseKey); delErr != nil {
		log.Warn("failed to remove upload.lease after publish", "key", leaseKey, "error", delErr.Error())
	}

	return snapshot, nil
}

// fetchPublishedManifest checks whether prefix's manifest.json has already
// been published, distinguishing three outcomes (P1 fix — a transient
// error must NEVER be treated the same as confirmed absence):
//   - (snapshot, nil): confirmed present and decodable — the caller's
//     resume-shortcut must return this snapshot, uploading nothing.
//   - (nil, nil): CONFIRMED absent (providers.ErrObjectNotFound) — safe to
//     proceed with a normal upload.
//   - (nil, err): anything else (network error, decode error, corrupt
//     manifest, context already done) — the caller MUST fail the run
//     closed: upload nothing, delete nothing, since we genuinely don't
//     know whether a real manifest exists at this prefix.
func fetchPublishedManifest(ctx context.Context, provider providers.BackupProvider, prefix string) (*Snapshot, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
	}
	manifestKey := path.Join(prefix, snapshotManifestKey)
	tempFile, err := os.CreateTemp("", "resume-manifest-*.json")
	if err != nil {
		return nil, fmt.Errorf("failed to create temp file for resume manifest check: %w", err)
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	// Best-effort: tempPath is an OS temp file already read (or about to
	// fail trying) — a leftover on Remove failure is harmless temp-dir
	// clutter, not a correctness issue worth surfacing.
	defer func() { _ = os.Remove(tempPath) }()

	if err := provider.Download(manifestKey, tempPath); err != nil {
		if errors.Is(err, providers.ErrObjectNotFound) {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to check for an already-published manifest at %s: %w", manifestKey, err)
	}
	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read downloaded resume manifest: %w", err)
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("failed to decode resume manifest %s: %w", manifestKey, err)
	}
	return &snapshot, nil
}

// refreshUploadLease best-effort writes the current UTC time (RFC3339) to
// leaseKey. Failure is logged, never fatal — see the upload.lease doc
// comment in createSnapshotWithProgress.
func refreshUploadLease(ctx context.Context, provider providers.BackupProvider, leaseKey string) {
	tempFile, err := os.CreateTemp("", "upload-lease-*.txt")
	if err != nil {
		log.Warn("failed to create upload lease temp file", "error", err.Error())
		return
	}
	tempPath := tempFile.Name()
	if _, err := tempFile.WriteString(time.Now().UTC().Format(time.RFC3339)); err != nil {
		_ = tempFile.Close()
		// Best-effort cleanup of a temp file we're abandoning anyway; a
		// Remove failure here is harmless temp-dir clutter.
		_ = os.Remove(tempPath)
		log.Warn("failed to write upload lease content", "error", err.Error())
		return
	}
	_ = tempFile.Close()
	// Best-effort: tempPath is an OS temp file already uploaded (or about to
	// fail trying) — a leftover on Remove failure is harmless temp-dir
	// clutter, not a correctness issue worth surfacing.
	defer func() { _ = os.Remove(tempPath) }()
	if err := uploadSnapshotFile(ctx, provider, tempPath, leaseKey); err != nil {
		log.Warn("failed to refresh upload lease", "key", leaseKey, "error", err.Error())
	}
}

// publishSnapshotManifest serializes snapshot's manifest and uploads it under
// prefix, making the objects already stored there a reachable restore point.
//
// Extracted so the mid-run source-loss abort can publish the partial set it
// managed to store (see abortSourceGone) using exactly the same code path as a
// normal completion — a second, subtly different manifest writer is how the two
// would drift apart. errBackupStopped is returned unwrapped so callers can tell
// a job cancel from a genuine manifest failure.
func publishSnapshotManifest(ctx context.Context, provider providers.BackupProvider, snapshot *Snapshot, prefix string) error {
	manifestPath, manifestErr := writeSnapshotManifest(snapshot)
	if manifestErr != nil {
		return manifestErr
	}
	defer os.Remove(manifestPath)

	manifestKey := path.Join(prefix, snapshotManifestKey)
	manifestInfo, statErr := os.Stat(manifestPath)
	var manifestSize int64
	if statErr == nil {
		manifestSize = manifestInfo.Size()
	}
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, uploadDeadline(manifestSize))
	manifestUploadErr := uploadSnapshotFile(attemptCtx, provider, manifestPath, manifestKey)
	cancelAttempt()
	if manifestUploadErr != nil {
		if errors.Is(manifestUploadErr, errBackupStopped) {
			return manifestUploadErr
		}
		return fmt.Errorf("failed to upload snapshot manifest: %w", manifestUploadErr)
	}
	return nil
}

// publishLayoutManifest uploads manifest as snapshots/<snapshotID>/layout.json.
func publishLayoutManifest(ctx context.Context, provider providers.BackupProvider, snapshotID string, manifest *layout.Manifest) error {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return fmt.Errorf("encode layout manifest: %w", err)
	}
	tmp, err := os.CreateTemp("", "breeze-layout-*.json")
	if err != nil {
		return fmt.Errorf("stage layout manifest: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := tmp.Write(data); err != nil {
		// Best-effort: we are already returning the write error, a Close
		// failure on this already-broken fd has nothing new to add.
		_ = tmp.Close()
		return fmt.Errorf("stage layout manifest: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("stage layout manifest: %w", err)
	}
	key := path.Join(snapshotRootDir, snapshotID, layoutManifestKey)
	attemptCtx, cancel := context.WithTimeout(ctx, uploadDeadline(int64(len(data))))
	defer cancel()
	if err := uploadSnapshotFile(attemptCtx, provider, tmpPath, key); err != nil {
		if errors.Is(err, errBackupStopped) {
			return err
		}
		return fmt.Errorf("upload %s: %w", key, err)
	}
	return nil
}

// publishSystemState uploads every artifact manifest describes (read from
// stagingDir, where systemstate.CollectSystemState wrote them) to
// snapshots/<snapshotID>/system-state/<artifact.Path>, then uploads manifest
// itself to snapshots/<snapshotID>/system-state/manifest.json.
//
// Deliberately a SEPARATE remote prefix and a separate publish step from the
// ordinary files/ tree and publishSnapshotManifest: mixing the two write
// paths (appending the staging dir into the ordinary file walk) is exactly
// the D15/O10 bug this function exists to fix — see the plan doc referenced
// on systemStateDir. A caller invokes this using the SAME snapshot ID as the
// rest of that run's snapshot (its own, for a state-only run; or the one
// createSnapshotWithProgress already minted, for a run that also has
// configured file paths), so bmr.go's bootstrap-driven lookup by snapshot ID
// finds both trees under one prefix.
//
// Every artifact must exist in stagingDir at exactly the size the collector
// recorded (SizeBytes) — a mismatch means the staging file was mutated or
// truncated after collection, which is treated as a hard failure rather than
// silently uploading corrupt/incomplete bytes. Checksums are computed by the
// collector at collection time (systemstate.artifactFromFile /
// collectArtifactsInDir) and carried through unchanged here; a downloading
// consumer verifies against them.
//
// Returns nil for a nil manifest (nothing to publish) — callers gate this
// off Artifacts being non-empty before calling, but staying a safe no-op
// keeps this function usable standalone too.
func publishSystemState(ctx context.Context, provider providers.BackupProvider, snapshotID, stagingDir string, manifest *systemstate.SystemStateManifest) error {
	if manifest == nil {
		return nil
	}
	// Belt-and-suspenders alongside systemstate.CollectSystemState (which
	// already sets this on the real collection path): guarantees every
	// manifest this function ever publishes carries a schema version, even
	// one built by a test double or future caller that bypasses
	// CollectSystemState.
	manifest.SchemaVersion = systemStateManifestSchemaVersion
	prefix := path.Join(snapshotRootDir, snapshotID, systemStateDir)

	for i := range manifest.Artifacts {
		art := &manifest.Artifacts[i]
		if art.LinkTarget != "" {
			// Symlink artifact: no independent file content to upload (see
			// Artifact.LinkTarget's doc comment) — the manifest entry alone,
			// written below, is enough for a consumer to recreate the link.
			continue
		}
		localPath := filepath.Join(stagingDir, filepath.FromSlash(art.Path))

		info, statErr := os.Stat(localPath)
		if statErr != nil {
			return fmt.Errorf("stat system state artifact %s: %w", art.Path, statErr)
		}
		if info.Size() != art.SizeBytes {
			return fmt.Errorf("system state artifact %s changed size since collection (expected %d bytes, found %d)",
				art.Path, art.SizeBytes, info.Size())
		}

		remoteKey := path.Join(prefix, art.Path)
		attemptCtx, cancelAttempt := context.WithTimeout(ctx, uploadDeadline(info.Size()))
		uploadErr := uploadSnapshotFile(attemptCtx, provider, localPath, remoteKey)
		cancelAttempt()
		if uploadErr != nil {
			if errors.Is(uploadErr, errBackupStopped) {
				return uploadErr
			}
			return fmt.Errorf("upload system state artifact %s: %w", art.Path, uploadErr)
		}
	}

	manifestPath, manifestErr := writeSystemStateManifest(manifest)
	if manifestErr != nil {
		return manifestErr
	}
	// Best-effort: manifestPath is a local OS temp file, already uploaded (or
	// about to fail trying) — a leftover on Remove failure is harmless OS
	// temp-dir clutter, not a correctness issue worth failing the publish
	// over. Matches the sibling cleanup in publishSnapshotManifest above.
	defer func() { _ = os.Remove(manifestPath) }()

	manifestKey := path.Join(prefix, systemStateManifestKey)
	manifestInfo, statErr := os.Stat(manifestPath)
	var manifestSize int64
	if statErr == nil {
		manifestSize = manifestInfo.Size()
	}
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, uploadDeadline(manifestSize))
	manifestUploadErr := uploadSnapshotFile(attemptCtx, provider, manifestPath, manifestKey)
	cancelAttempt()
	if manifestUploadErr != nil {
		if errors.Is(manifestUploadErr, errBackupStopped) {
			return manifestUploadErr
		}
		return fmt.Errorf("failed to upload system state manifest: %w", manifestUploadErr)
	}
	return nil
}

// writeSystemStateManifest serializes manifest to a temp file for upload,
// mirroring writeSnapshotManifest.
func writeSystemStateManifest(manifest *systemstate.SystemStateManifest) (string, error) {
	tempFile, err := os.CreateTemp("", "system-state-manifest-*.json")
	if err != nil {
		return "", fmt.Errorf("failed to create system state manifest: %w", err)
	}
	encoder := json.NewEncoder(tempFile)
	if err := encoder.Encode(manifest); err != nil {
		_ = tempFile.Close()
		return "", fmt.Errorf("failed to encode system state manifest: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return "", fmt.Errorf("failed to close system state manifest: %w", err)
	}
	return tempFile.Name(), nil
}

// attemptFileUpload runs a single upload attempt for file against a fresh
// per-attempt context scoped to ctx with a size-scaled deadline (see
// uploadDeadline). A deadline expiry that is not also a job-context cancel is
// converted to a plain error so the caller can distinguish "this file
// stalled" (retry / skip-and-continue) from "the job was cancelled" (abort).
func attemptFileUpload(ctx context.Context, provider providers.BackupProvider, file backupFile, backupPath string) error {
	deadline := uploadDeadline(file.size)
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, deadline)
	defer cancelAttempt()
	uploadErr := uploadSnapshotFile(attemptCtx, provider, file.sourcePath, backupPath)
	if errors.Is(uploadErr, errBackupStopped) && ctx.Err() == nil {
		// The per-file deadline fired, not a job cancel. Log it distinctly:
		// a deadline expiry means we sat on one file for the whole (size-
		// scaled, uncapped) window with the destination accepting the request
		// and never finishing it. That is a different failure from an outright
		// upload error and it is the signature of the stall in #2798.
		log.Warn("file upload deadline expired",
			"path", file.sourcePath,
			"bytes", file.size,
			"deadlineMs", deadline.Milliseconds(),
		)
		uploadErr = fmt.Errorf("upload stalled: no completion within %s", deadline)
	}
	return uploadErr
}

func uploadSnapshotFile(ctx context.Context, provider providers.BackupProvider, localPath, remotePath string) error {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return errBackupStopped
		}
	}
	if uploader, ok := provider.(contextUploader); ok {
		if err := uploader.UploadContext(ctx, localPath, remotePath); err != nil {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
				return errBackupStopped
			}
			return err
		}
		return nil
	}
	if err := provider.Upload(localPath, remotePath); err != nil {
		return err
	}
	return nil
}

func cleanupSnapshotPrefix(provider providers.BackupProvider, snapshotID string) {
	items, err := listSnapshotPrefixItems(provider, snapshotID)
	if err != nil {
		log.Error("failed to list aborted snapshot for cleanup", "snapshotId", snapshotID, "error", err.Error())
		return
	}
	for _, item := range items {
		if err := provider.Delete(item); err != nil {
			log.Error("failed to clean up aborted snapshot file", "item", item, "error", err.Error())
		}
	}
}

// ListSnapshots returns snapshots available from the provider.
func ListSnapshots(provider providers.BackupProvider) ([]Snapshot, error) {
	if provider == nil {
		return nil, errors.New("backup provider is required")
	}

	items, err := provider.List(snapshotRootDir)
	if err != nil {
		return nil, err
	}

	var snapshots []Snapshot
	var errs []error

	for _, item := range items {
		if !isManifestPath(item) {
			continue
		}

		tempFile, err := os.CreateTemp("", "snapshot-manifest-*.json")
		if err != nil {
			err = fmt.Errorf("failed to create temp manifest: %w", err)
			errs = append(errs, err)
			log.Warn("snapshot manifest temp file failed", "error", err.Error())
			continue
		}
		tempPath := tempFile.Name()
		_ = tempFile.Close()

		if err := provider.Download(item, tempPath); err != nil {
			os.Remove(tempPath)
			err = fmt.Errorf("failed to download manifest %s: %w", item, err)
			errs = append(errs, err)
			log.Warn("snapshot manifest download failed", "item", item, "error", err.Error())
			continue
		}

		manifestFile, err := os.Open(tempPath)
		if err != nil {
			os.Remove(tempPath)
			err = fmt.Errorf("failed to open manifest %s: %w", tempPath, err)
			errs = append(errs, err)
			log.Warn("snapshot manifest open failed", "item", item, "error", err.Error())
			continue
		}
		var snapshot Snapshot
		if err := json.NewDecoder(manifestFile).Decode(&snapshot); err != nil {
			_ = manifestFile.Close()
			os.Remove(tempPath)
			err = fmt.Errorf("failed to decode manifest %s: %w", item, err)
			errs = append(errs, err)
			log.Warn("snapshot manifest decode failed", "item", item, "error", err.Error())
			continue
		}
		if err := manifestFile.Close(); err != nil {
			err = fmt.Errorf("failed to close manifest %s: %w", item, err)
			errs = append(errs, err)
			log.Warn("snapshot manifest close failed", "item", item, "error", err.Error())
		}
		os.Remove(tempPath)

		snapshots = append(snapshots, snapshot)
	}

	sort.Slice(snapshots, func(i, j int) bool {
		return snapshots[i].Timestamp.Before(snapshots[j].Timestamp)
	})

	if len(snapshots) == 0 && len(errs) > 0 {
		return nil, errors.Join(errs...)
	}
	return snapshots, errors.Join(errs...)
}

func listSnapshotPrefixItems(provider providers.BackupProvider, snapshotID string) ([]string, error) {
	prefix := path.Join(snapshotRootDir, snapshotID)
	items, err := provider.List(prefix + "/")
	if err != nil {
		return nil, err
	}

	scoped := make([]string, 0, len(items))
	for _, item := range items {
		cleaned := path.Clean(item)
		if cleaned == prefix || strings.HasPrefix(cleaned, prefix+"/") {
			scoped = append(scoped, item)
		}
	}
	return scoped, nil
}

// ensureGzipExtension derives the stored object-key suffix for an uploaded
// (always-gzip-compressed) file. It ALWAYS appends ".gz", even when p
// already ends in ".gz" (yielding ".gz.gz") — this keeps the derived key
// injective over source snapshot paths. A conditional append (skip when p
// already ends in ".gz") would map two distinct source paths — e.g. "report"
// and "report.gz", or "a.tar" and "a.tar.gz" — onto the identical stored
// key, so whichever upload lands last silently overwrites the other file's
// bytes while the job still reports success (D2).
func ensureGzipExtension(p string) string {
	return p + ".gz"
}

func isManifestPath(item string) bool {
	item = path.Clean(item)
	return strings.HasSuffix(item, "/"+snapshotManifestKey) || path.Base(item) == snapshotManifestKey
}

func writeSnapshotManifest(snapshot *Snapshot) (string, error) {
	tempFile, err := os.CreateTemp("", "snapshot-manifest-*.json")
	if err != nil {
		return "", fmt.Errorf("failed to create snapshot manifest: %w", err)
	}
	encoder := json.NewEncoder(tempFile)
	if err := encoder.Encode(snapshot); err != nil {
		_ = tempFile.Close()
		return "", fmt.Errorf("failed to encode snapshot manifest: %w", err)
	}
	if err := tempFile.Close(); err != nil {
		return "", fmt.Errorf("failed to close snapshot manifest: %w", err)
	}
	return tempFile.Name(), nil
}

// backupIdentity returns the material used to derive a checkpoint journal's
// identity (see journal.go) for a given provider + backup path set: enough
// to distinguish two different destinations — so a journal from one
// destination is never mistaken for another's after a reconfiguration —
// without encoding credentials. Concrete providers optionally implement
// providers.JournalIdentity to supply their own kind/endpoint/bucket
// material; providers that don't (test fakes) fall back to a generic
// per-Go-type identity, which is still stable within a single provider
// instance and only risks a false-positive resume match across two
// same-Go-type fake providers in a test — never in production, where every
// real provider implements JournalIdentity.
//
// Deliberately ORDER-SENSITIVE: paths are hashed in configured order, not
// sorted. Object naming is positional (collectBackupFilesFromPaths derives
// each root's snapshotPath prefix from its index, "path_%d"), so a path-list
// reorder between an interrupted run and its resume would keep the same
// identity/snapshotID/prefix under a sorted identity while silently
// swapping which root owns which index — a changed file at the new index
// then re-uploads over an object a resumed (skipped) journal entry still
// references, corrupting that entry's manifest mapping. Hashing in
// configured order instead gives a reorder a fresh identity — a fresh
// journal, no resume, safe re-upload of everything — trading a missed
// resume opportunity (rare: paths rarely reorder between runs) for
// guaranteed-correct object mapping (always required).
func backupIdentity(provider providers.BackupProvider, paths []string) string {
	material := fmt.Sprintf("%T", provider)
	if idp, ok := provider.(providers.JournalIdentity); ok {
		material = idp.BackupIdentity()
	}
	return material + "|" + strings.Join(paths, ",")
}

// runBackupIdentity returns the BackupIdentity this run should stamp onto
// its own manifest and match previous manifests against for incremental
// dedupe base selection (D6). It EXTENDS backupIdentity's provider+paths
// material — which alone cannot distinguish two DEVICES backing up to the
// same destination with the same configured paths, exactly D6's bug — with
// m.config.AgentID (the device) and the run kind (file vs system_image, so
// a system-state snapshot can never become a file run's base or vice
// versa).
//
// Returns "" when m.config.AgentID is unset — see BackupConfig.AgentID's
// doc comment for what that means downstream (previousManifest refuses to
// match anything against an empty identity).
func (m *BackupManager) runBackupIdentity() string {
	if m.config.AgentID == "" {
		return ""
	}
	kind := "file"
	if m.config.SystemStateEnabled {
		kind = "system_image"
	}
	return backupIdentity(m.config.Provider, m.config.Paths) + "|" + m.config.AgentID + "|" + kind
}

func newSnapshotID() string {
	return newID("snapshot")
}

func newJobID() string {
	return newID("job")
}

func newID(prefix string) string {
	random := make([]byte, 4)
	_, _ = rand.Read(random)
	return fmt.Sprintf("%s-%s-%x", prefix, time.Now().UTC().Format("20060102T150405Z"), random)
}
