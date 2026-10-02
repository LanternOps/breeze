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

// SHA256File streams a file through SHA-256 and returns the lowercase-hex
// digest. Streaming keeps memory flat for large files. Exported so other
// packages needing the same "hash this restored file and compare" check
// (the rebuild engine's validate phase) never drift from this package's own
// checksum logic — see sha256File, the unexported alias every call site in
// this package already uses.
func SHA256File(path string) (string, error) {
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

// sha256File is an unexported alias for SHA256File — kept so every existing
// call site in this package (written before SHA256File was exported) needs
// no change.
func sha256File(path string) (string, error) { return SHA256File(path) }

// checksumMatches reports whether the file at path hashes to want. A hashing
// error counts as a mismatch (fail-closed) so verification never passes a file
// it could not read.
// plannedDecision is a dedupe decision made while planning uploads.
type plannedDecision struct {
	decided  bool
	decision referenceDecision
	ref      SnapshotFile
}

// plannedOrDecide returns the planned decision for files[i], or decides now.
func plannedOrDecide(planned []plannedDecision, i int, file backupFile, prevIndex map[string]SnapshotFile) (referenceDecision, SnapshotFile) {
	if i < len(planned) && planned[i].decided {
		return planned[i].decision, planned[i].ref
	}
	return decideFile(file, prevIndex)
}

func checksumMatches(path, want string) bool {
	got, err := sha256File(path)
	return err == nil && got == want
}

// storedEntryMatches reports whether a journaled entry's object, stored under
// this snapshot's own prefix, still holds exactly the recorded bytes. Only a
// literal entry (never a reference into another snapshot) with a recorded
// digest can match, and only through a provider that can read the stored
// object back.
func storedEntryMatches(ctx context.Context, digester providers.StoredObjectDigester, canVerify bool, entry SnapshotFile, snapshotID string) bool {
	if !canVerify || entry.Checksum == "" || isReferenceEntry(entry, snapshotID) {
		return false
	}
	stored, err := digester.StoredObjectDigest(ctx, entry.BackupPath)
	return err == nil && stored.SHA256 == entry.Checksum && stored.Size == entry.Size
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

// UploadWithDigest implements providers.DigestUploader with the same publish
// check as UploadContext. When the wrapped provider has no digest support it
// uploads nothing and answers providers.ErrDigestUnavailable, so the caller
// stages a copy and uploads that through UploadContext (checked again).
func (g *leaseGate) UploadWithDigest(ctx context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	if err := g.checkPublish(remotePath); err != nil {
		return providers.UploadDigest{}, err
	}
	if du, ok := g.BackupProvider.(providers.DigestUploader); ok {
		return du.UploadWithDigest(ctx, localPath, remotePath)
	}
	return providers.UploadDigest{}, fmt.Errorf("%w: %T", providers.ErrDigestUnavailable, g.BackupProvider)
}

// unwrapProvider returns the provider a leaseGate wraps, or provider itself.
func unwrapProvider(provider providers.BackupProvider) providers.BackupProvider {
	if g, ok := provider.(*leaseGate); ok {
		return g.BackupProvider
	}
	return provider
}

// snapshotIDIssuerOf returns the brokered writer behind provider, if any: a
// run writing through one uses the snapshot id the control plane issued.
func snapshotIDIssuerOf(provider providers.BackupProvider) (providers.SnapshotIDIssuer, bool) {
	issuer, ok := unwrapProvider(provider).(providers.SnapshotIDIssuer)
	return issuer, ok
}

// storedObjectDigesterOf returns the provider behind provider that can read
// a stored object's digest back, if any.
func storedObjectDigesterOf(provider providers.BackupProvider) (providers.StoredObjectDigester, bool) {
	d, ok := unwrapProvider(provider).(providers.StoredObjectDigester)
	return d, ok
}

// writerFenceOf returns the brokered writer's fence behind provider, if any.
func writerFenceOf(provider providers.BackupProvider) (providers.WriterFence, bool) {
	f, ok := unwrapProvider(provider).(providers.WriterFence)
	return f, ok
}

// runSnapshotID is the id a new snapshot written through provider takes: the
// issued one for a brokered writer, otherwise a freshly minted one.
func runSnapshotID(provider providers.BackupProvider) string {
	if issuer, ok := snapshotIDIssuerOf(provider); ok {
		return issuer.SnapshotID()
	}
	return newSnapshotID()
}

// Snapshot represents a point-in-time backup.
type Snapshot struct {
	ID        string         `json:"id"`
	Timestamp time.Time      `json:"timestamp"`
	Files     []SnapshotFile `json:"files"`
	// Junctions are the NTFS directory junctions captured as links (#7325),
	// recreated on restore. Deliberately NOT entries in Files, so readers
	// that predate them ignore them — see junction.go. Omitted when the run
	// met none, keeping every other manifest byte-identical.
	Junctions []SnapshotJunction `json:"junctions,omitempty"`
	// SecurityDescriptors is the run's deduplicated table of captured NTFS
	// security descriptors (self-relative, base64), indexed 1-based by
	// SnapshotFile.SDIndex — see sdTable. Omitted when nothing was captured.
	SecurityDescriptors []string `json:"securityDescriptors,omitempty"`
	Size                int64    `json:"size"`
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
	// IncompleteFiles is how many files this run intended to back up but could
	// not upload. Unlike UploadFailures it IS serialized into the manifest,
	// because the manifest is the only thing a later reader has: a file that
	// failed to upload is simply absent from Files, so a verification that
	// walks Files alone finds every object it lists and reports `passed` with
	// zero failures on a demonstrably incomplete restore point (#6350).
	// VerifyIntegrityContext reads this to refuse `passed`.
	IncompleteFiles int `json:"incompleteFiles,omitempty"`
	// IncompleteFilePaths names the files counted by IncompleteFiles, capped
	// at maxManifestIncompletePaths — the full list can be thousands of
	// entries and the manifest is downloaded on every verify/restore.
	IncompleteFilePaths []string `json:"incompleteFilePaths,omitempty"`
	// VolatileFiles counts this run's entries recorded with Volatile: true
	// (see that field). In-memory only, like UploadFailures — RunBackupContext
	// folds it into a job Warning so a run with volatile files is visible
	// server-side instead of silently carrying entries whose mismatch checks
	// are quietly downgraded to warnings on every future restore/verify.
	VolatileFiles int `json:"-"`
	// PublishedObjects holds, per attestation role, the control objects this
	// run itself uploaded for this snapshot, with the digests of the uploaded
	// bytes (see publishControlObject). In-memory only. Empty for a snapshot
	// read back from storage.
	PublishedObjects map[string]PublishedObject `json:"-"`
	// attestationWithheld, when set, says why this run must not attest the
	// snapshot even though it published its control objects.
	attestationWithheld string
}

// SnapshotFile captures metadata for a backed up file.
//
// Checksum + Mode were added so integrity/test-restore can detect silent
// corruption and so restore can reapply Unix permissions. Both are
// `omitempty`: manifests written before this change carry neither, and the
// verify/restore paths treat an absent value as "not available" and fall back
// gracefully (size-only check on verify, default mode on restore).
// Entry kinds. "" (the zero value) is a regular file with uploaded content.
const (
	KindSymlink = "symlink"
	KindDir     = "dir"
)

// manifestFormatFidelity marks a manifest that carries content-less entries
// (symlinks/directories) and/or ownership — bare-metal W02. Readers older
// than W02 ignore the fields and would try to download an empty BackupPath
// for a symlink; every reader in this repo checks HasContent() first.
const manifestFormatFidelity = 3

// FileOwner is the Unix owner of an entry. Nil on Windows and in manifests
// written before W02.
type FileOwner struct {
	UID int `json:"uid"`
	GID int `json:"gid"`
}

type SnapshotFile struct {
	SourcePath string    `json:"sourcePath"`
	BackupPath string    `json:"backupPath"`
	Size       int64     `json:"size"`
	ModTime    time.Time `json:"modTime"`
	// Checksum is the lowercase-hex SHA-256 of the ORIGINAL (uncompressed)
	// bytes the upload read and stored — the digest of the upload itself
	// (see uploadWithDigest), never a separate read of the source. Size is
	// the length of those same bytes. Verify/restore compare it against the bytes returned by
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
	// Kind is "" for a regular file (content uploaded at BackupPath),
	// KindSymlink or KindDir for content-less entries (BackupPath, Checksum
	// and Size are empty/zero). LinkTarget is the verbatim readlink result.
	Kind       string `json:"kind,omitempty"`
	LinkTarget string `json:"linkTarget,omitempty"`
	// ModeBits is the full Unix mode (perm + setuid/setgid/sticky), unlike
	// Mode which is perm-only for compatibility. 0 = unknown.
	ModeBits uint32 `json:"modeBits,omitempty"`
	// Owner is nil when unknown (Windows, pre-W02 manifests).
	Owner *FileOwner `json:"owner,omitempty"`
	// Volatile is true when the source file kept changing while it was being
	// backed up (grew/shrank/rewritten between the pre-upload stat and the
	// re-upload retry — see reconcileAfterUpload). Size/Checksum still
	// describe exactly the bytes stored at BackupPath (the digest of the
	// upload that holds the object), but not necessarily the file's state at
	// any single instant an observer could point to. Restore/verify treat a size or checksum mismatch on a
	// Volatile entry as a warning, not a failed file (#5581) — the file is
	// inherently a moving target (a live log, the agent's own checkpoint
	// journal) and the manifest is already self-consistent with what was
	// uploaded. Omitted (false) for the overwhelming majority of files,
	// keeping ordinary manifests byte-identical to before this field existed.
	Volatile bool `json:"volatile,omitempty"`
	// Placeholder is true ONLY for a KindDir entry that the walker force-
	// recorded because the directory itself matched a user/preset exclude
	// pattern (#5493) — e.g. /proc, /tmp under the whole-machine preset.
	// Its mode/owner exist so a rebuild into an EMPTY tree still gets them,
	// but they were never a deliberate "this directory's permissions
	// matter" capture the way a genuinely empty or non-default-mode dir
	// entry's are. Restore honors that distinction: mode/owner are applied
	// only when creating the directory fresh; an ALREADY-EXISTING
	// directory is left untouched, so an ordinary backup_restore can never
	// silently revert permissions a customer tightened on an excluded
	// directory after the backup ran (review fix). Never set for a
	// genuinely empty or non-default-mode directory, nor for a file or
	// symlink. Omitted (false) for every manifest written before this field
	// existed, keeping them byte-identical.
	Placeholder bool `json:"placeholder,omitempty"`
	// WinAttrs is the file's preserved Windows file attributes (#5407) —
	// Hidden, System, ReadOnly, Temporary, NotContentIndexed and SparseFile.
	// 0 means "unknown" (a non-Windows backup, or any manifest written
	// before this field existed) → restore leaves whatever the fresh write
	// produced, so pre-existing manifests stay byte-identical and behave
	// exactly as before. Archive is deliberately not captured — see
	// securefs.PreservedWinAttrs.
	WinAttrs uint32 `json:"winAttrs,omitempty"`
	// SDIndex is the 1-based slot of this entry's NTFS security descriptor
	// in Snapshot.SecurityDescriptors — see sdTable. 0 = none captured
	// (capture off, a symlink, non-Windows, a per-entry capture failure, or
	// a manifest older than this field).
	SDIndex int `json:"sdIndex,omitempty"`
}

// HasContent reports whether the entry has an uploaded object at BackupPath.
func (f SnapshotFile) HasContent() bool { return f.Kind == "" }

// snapshotNeedsFidelityFormat reports whether files contains any
// content-less entry, ownership, or a captured security descriptor — see
// manifestFormatFidelity.
func snapshotNeedsFidelityFormat(files []SnapshotFile) bool {
	for _, f := range files {
		if f.Kind != "" || f.Owner != nil || f.SDIndex > 0 {
			return true
		}
	}
	return false
}

// contentlessEntry builds the manifest entry for a symlink or directory:
// nothing is uploaded, so BackupPath/Checksum/Size stay empty.
func contentlessEntry(f backupFile) SnapshotFile {
	return SnapshotFile{
		SourcePath:   f.sourcePath,
		OriginalPath: f.originalPath,
		ModTime:      f.modTime,
		Kind:         f.kind,
		LinkTarget:   f.linkTarget,
		ModeBits:     f.modeBits,
		Owner:        f.owner,
		Placeholder:  f.placeholder,
		WinAttrs:     f.winAttrs,
	}
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

// uploadTimeoutCeiling caps uploadDeadline (#7105). Before the cap the
// deadline scaled linearly with no ceiling: ~17 h for a 4 GB file and ~7 days
// for a 40 GB one, so a black-holed multipart body held the upload loop for
// days (#2798).
//
// 24 h, and not the "an hour is generous" #2798 floated, because a cap only
// helps if it never fires on an upload that is actually moving. A file that
// hits the cap is retried once and then SKIPPED, and every later run restarts
// it from zero, so a cap below a real file's transfer time drops that file
// from every backup, permanently. 24 h still carries a 40 GB file (a PST, a
// VHDX) over a ~4 Mbit/s uplink — the same 512 KiB/s floor rate the server's
// stall reaper assumes — and it equals the server's own no-transfer ceiling
// (BACKUP_NO_TRANSFER_MAX_WINDOW_MS in apps/api/src/jobs/staleCommandReaper.ts),
// so the agent never outwaits the window the server would give the same job.
//
// The cap binds from ~5.3 GiB up (24 h at uploadMinThroughputBps). The faster
// stall signal is now server-side: agents since #7097 report in-file byte
// progress, so a wedged upload stops advancing transferred_size and the
// reaper's no-transfer rule stops the job long before this deadline.
const uploadTimeoutCeiling = 24 * time.Hour

// uploadDeadline returns the per-file upload deadline for a file of the given
// size, scaled to size at uploadMinThroughputBps and clamped to
// [uploadTimeoutFloor, uploadTimeoutCeiling]. A stalled per-file upload is
// treated as a per-file failure (skip and continue), not a job abort — see
// CreateSnapshotContext.
func uploadDeadline(size int64) time.Duration {
	secs := size / uploadMinThroughputBps
	// Compare in seconds before converting: a Duration is int64 nanoseconds,
	// so scaling an absurd size would overflow before any clamp could see it.
	if secs >= int64(uploadTimeoutCeiling/time.Second) {
		return uploadTimeoutCeiling
	}
	d := time.Duration(secs) * time.Second
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
	uploadStagingDir      string
	systemStateStagingDir string
	systemStateManifest   *systemstate.SystemStateManifest
	layoutManifest        *layout.Manifest
	junctions             []SnapshotJunction
}

// withRunIdentity stamps identity onto the new snapshot's BackupIdentity —
// see createSnapshotWithProgress's doc comment.
func withRunIdentity(identity string) createSnapshotOption {
	return func(o *createSnapshotOptions) { o.runIdentity = identity }
}

// withUploadStagingDir sets where uploadWithDigest stages an immutable copy
// of a file for a provider that cannot report upload digests itself ("" =
// the OS temp dir).
func withUploadStagingDir(dir string) createSnapshotOption {
	return func(o *createSnapshotOptions) { o.uploadStagingDir = dir }
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
// withJunctions records the junctions the walk captured (#7325) on the
// manifest. Set by finalizeManifest, so every publication carries them,
// including a partial one. Junctions are re-collected by every scan, resumed
// or not, and never inherited from a previous manifest: a junction deleted or
// retargeted since then must not come back.
func withJunctions(junctions []SnapshotJunction) createSnapshotOption {
	return func(o *createSnapshotOptions) { o.junctions = junctions }
}

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

	snapshotID := runSnapshotID(provider)
	if journal != nil {
		if issuer, brokered := snapshotIDIssuerOf(provider); brokered && journal.snapshotID != issuer.SnapshotID() {
			// RunBackupContext binds the journal to the issued (or resumed)
			// id before anything is written; a mismatch here would write
			// objects the control plane never authorized.
			return nil, fmt.Errorf("checkpoint journal names snapshot %s but the storage session writes %s", journal.snapshotID, issuer.SnapshotID())
		}
		snapshotID = journal.snapshotID
	}
	snapshot := &Snapshot{
		ID:             snapshotID,
		Timestamp:      time.Now().UTC(),
		BackupIdentity: identity,
	}
	stagingDir := options.uploadStagingDir
	rec := newControlRecorder(journal)
	snapshot.PublishedObjects = rec.objects
	if prevSnapshot != nil {
		snapshot.FormatVersion = 2
		snapshot.BaseSnapshotID = prevSnapshot.ID
	}
	prevIndex := buildPreviousIndex(prevSnapshot)
	// sdTbl assigns this run's SDIndex slots; every entry-append site below
	// stamps from it, and finalizeManifest attaches it to the manifest.
	sdTbl := newSDTable()
	// finalizeManifest derives the manifest fields that depend on the full
	// entry list. It MUST run before EVERY publishSnapshotManifest call —
	// including abortSourceGone's mid-loop partial publish — or a published
	// manifest can carry SDIndex values with no securityDescriptors table
	// (restore would silently fall back to inherited ACLs) and miss the
	// fidelity format stamp.
	finalizeManifest := func() {
		// W02: a manifest carrying any content-less entry (symlink/dir),
		// ownership or a captured security descriptor is stamped
		// formatVersion 3 so an older reader knows to check HasContent()
		// before trusting BackupPath — see manifestFormatFidelity's doc
		// comment. Overrides the incremental format-2 stamp when both apply.
		if snapshotNeedsFidelityFormat(snapshot.Files) {
			snapshot.FormatVersion = manifestFormatFidelity
		}
		snapshot.SecurityDescriptors = sdTbl.encoded()
		snapshot.Junctions = options.junctions
	}

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
	if journal != nil && journal.resumed && !journal.ContinuedFromOtherJob() {
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
	// Source paths behind errs, kept alongside it so the published manifest can
	// name what is missing (#6350) without re-parsing error strings.
	var failedSources []string
	var volatileCount int

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
	// inFlight adds the bytes read so far of the file being uploaded, so one
	// large file advances the bar instead of freezing it (#5417). Reported
	// bytes are floored at the last value sent: a file that fails part-way
	// keeps its already-reported bytes rather than moving the bar backwards.
	// The terminal result, not this mid-run value, sets the job's final
	// transferred size.
	inFlight := newInFlightProgress(onProgress != nil)
	var reportedBytes int64
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
		reportedBytes = max(reportedBytes, bytesDone+inFlight.load())
		onProgress(filesDone, filesTotal, reportedBytes, bytesTotal, snapshot.ID)
	}
	markDone := func(fileCount int, byteCount int64) {
		progressMu.Lock()
		filesDone += fileCount
		bytesDone += byteCount
		inFlight.reset()
		progressMu.Unlock()
	}

	// Keepalive: while a single large upload (or the per-file retry backoff)
	// is in flight, the loop emits nothing — but the server-side stale reaper
	// treats a silent running job as dead and cancels it. Re-emit the current
	// counters every progressKeepaliveInterval so a long in-flight upload
	// keeps the job's last_progress_at fresh. The same goroutine also emits
	// (throttled) when inFlight signals that the current file's upload has
	// read further, so provider read paths never block on onProgress. The
	// goroutine is joined on
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
				case <-inFlight.kicks():
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
	// keyClaims holds the folded form of every object key this snapshot has
	// assigned so far (#5582 — see objectkey_casefold.go). Resumed entries'
	// keys are claimed up front, before any new upload picks a key: their
	// objects already exist in the store, and a not-yet-uploaded twin that
	// walks earlier must not land on them.
	keyClaims := objectKeyClaims{}
	if journal != nil {
		var resumedBytes int64
		tainted := journal.foldCollidingKeys()
		// A snapshot continued from another job also needs the stored
		// object to still hold the recorded bytes (see ContinueRun).
		verifyStored := journal.VerifyStoredEntries()
		digester, canVerifyStored := storedObjectDigesterOf(provider)
		if verifyStored && canVerifyStored {
			// Each check reads the stored object back; let a batching
			// provider authorize those reads in batches.
			var keys []string
			for _, file := range files {
				if entry, ok := journal.Lookup(journalLookupKey(file), file.size, file.modTime); ok && entry.BackupPath != "" {
					keys = append(keys, entry.BackupPath)
				}
			}
			providers.PrepareDownloads(unwrapProvider(provider), keys)
		}
		for _, file := range files {
			if entry, ok := journal.Lookup(journalLookupKey(file), file.size, file.modTime); ok {
				// Size and modification time can match a file whose content
				// changed. Reuse the entry only when the source still hashes
				// to the recorded digest (the digest of the uploaded source
				// bytes — the same quantity sha256File computes). This costs
				// one full read of every resumable file, still far cheaper
				// than uploading it again; a mismatch or read error uploads
				// the file afresh and the recorded digest is never replaced
				// by anything but a new upload's.
				if entry.Checksum == "" || !checksumMatches(file.sourcePath, entry.Checksum) {
					log.Info("journaled file changed since it was uploaded; uploading it again",
						"path", file.sourcePath,
						"snapshotId", snapshot.ID,
					)
					continue
				}
				if tainted[entry.BackupPath] {
					// A pre-#5582 journal stored this file and a case twin at
					// keys one object answers to; re-upload rather than
					// resume a possibly-overwritten object.
					log.Warn("not resuming journaled file whose object key collides with a case twin; re-uploading",
						"path", file.sourcePath,
						"backupPath", entry.BackupPath,
						"snapshotId", snapshot.ID,
					)
					continue
				}
				if verifyStored && !storedEntryMatches(ctx, digester, canVerifyStored, entry, snapshot.ID) {
					log.Info("journaled object from an earlier job does not match its record; uploading it again",
						"path", file.sourcePath,
						"backupPath", entry.BackupPath,
						"snapshotId", snapshot.ID,
					)
					continue
				}
				resumedFiles[journalLookupKey(file)] = entry
				resumedBytes += entry.Size
				keyClaims.claim(entry.BackupPath)
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

	// A provider that authorizes uploads in batches (a brokered writer)
	// learns the uploads ahead, in order, with the keys the loop below will
	// assign. The dedupe decisions are made once, here, and reused below.
	var plannedDecisions []plannedDecision
	if planner, ok := unwrapProvider(provider).(providers.UploadPlanner); ok {
		plannedDecisions = make([]plannedDecision, len(files))
		claims := keyClaims.clone()
		var entries []providers.PlannedUpload
		for i, file := range files {
			if file.kind != "" {
				continue
			}
			if _, resumed := resumedFiles[journalLookupKey(file)]; resumed {
				continue
			}
			decision, refEntry := decideFile(file, prevIndex)
			plannedDecisions[i] = plannedDecision{decided: true, decision: decision, ref: refEntry}
			if decision == decideReference {
				continue
			}
			naturalKey := ensureGzipExtension(path.Join(prefix, snapshotFilesDir, file.snapshotPath))
			entries = append(entries, providers.PlannedUpload{LocalPath: file.sourcePath, Key: claims.assign(prefix, file.snapshotPath, naturalKey)})
		}
		planner.PrepareUploads(entries)
	}

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
		// The run stopped early, so the files never even ATTEMPTED are missing
		// from the manifest exactly like the ones that failed outright — count
		// them all, or the warning understates the hole by everything after the
		// abort point (500 intended, 100 stored, 5 errored would otherwise be
		// stamped "5 missing" rather than 400).
		recordIncompleteFilesOfTotal(snapshot, errs, failedSources, filesTotal)
		finalizeManifest()
		if _, pubErr := publishSnapshotManifest(ctx, provider, stagingDir, rec, snapshot); pubErr != nil {
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

	for i, file := range files {
		if err := ctx.Err(); err != nil {
			return abortStopped()
		}
		if file.kind != "" {
			// Content-less entry (symlink/directory): nothing to upload,
			// dedupe against, or checkpoint — see contentlessEntry's doc
			// comment. Rebuilt from the live filesystem on every run.
			e := contentlessEntry(file)
			e.SDIndex = sdTbl.index(file.sd)
			snapshot.Files = append(snapshot.Files, e)
			markDone(1, 0)
			emitProgress(false)
			continue
		}
		if entry, ok := resumedFiles[journalLookupKey(file)]; ok {
			// Already uploaded in a prior (interrupted) run with identical
			// (size, modTime) — filesDone/bytesDone already reflect this
			// file via the pre-loop seed above; do not double count.
			// The journaled SDIndex names a slot in the INTERRUPTED run's
			// table, which this run does not have: re-stamp it from this
			// run's capture.
			entry.SDIndex = sdTbl.index(file.sd)
			snapshot.Files = append(snapshot.Files, entry)
			snapshot.Size += entry.Size
			continue
		}
		decision, refEntry := plannedOrDecide(plannedDecisions, i, file, prevIndex)
		if decision == decideReference {
			// A referenced file carries THIS run's descriptor, like the
			// other current-stat fields referenceEntry documents.
			refEntry.SDIndex = sdTbl.index(file.sd)
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
		naturalKey := ensureGzipExtension(path.Join(prefix, snapshotFilesDir, file.snapshotPath))
		backupPath := keyClaims.assign(prefix, file.snapshotPath, naturalKey)
		if backupPath != naturalKey {
			log.Info("object key folds onto a case twin's; storing under a disambiguated key",
				"path", file.sourcePath,
				"naturalKey", naturalKey,
				"backupPath", backupPath,
				"snapshotId", snapshot.ID,
			)
		}

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

		// Log the file we are ABOUT to upload, at debug, before we block on it.
		// This is the line that makes a wedged backup diagnosable: the deadline
		// below scales with file size (capped at uploadTimeoutCeiling), so a
		// large file whose upload stalls mid-body can hold the loop for hours with no other
		// output. Without a start line the last thing in the log is the
		// previous file's success and there is no way to tell which file is
		// stuck (#2790, #2798).
		deadline := uploadDeadline(uploadFile.size)
		log.Debug("uploading file",
			"path", file.sourcePath,
			"backupPath", backupPath,
			"bytes", uploadFile.size,
			"deadlineMs", deadline.Milliseconds(),
			"snapshotId", snapshot.ID,
		)

		uploadStart := time.Now()
		uploadCtx := inFlight.track(ctx, file.size)
		uploaded, uploadErr := attemptFileUploadFenced(uploadCtx, provider, stagingDir, uploadFile, backupPath)
		if errors.Is(uploadErr, errWriterStillActive) {
			// Not this file's fault: the snapshot cannot be written at all.
			return nil, uploadErr
		}
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
				select {
				case <-ctx.Done():
					uploadErr = errBackupStopped
				case <-time.After(retryDelay):
					uploaded, uploadErr = attemptFileUploadFenced(uploadCtx, provider, stagingDir, uploadFile, backupPath)
					if errors.Is(uploadErr, errWriterStillActive) {
						return nil, uploadErr
					}
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
			failedSources = append(failedSources, file.sourcePath)
			// This is skip-and-continue: the file is dropped from the backup
			// but the job carries on. Warn so it is visible without debug
			// shipping, and count it so the summary at the end is trustworthy.
			log.Warn("file upload failed, skipping file",
				"path", file.sourcePath,
				"bytes", uploadFile.size,
				"elapsedMs", time.Since(uploadStart).Milliseconds(),
				"failedSoFar", len(errs),
				"error", uploadErr.Error(),
			)
			continue
		}
		uploadMs := time.Since(uploadStart).Milliseconds()

		// The manifest's Size/Checksum describe the bytes the upload stored
		// (the digest uploadWithDigest returned for the attempt that
		// succeeded), never a separate read of a source that may have moved
		// on. Volatile only says the source did not hold still while it was
		// read (see reconcileAfterUpload). ModTime is deliberately NOT
		// touched here — it stays file.modTime (the walk-time value) in
		// every case; see the comment above the pre-measurement for why.
		stored := uploaded
		volatile := false
		if haveMeasurement {
			reconciled, isVolatile, reconcileErr := reconcileAfterUpload(uploadCtx, provider, stagingDir, file.sourcePath, backupPath, pre, uploaded)
			if errors.Is(reconcileErr, errBackupStopped) {
				return abortStopped()
			}
			if reconcileErr != nil {
				// The re-upload of a changing file failed: what the key now
				// holds is not known for certain, so the file is not in this
				// snapshot.
				errs = append(errs, fmt.Errorf("failed to upload %s: %w", file.sourcePath, reconcileErr))
				failedSources = append(failedSources, file.sourcePath)
				log.Warn("re-upload of a file that changed during its upload failed, skipping file",
					"path", file.sourcePath,
					"error", reconcileErr.Error(),
				)
				continue
			}
			stored = reconciled
			volatile = isVolatile
			if volatile {
				volatileCount++
				log.Warn("file was modified while being backed up, recorded as volatile",
					"path", file.sourcePath,
					"bytes", stored.Size,
					"snapshotId", snapshot.ID,
				)
			}
		}
		log.Debug("file uploaded",
			"path", file.sourcePath,
			"bytes", stored.Size,
			"uploadMs", uploadMs,
			"volatile", volatile,
			"snapshotId", snapshot.ID,
		)
		finalSize := stored.Size
		finalChecksum := stored.SHA256

		entry := SnapshotFile{
			SourcePath:   file.sourcePath,
			OriginalPath: file.originalPath,
			BackupPath:   backupPath,
			Size:         finalSize,
			ModTime:      file.modTime,
			Checksum:     finalChecksum,
			Mode:         uint32(file.mode.Perm()),
			ModeBits:     file.modeBits,
			Owner:        file.owner,
			Volatile:     volatile,
			WinAttrs:     file.winAttrs,
			SDIndex:      sdTbl.index(file.sd),
		}
		snapshot.Files = append(snapshot.Files, entry)
		snapshot.Size += entry.Size
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

	finalizeManifest()

	if len(snapshot.Files) == 0 {
		return nil, errors.Join(errs...)
	}
	// Partial success: some files uploaded, some failed. Carry the per-file
	// failures on the snapshot (in-memory only, see UploadFailures) so the
	// manager can surface them as a job Warning/ErrorCount instead of
	// silently dropping them here (they used to be returned only when ZERO
	// files uploaded).
	snapshot.UploadFailures = errs
	recordIncompleteFiles(snapshot, errs, failedSources)
	snapshot.VolatileFiles = volatileCount

	if err := ctx.Err(); err != nil {
		return abortStopped()
	}

	// A resumed snapshot id may already hold a layout or system-state
	// manifest from an earlier attempt. The manifest published below would
	// sit beside it unattested, so clear every control key this run is not
	// about to publish itself; if that is not possible, attest nothing.
	if journal != nil && journal.resumed {
		publishing := map[string]bool{
			AttestationRoleLayout:              options.layoutManifest != nil,
			AttestationRoleSystemStateManifest: options.systemStateManifest != nil && len(options.systemStateManifest.Artifacts) > 0,
		}
		for _, role := range []string{AttestationRoleLayout, AttestationRoleSystemStateManifest} {
			if publishing[role] {
				continue
			}
			key, _ := ControlObjectKey(snapshot.ID, role)
			if err := provider.Delete(key); err != nil && !errors.Is(err, providers.ErrObjectNotFound) {
				log.Warn("could not clear a control object left by an earlier attempt", "key", key, "error", err.Error())
				snapshot.attestationWithheld = "a control object from an earlier attempt could not be cleared: " + key
			}
		}
	}

	// System state (if any was collected for this run — see withSystemState)
	// publishes BEFORE the ordinary manifest below: see withSystemState's doc
	// comment for why the order matters to a concurrent GC sweep.
	if options.systemStateManifest != nil && len(options.systemStateManifest.Artifacts) > 0 {
		if _, err := publishSystemState(ctx, provider, stagingDir, rec, snapshot.ID, options.systemStateStagingDir, options.systemStateManifest); err != nil {
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
		if _, err := publishLayoutManifest(ctx, provider, stagingDir, rec, snapshot.ID, options.layoutManifest); err != nil {
			if errors.Is(err, errBackupStopped) {
				return abortStopped()
			}
			return snapshot, fmt.Errorf("layout manifest publish failed: %w", err)
		}
	}

	if _, err := publishSnapshotManifest(ctx, provider, stagingDir, rec, snapshot); err != nil {
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
	snapshot, _, err := fetchPublishedManifestWithDigest(ctx, provider, prefix)
	return snapshot, err
}

// fetchPublishedManifestWithDigest is fetchPublishedManifest that also
// returns the SHA-256 and length of the manifest bytes it read.
func fetchPublishedManifestWithDigest(ctx context.Context, provider providers.BackupProvider, prefix string) (*Snapshot, providers.UploadDigest, error) {
	if ctx != nil {
		if err := ctx.Err(); err != nil {
			return nil, providers.UploadDigest{}, err
		}
	}
	manifestKey := path.Join(prefix, snapshotManifestKey)
	tempFile, err := os.CreateTemp("", "resume-manifest-*.json")
	if err != nil {
		return nil, providers.UploadDigest{}, fmt.Errorf("failed to create temp file for resume manifest check: %w", err)
	}
	tempPath := tempFile.Name()
	_ = tempFile.Close()
	// Best-effort: tempPath is an OS temp file already read (or about to
	// fail trying) — a leftover on Remove failure is harmless temp-dir
	// clutter, not a correctness issue worth surfacing.
	defer func() { _ = os.Remove(tempPath) }()

	if err := provider.Download(manifestKey, tempPath); err != nil {
		if errors.Is(err, providers.ErrObjectNotFound) {
			return nil, providers.UploadDigest{}, nil
		}
		return nil, providers.UploadDigest{}, fmt.Errorf("failed to check for an already-published manifest at %s: %w", manifestKey, err)
	}
	data, err := os.ReadFile(tempPath)
	if err != nil {
		return nil, providers.UploadDigest{}, fmt.Errorf("failed to read downloaded resume manifest: %w", err)
	}
	var snapshot Snapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, providers.UploadDigest{}, fmt.Errorf("failed to decode resume manifest %s: %w", manifestKey, err)
	}
	return &snapshot, digestBytes(data), nil
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
func publishSnapshotManifest(ctx context.Context, provider providers.BackupProvider, stagingDir string, rec *controlRecorder, snapshot *Snapshot) (PublishedObject, error) {
	manifestPath, manifestErr := writeSnapshotManifest(snapshot)
	if manifestErr != nil {
		return PublishedObject{}, manifestErr
	}
	defer os.Remove(manifestPath)

	obj, err := publishControlObject(ctx, provider, stagingDir, rec, AttestationRoleManifest, snapshot.ID, manifestPath)
	if err != nil {
		if errors.Is(err, errBackupStopped) {
			return PublishedObject{}, err
		}
		return PublishedObject{}, fmt.Errorf("failed to upload snapshot manifest: %w", err)
	}
	return obj, nil
}

// publishLayoutManifest uploads manifest as snapshots/<snapshotID>/layout.json.
func publishLayoutManifest(ctx context.Context, provider providers.BackupProvider, stagingDir string, rec *controlRecorder, snapshotID string, manifest *layout.Manifest) (PublishedObject, error) {
	data, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return PublishedObject{}, fmt.Errorf("encode layout manifest: %w", err)
	}
	tmp, err := os.CreateTemp("", "breeze-layout-*.json")
	if err != nil {
		return PublishedObject{}, fmt.Errorf("stage layout manifest: %w", err)
	}
	tmpPath := tmp.Name()
	defer func() { _ = os.Remove(tmpPath) }()
	if _, err := tmp.Write(data); err != nil {
		// Best-effort: we are already returning the write error, a Close
		// failure on this already-broken fd has nothing new to add.
		_ = tmp.Close()
		return PublishedObject{}, fmt.Errorf("stage layout manifest: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return PublishedObject{}, fmt.Errorf("stage layout manifest: %w", err)
	}
	obj, err := publishControlObject(ctx, provider, stagingDir, rec, AttestationRoleLayout, snapshotID, tmpPath)
	if err != nil {
		if errors.Is(err, errBackupStopped) {
			return PublishedObject{}, err
		}
		return PublishedObject{}, fmt.Errorf("upload %s: %w", path.Join(snapshotRootDir, snapshotID, layoutManifestKey), err)
	}
	return obj, nil
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
func publishSystemState(ctx context.Context, provider providers.BackupProvider, uploadStagingDir string, rec *controlRecorder, snapshotID, stagingDir string, manifest *systemstate.SystemStateManifest) (PublishedObject, error) {
	if manifest == nil {
		return PublishedObject{}, nil
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
			return PublishedObject{}, fmt.Errorf("stat system state artifact %s: %w", art.Path, statErr)
		}
		if info.Size() != art.SizeBytes {
			return PublishedObject{}, fmt.Errorf("system state artifact %s changed size since collection (expected %d bytes, found %d)",
				art.Path, art.SizeBytes, info.Size())
		}

		remoteKey := path.Join(prefix, art.Path)
		d, uploadErr := uploadWithDeadline(ctx, provider, uploadStagingDir, localPath, remoteKey, info.Size())
		if uploadErr != nil {
			if errors.Is(uploadErr, errBackupStopped) {
				return PublishedObject{}, uploadErr
			}
			return PublishedObject{}, fmt.Errorf("upload system state artifact %s: %w", art.Path, uploadErr)
		}
		// The system-state manifest (an attested control object) lists
		// every artifact's checksum, so the uploaded bytes must be the ones
		// the collector hashed.
		if d.Size != art.SizeBytes || (art.Checksum != "" && d.SHA256 != art.Checksum) {
			return PublishedObject{}, fmt.Errorf("system state artifact %s changed since collection (uploaded bytes do not match the recorded checksum)", art.Path)
		}
		if art.Checksum == "" {
			art.Checksum = d.SHA256
		}
	}

	manifestPath, manifestErr := writeSystemStateManifest(manifest)
	if manifestErr != nil {
		return PublishedObject{}, manifestErr
	}
	// Best-effort: manifestPath is a local OS temp file, already uploaded (or
	// about to fail trying) — a leftover on Remove failure is harmless OS
	// temp-dir clutter, not a correctness issue worth failing the publish
	// over. Matches the sibling cleanup in publishSnapshotManifest above.
	defer func() { _ = os.Remove(manifestPath) }()

	obj, err := publishControlObject(ctx, provider, uploadStagingDir, rec, AttestationRoleSystemStateManifest, snapshotID, manifestPath)
	if err != nil {
		if errors.Is(err, errBackupStopped) {
			return PublishedObject{}, err
		}
		return PublishedObject{}, fmt.Errorf("failed to upload system state manifest: %w", err)
	}
	return obj, nil
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
// uploadWithDeadline), and returns the digest of the bytes the attempt stored
// (see uploadWithDigest).
func attemptFileUpload(ctx context.Context, provider providers.BackupProvider, stagingDir string, file backupFile, backupPath string) (providers.UploadDigest, error) {
	return uploadWithDeadline(ctx, provider, stagingDir, file.sourcePath, backupPath, file.size)
}

// errWriterStillActive ends a brokered run: an earlier writer of the
// snapshot could not be fenced within the wait bound.
var errWriterStillActive = errors.New("an earlier writer of this snapshot is still active")

// maxWriterFenceWaits bounds the run-level waits for one file.
const maxWriterFenceWaits = 3

// attemptFileUploadFenced is attemptFileUpload for a run whose writer may be
// told an earlier writer of the snapshot is still active. That is not the
// file's failure: the wait for the fence runs here, on ctx — outside the
// file's own deadline, which covers each attempt only — and the file is sent
// again. A fence that does not clear ends the run (errWriterStillActive).
func attemptFileUploadFenced(ctx context.Context, provider providers.BackupProvider, stagingDir string, file backupFile, backupPath string) (providers.UploadDigest, error) {
	for waits := 0; ; waits++ {
		d, err := attemptFileUpload(ctx, provider, stagingDir, file, backupPath)
		if err == nil || !errors.Is(err, providers.ErrPreviousWriterActive) {
			return d, err
		}
		fence, ok := writerFenceOf(provider)
		if !ok || waits >= maxWriterFenceWaits {
			return d, fmt.Errorf("%w: %w", errWriterStillActive, err)
		}
		log.Info("an earlier writer of this snapshot is still active; waiting before sending the file again", "path", file.sourcePath)
		if werr := fence.AwaitWriteAccess(ctx); werr != nil {
			if ctx.Err() != nil {
				return d, errBackupStopped
			}
			return d, fmt.Errorf("%w: %w", errWriterStillActive, werr)
		}
	}
}

// uploadWithDeadline uploads localPath to remotePath under a per-attempt
// context bounded by uploadDeadline(size) and returns the digest of the bytes
// the stored object holds (see uploadWithDigest). It is the ONLY way a
// snapshot upload gets a deadline: files, the snapshot manifest, the layout
// manifest, the system-state artifacts and every other control object all go
// through it (#7105).
//
// uploadWithDigest maps any context error to errBackupStopped, so without the
// conversion here a deadline expiry is indistinguishable from a user cancel —
// the publish-time uploads used to return it as-is and the run was reported as
// stopped, with nothing logged. A deadline expiry that is not also a job-context
// cancel is therefore logged at warn and converted to a plain "upload stalled"
// error; a real job cancel still returns errBackupStopped unwrapped, so callers
// keep aborting on it.
//
// The warn is not rate-limited: it fires at most once per attempt, and every
// caller makes at most two attempts per file (the main loop's single retry;
// publish-time uploads never retry), so it cannot repeat for a file. The
// main loop's per-file skip warn has the same one-per-file bound.
func uploadWithDeadline(ctx context.Context, provider providers.BackupProvider, stagingDir, localPath, remotePath string, size int64) (providers.UploadDigest, error) {
	deadline := uploadDeadline(size)
	attemptCtx, cancelAttempt := context.WithTimeout(ctx, deadline)
	defer cancelAttempt()
	d, uploadErr := uploadWithDigest(attemptCtx, provider, stagingDir, localPath, remotePath)
	if errors.Is(uploadErr, errBackupStopped) && ctx.Err() == nil {
		// The per-file deadline fired, not a job cancel. Log it distinctly:
		// a deadline expiry means we sat on one file for the whole size-
		// scaled window with the destination accepting the request and never
		// finishing it. That is a different failure from an outright upload
		// error and it is the signature of the stall in #2798.
		log.Warn("file upload deadline expired",
			"path", localPath,
			"remotePath", remotePath,
			"bytes", size,
			"deadlineMs", deadline.Milliseconds(),
			"deadlineCapped", deadline == uploadTimeoutCeiling,
		)
		uploadErr = fmt.Errorf("upload stalled: no completion within %s", deadline)
	}
	return d, uploadErr
}

// filePreUploadMeasurement is a stat of a source file taken immediately
// before it is handed to an upload attempt. It is compared with a stat taken
// right after the upload to tell whether the source held still while it was
// read (see reconcileAfterUpload, #5581). The manifest's Size/Checksum never
// come from it: they are the digest of the uploaded bytes.
type filePreUploadMeasurement struct {
	size    int64
	modTime time.Time
}

// statBeforeUpload is the pre-upload measurement. A variable so tests can
// make it fail while the upload itself succeeds.
var statBeforeUpload = func(sourcePath string) (filePreUploadMeasurement, error) {
	info, err := os.Stat(sourcePath)
	if err != nil {
		return filePreUploadMeasurement{}, err
	}
	return filePreUploadMeasurement{size: info.Size(), modTime: info.ModTime()}, nil
}

// reconcileAfterUpload re-stats sourcePath immediately after a successful
// upload (whose stored bytes first describes) and compares it against pre,
// the stat taken right before that upload began. If the source is unchanged,
// first is returned as-is: no warning, no extra work, the common case.
//
// If the source drifted (grew, shrank, or was otherwise modified) during the
// upload window, the file is re-uploaded ONCE so the stored object has a
// chance to catch up with a fast-moving but eventually-still file. If it
// drifts again even across that retry, chasing it further would only delay
// the run against a file that is not going to hold still (a live log, the
// agent's own checkpoint journal) — the entry is recorded as volatile
// (volatile=true). Either way the returned digest describes the object
// backupPath holds: the retry's upload when it succeeded, else the first.
//
// Returns errBackupStopped when ctx is cancelled during the retry — the
// caller aborts the run exactly as it does for any other errBackupStopped;
// no other error is returned (a retry upload failure or a vanished source is
// folded into volatile=true rather than failing the file, since the object
// already stored at backupPath from the FIRST, successful upload remains a
// valid — if volatile — restore point; a failed upload never replaces a
// stored object).
func reconcileAfterUpload(ctx context.Context, provider providers.BackupProvider, stagingDir, sourcePath, backupPath string, pre filePreUploadMeasurement, first providers.UploadDigest) (stored providers.UploadDigest, volatile bool, err error) {
	post, statErr := os.Stat(sourcePath)
	if statErr == nil && post.Size() == pre.size && post.ModTime().Equal(pre.modTime) {
		return first, false, nil
	}

	pre2, pre2Err := statBeforeUpload(sourcePath)
	if pre2Err != nil {
		// Can no longer read the source at all (e.g. deleted moments after
		// the first upload completed). What's already stored at backupPath
		// is the first upload — keep describing that, flagged volatile.
		return first, true, nil
	}
	reuploadFile := backupFile{sourcePath: sourcePath, size: pre2.size}
	second, uploadErr := attemptFileUploadFenced(ctx, provider, stagingDir, reuploadFile, backupPath)
	if uploadErr != nil {
		if errors.Is(uploadErr, errBackupStopped) {
			return first, true, errBackupStopped
		}
		// The failed attempt may have replaced part or all of the first
		// upload's object (a staged-copy fallback after an unverifiable
		// upload), so the first digest can no longer be vouched for.
		return providers.UploadDigest{}, true, fmt.Errorf("re-upload after the source changed: %w", uploadErr)
	}

	post2, statErr2 := os.Stat(sourcePath)
	if statErr2 == nil && post2.Size() == pre2.size && post2.ModTime().Equal(pre2.modTime) {
		return second, false, nil
	}
	return second, true, nil
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

// ensureGzipExtension derives the stored object key for an uploaded file.
// The ".gz" suffix is a key-namespace convention, NOT a promise that the
// stored bytes are gzip: the cloud providers (S3/B2/Azure/GCS, legacy and
// brokered write paths alike) store the original bytes verbatim under the
// ".gz" key, and only LocalProvider gzips on it (and gunzips on Download).
// That layout is a cross-module contract — the BMR recovery client, API
// presigned downloads, older agents and the stored-digest checks
// (storedEntryMatches) all read cloud objects as raw bytes — so never add
// or strip ".gz", and never start compressing cloud writes, without a
// versioned per-entry encoding field shipped to every reader first (#7621).
//
// It ALWAYS appends ".gz", even when p
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

// journalIdentity is the checkpoint journal's identity (and so its file name):
// backupIdentity plus the provider's journal scope, when it has one.
func journalIdentity(provider providers.BackupProvider, paths []string) string {
	id := backupIdentity(provider, paths)
	if s, ok := unwrapProvider(provider).(providers.JournalScoper); ok {
		if scope := s.JournalScope(); scope != "" {
			id += "|" + scope
		}
	}
	return id
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

// maxManifestIncompletePaths caps how many failed source paths are written to
// Snapshot.IncompleteFilePaths. The count (IncompleteFiles) is always exact;
// only the names are truncated, because a run can fail thousands of files and
// the manifest is downloaded whole on every verify and every restore.
const maxManifestIncompletePaths = 100

// recordIncompleteFiles stamps the run's upload failures onto the manifest so a
// later reader can tell an incomplete restore point from a complete one
// (#6350). failedSources may be shorter than failures (a failure recorded
// without a known source path); the COUNT always comes from failures, so a
// missing path never under-reports incompleteness.
func recordIncompleteFiles(snapshot *Snapshot, failures []error, failedSources []string) {
	if snapshot == nil {
		return
	}
	recordIncompleteFilesOfTotal(snapshot, failures, failedSources, len(snapshot.Files)+len(failures))
}

// recordIncompleteFilesOfTotal is recordIncompleteFiles for a run that stopped
// before attempting every file. filesTotal is how many files the run INTENDED
// to store; anything the manifest does not list is missing from the restore
// point whether it failed outright or was never reached, so the count is the
// larger of the explicit failures and (filesTotal - stored). Only the failures
// have known paths, so IncompleteFilePaths can name fewer files than the
// count — the count, not the list, is the authority on how much is missing.
func recordIncompleteFilesOfTotal(snapshot *Snapshot, failures []error, failedSources []string, filesTotal int) {
	if snapshot == nil {
		return
	}
	incomplete := len(failures)
	if unattempted := filesTotal - len(snapshot.Files); unattempted > incomplete {
		incomplete = unattempted
	}
	if incomplete <= 0 {
		return
	}
	snapshot.IncompleteFiles = incomplete
	if len(failedSources) > maxManifestIncompletePaths {
		failedSources = failedSources[:maxManifestIncompletePaths]
	}
	if len(failedSources) > 0 {
		snapshot.IncompleteFilePaths = append([]string(nil), failedSources...)
	}
}
