package backup

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

// journalMaxAge is how long a checkpoint journal is trusted for resume
// before it's considered stale (see openSnapshotJournal). A journal older
// than this most likely belongs to a run whose remote partial upload has
// already drifted too far from the current source tree to safely resume —
// treat it as abandoned instead.
//
// Server-side cross-reference: the API's mark-and-sweep GC
// (BACKUP_GC_MANIFESTLESS_PREFIX_MAX_AGE_MS in
// apps/api/src/jobs/backupRetention.ts) protects a manifest-less (no
// manifest.json yet) snapshot prefix from deletion until it's older than
// journalMaxAge PLUS a 48h resume-headroom margin (9 days total), because a
// fresher partial prefix may still be this journal's live resume target.
// The GC threshold MUST stay STRICTLY LARGER than journalMaxAge, not merely
// equal — equality left a boundary race where a resume opened just inside
// the journal window (e.g. day 6.9) legitimately keeps running past day 7,
// and GC could sweep its still-live prefix out from under it. If this value
// changes, the API constant must change with it (and vice versa), preserving
// that strict inequality.
var journalMaxAge = 7 * 24 * time.Hour

// setJournalMaxAgeForTest overrides journalMaxAge so tests can exercise the
// staleness path without waiting 7 real days. Call the returned restore func
// (typically via defer) to put the real value back.
func setJournalMaxAgeForTest(d time.Duration) (restore func()) {
	old := journalMaxAge
	journalMaxAge = d
	return func() { journalMaxAge = old }
}

// journalHeader is the journal file's first line. It identifies which
// snapshot run the journal's entries belong to and when the run started, so
// a journal older than journalMaxAge can be recognized and discarded rather
// than resumed indefinitely.
type journalHeader struct {
	SnapshotID string    `json:"snapshotId"`
	CreatedAt  time.Time `json:"createdAt"`
	Identity   string    `json:"identity"`

	// FormatVersion is journalFormatVersion for a journal written by this
	// build; absent (0) on a journal written before it existed. Entries in
	// an older journal may carry a checksum measured before the upload, or
	// none, so they are never resumed (see openSnapshotJournal).
	FormatVersion int `json:"formatVersion,omitempty"`
	// JobID is the dispatched backup job currently writing this snapshot.
	// A later job resuming the upload rebinds it (see BindRun).
	JobID string `json:"jobId,omitempty"`
	// DispatchedBaseSnapshotID is the base the server pinned for JobID (""
	// = a full dispatch); ParentSnapshotID the base the run actually used
	// ("" = full), meaningful once BaseDecided is set.
	DispatchedBaseSnapshotID string `json:"dispatchedBaseSnapshotId,omitempty"`
	BaseDecided              bool   `json:"baseDecided,omitempty"`
	ParentSnapshotID         string `json:"parentSnapshotId,omitempty"`
	// PublishedObjects are the control objects JobID's run published, or was
	// about to publish, under SnapshotID: each is recorded before its upload
	// starts, with the digest of the bytes being uploaded.
	PublishedObjects []PublishedObject `json:"publishedObjects,omitempty"`
	// VerifyStoredEntries is set once a later job continued this snapshot
	// (a brokered write the control plane let it take over, see
	// ContinueRun). From then on an entry is reused only when the stored
	// object still holds the recorded bytes, not only the source.
	VerifyStoredEntries bool `json:"verifyStoredEntries,omitempty"`
}

// journalFormatVersion is the journal format this build writes: entries carry
// the digest of the uploaded bytes, and the header carries the run bindings
// and published control objects.
const journalFormatVersion = 2

// snapshotJournal is an append-only checkpoint log for one backup
// destination (see backupIdentity), recording every file successfully
// uploaded so an interrupted or stopped run can resume instead of
// restarting from scratch.
//
// A journal is a best-effort checkpoint, never a correctness requirement:
// every method degrades gracefully (nil-safe, logs and swallows write
// errors) rather than failing the backup it's checkpointing. It is NOT safe
// for concurrent use — createSnapshotWithProgress calls it serially from the
// single-goroutine upload loop.
type snapshotJournal struct {
	file       *os.File
	writer     *bufio.Writer
	path       string
	snapshotID string
	identity   string

	// entries holds the resumed state loaded at open time: sourcePath -> the
	// last recorded SnapshotFile for it (last-entry-wins, matching how a
	// re-uploaded/changed file's new entry supersedes the old one when the
	// journal is replayed). Record keeps this in sync as the run progresses,
	// though callers should read ResumedBytes before any Record call — see
	// its doc comment.
	entries map[string]SnapshotFile

	// resumedBytesTotal is a fixed snapshot of the resumed entries' total
	// size, computed once at open time (before any new Record calls can
	// mutate entries), so ResumedBytes always reports the original resume
	// point regardless of how far the current run has since progressed.
	resumedBytesTotal int64

	// resumed is true only when an existing, valid, non-stale journal for
	// this identity was found and loaded.
	resumed bool

	// staleSnapshotID is set when Open discarded a stale (>journalMaxAge)
	// journal, so the caller can best-effort clean up that snapshot's
	// abandoned remote prefix. Empty when Open found no stale journal.
	staleSnapshotID string

	// header is the journal's current header line (see rewriteHeader).
	header journalHeader

	// discardedOldFormat is set when Open discarded a journal written in an
	// older format, so the run can say why it did not resume.
	discardedOldFormat bool

	// discardedOtherRun names what differed ("job", "dispatched base" or
	// "destination") when a journal written for another run was discarded.
	discardedOtherRun string

	// continuedFromOtherJob is set when this run continued a snapshot an
	// earlier job was writing (see ContinueRun): that job's published
	// control objects are rebuilt, never adopted.
	continuedFromOtherJob bool

	// createdAt is the journal's original creation time (from its header,
	// preserved verbatim across a resume — NOT reset on resume). Age()
	// reports time.Since(createdAt), used at publish time to fence a
	// resumed run against journalMaxAge (see leaseGate in snapshot.go).
	createdAt time.Time
}

// journalFileName returns the deterministic filename for a destination
// identity: backup-journal-<sha256(identity) hex, truncated to 16 chars>.jsonl.
// Hashing keeps the filename short and filesystem-safe regardless of what
// the identity string contains (paths, separators, ...).
func journalFileName(identity string) string {
	sum := sha256.Sum256([]byte(identity))
	return "backup-journal-" + hex.EncodeToString(sum[:])[:16] + ".jsonl"
}

// identityFingerprint returns a short, non-reversible fingerprint of a
// destination identity, safe to log. The raw identity embeds provider
// credentials (e.g. an S3 secret key), so it must never be logged directly.
func identityFingerprint(identity string) string {
	sum := sha256.Sum256([]byte(identity))
	return hex.EncodeToString(sum[:])[:16]
}

// openSnapshotJournal opens (or creates) the checkpoint journal for the
// given destination identity in dir. dir is required (there is deliberately
// NO os.TempDir() fallback — see resolveJournalDir: a deterministic
// root-owned filename in a world-writable dir is a symlink/tamper surface)
// and is created 0700 if missing. It returns (journal, true, nil) when an
// existing, valid, non-stale (createdAt within maxAge) journal was found and
// loaded — the journal's snapshotID and entries are those of the
// interrupted run.
//
// Otherwise it returns a fresh journal (new snapshot ID, no entries,
// resumed=false), covering three cases: no journal file yet (normal first
// run), a corrupt journal (any parse error — the whole file is discarded,
// never partially trusted), and a stale journal (identity matches but too
// old to safely resume — see StaleSnapshotID).
//
// openSnapshotJournal only returns a non-nil error when it cannot create
// even a *fresh* journal file (e.g. an unwritable/full dir). Callers must
// treat that as "proceed without a journal" — log and degrade to a
// journal-less run — never as a reason to fail the backup.
func openSnapshotJournal(dir, identity string, maxAge time.Duration) (*snapshotJournal, bool, error) {
	if dir == "" {
		return nil, false, errors.New("backup journal directory is required")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, false, fmt.Errorf("failed to create backup journal directory: %w", err)
	}
	path := filepath.Join(dir, journalFileName(identity))

	// Refuse to trust anything at the journal path that isn't a regular file
	// (symlink, directory, device node, ...). The helper runs as root/SYSTEM:
	// following a planted symlink would let an attacker feed us a forged
	// journal (triggering remote snapshot cleanup or silent file skips) or
	// make us write through the link. Delete it and start fresh; if it can't
	// be deleted, don't journal at all.
	if fi, lstatErr := os.Lstat(path); lstatErr == nil && !fi.Mode().IsRegular() {
		slog.Warn("backup journal path is not a regular file, discarding",
			"path", path, "mode", fi.Mode().String())
		if rmErr := os.Remove(path); rmErr != nil {
			return nil, false, fmt.Errorf("failed to remove non-regular backup journal path: %w", rmErr)
		}
	}

	header, entries, readErr := readJournal(path)
	if readErr == nil {
		identityMatches := header.Identity == identity
		if identityMatches && time.Since(header.CreatedAt) <= maxAge && header.FormatVersion < journalFormatVersion {
			// Written by an older helper: its entries may describe a
			// pre-upload measurement or carry no checksum at all, and it
			// holds no run bindings. Never resume it; its partial prefix is
			// left to the server's manifest-less-prefix cleanup.
			slog.Warn("discarding backup journal written in an older format",
				"path", path, "formatVersion", header.FormatVersion)
			if rmErr := os.Remove(path); rmErr != nil && !os.IsNotExist(rmErr) {
				slog.Warn("failed to remove old-format backup journal", "path", path, "error", rmErr.Error())
			}
			j, resumed, err := createFreshJournal(path, identity)
			if j != nil {
				j.discardedOldFormat = true
			}
			return j, resumed, err
		}
		if identityMatches && time.Since(header.CreatedAt) <= maxAge {
			f, openErr := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0o600)
			if openErr == nil {
				var resumedBytes int64
				for _, entry := range entries {
					resumedBytes += entry.Size
				}
				return &snapshotJournal{
					file:              f,
					writer:            bufio.NewWriter(f),
					path:              path,
					snapshotID:        header.SnapshotID,
					identity:          identity,
					entries:           entries,
					resumedBytesTotal: resumedBytes,
					resumed:           true,
					createdAt:         header.CreatedAt,
					header:            header,
				}, true, nil
			}
			slog.Warn("failed to reopen backup journal for append, starting fresh",
				"path", path, "error", openErr.Error())
		} else {
			// Either stale (identity matches, but the run is too old to
			// trust) or an identity mismatch (the file at this path — whose
			// name is itself derived from identity, so a mismatch should
			// only ever happen via a hash collision or file tampering —
			// claims a different identity than expected). Both get the same
			// treatment: never resume from it. Discard the local file; the
			// caller cleans up the remote prefix for the abandoned snapshot
			// ID (see StaleSnapshotID).
			if !identityMatches {
				slog.Warn("backup journal identity mismatch, discarding",
					"path", path, "want", identityFingerprint(identity), "got", identityFingerprint(header.Identity))
			}
			staleID := header.SnapshotID
			if rmErr := os.Remove(path); rmErr != nil && !os.IsNotExist(rmErr) {
				slog.Warn("failed to remove stale backup journal", "path", path, "error", rmErr.Error())
			}
			j, resumed, err := createFreshJournal(path, identity)
			if j != nil {
				j.staleSnapshotID = staleID
				if !identityMatches {
					j.discardedOtherRun = "destination"
				}
			}
			return j, resumed, err
		}
	} else if !os.IsNotExist(readErr) {
		// Any read/parse failure is treated as corruption — never partially
		// trust a damaged journal.
		slog.Warn("discarding corrupt backup journal", "path", path, "error", readErr.Error())
		if rmErr := os.Remove(path); rmErr != nil && !os.IsNotExist(rmErr) {
			slog.Warn("failed to remove corrupt backup journal", "path", path, "error", rmErr.Error())
		}
	}

	return createFreshJournal(path, identity)
}

// readJournal reads and validates an existing journal file at path,
// returning its header and the resumed entries (last-entry-wins across
// repeated sourcePaths). Any malformed line — header or data — is reported
// as an error so the caller discards the whole file rather than resuming
// from a partially-trusted state.
func readJournal(path string) (journalHeader, map[string]SnapshotFile, error) {
	var header journalHeader
	f, err := os.Open(path)
	if err != nil {
		return header, nil, err
	}
	defer func() { _ = f.Close() }()

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	if !scanner.Scan() {
		if scanErr := scanner.Err(); scanErr != nil {
			return header, nil, scanErr
		}
		return header, nil, fmt.Errorf("backup journal %s is empty", path)
	}
	if err := json.Unmarshal(scanner.Bytes(), &header); err != nil {
		return header, nil, fmt.Errorf("backup journal header: %w", err)
	}
	if header.SnapshotID == "" {
		return header, nil, fmt.Errorf("backup journal header missing snapshotId")
	}

	entries := make(map[string]SnapshotFile)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		if bytes.HasPrefix(line, journalHeaderUpdatePrefix) {
			var update journalHeaderUpdate
			if err := json.Unmarshal(line, &update); err != nil {
				return header, nil, fmt.Errorf("backup journal header update: %w", err)
			}
			applyHeaderUpdate(&header, update.HeaderUpdate)
			continue
		}
		var entry SnapshotFile
		if err := json.Unmarshal(line, &entry); err != nil {
			return header, nil, fmt.Errorf("backup journal entry: %w", err)
		}
		// Keyed by journalEntryKey (OriginalPath when VSS rewrote SourcePath,
		// else SourcePath itself), matching Record's keying below — a reload
		// must key entries the same way a live run does, or a resumed
		// journal's entries become unreachable by Lookup. last-entry-wins.
		entries[journalEntryKey(entry)] = entry
	}
	if err := scanner.Err(); err != nil {
		return header, nil, err
	}

	return header, entries, nil
}

// createFreshJournal creates a brand new journal file at path (truncating
// any existing content — callers have already decided the old content
// isn't usable) with a fresh snapshot ID and writes its header line.
func createFreshJournal(path, identity string) (*snapshotJournal, bool, error) {
	return createFreshJournalWithID(path, identity, "")
}

// createFreshJournalWithID is createFreshJournal naming the snapshot the
// journal checkpoints; "" mints a fresh id (a brokered write passes the id
// the control plane issued).
func createFreshJournalWithID(path, identity, snapshotID string) (*snapshotJournal, bool, error) {
	if snapshotID == "" {
		snapshotID = newSnapshotID()
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, false, fmt.Errorf("failed to create backup journal: %w", err)
	}

	header := journalHeader{
		SnapshotID:    snapshotID,
		CreatedAt:     time.Now().UTC(),
		Identity:      identity,
		FormatVersion: journalFormatVersion,
	}
	headerLine, err := json.Marshal(header)
	if err != nil {
		_ = f.Close()
		return nil, false, fmt.Errorf("failed to encode backup journal header: %w", err)
	}
	if _, err := f.Write(append(headerLine, '\n')); err != nil {
		_ = f.Close()
		return nil, false, fmt.Errorf("failed to write backup journal header: %w", err)
	}

	return &snapshotJournal{
		file:       f,
		writer:     bufio.NewWriter(f),
		path:       path,
		snapshotID: header.SnapshotID,
		identity:   identity,
		createdAt:  header.CreatedAt,
		header:     header,
	}, false, nil
}

// DiscardedOldFormat reports whether Open discarded a journal written in an
// older format (see journalFormatVersion) instead of resuming it.
func (j *snapshotJournal) DiscardedOldFormat() bool {
	return j != nil && j.discardedOldFormat
}

// Header returns a copy of the journal's current header.
func (j *snapshotJournal) Header() journalHeader {
	if j == nil {
		return journalHeader{}
	}
	h := j.header
	h.PublishedObjects = append([]PublishedObject(nil), j.header.PublishedObjects...)
	return h
}

// DiscardedOtherRun returns what differed when a journal written for another
// run was discarded instead of resumed, or "".
func (j *snapshotJournal) DiscardedOtherRun() string {
	if j == nil {
		return ""
	}
	return j.discardedOtherRun
}

// BindRun binds the journal to the dispatched job and base of this run.
// Resume is per job: a journal written for a different job or dispatched
// base is discarded and a fresh one (new snapshot id, no entries) takes its
// place, so every entry a run inherits was produced under the same job and
// base decision as the snapshot it completes. (A journal for a different
// destination is already discarded when it is opened.) Call it right after
// opening, before the journal's state is used. Only a brokered write can
// carry an unfinished snapshot across jobs, and only when the control plane
// allows it (bindBrokeredJournal, ContinueRun); every other destination
// restarts from zero on a new job.
func (j *snapshotJournal) BindRun(jobID, dispatchedBaseSnapshotID string) error {
	if j == nil {
		return nil
	}
	if j.resumed {
		reason := ""
		switch {
		case j.header.JobID != jobID:
			reason = "job"
		case j.header.DispatchedBaseSnapshotID != dispatchedBaseSnapshotID:
			reason = "dispatched base"
		}
		if reason == "" {
			return nil
		}
		slog.Warn("discarding a checkpoint journal written for another run",
			"snapshotId", j.snapshotID, "differs", reason)
		if err := j.restartFresh(); err != nil {
			return err
		}
		j.discardedOtherRun = reason
	}
	j.header.JobID = jobID
	j.header.DispatchedBaseSnapshotID = dispatchedBaseSnapshotID
	return j.rewriteHeader()
}

// restartFresh replaces the journal's content with a fresh journal (new
// snapshot id, no entries) at the same path. The discarded snapshot's partial
// prefix is left to the server's manifest-less-prefix cleanup.
func (j *snapshotJournal) restartFresh() error {
	return j.restartFreshWithID("")
}

// restartFreshWithID is restartFresh under a given snapshot id ("" mints
// one).
func (j *snapshotJournal) restartFreshWithID(snapshotID string) error {
	if j.file != nil {
		_ = j.file.Close()
		j.file = nil
	}
	fresh, _, err := createFreshJournalWithID(j.path, j.identity, snapshotID)
	if err != nil {
		return err
	}
	j.file = fresh.file
	j.writer = fresh.writer
	j.snapshotID = fresh.snapshotID
	j.header = fresh.header
	j.createdAt = fresh.createdAt
	j.entries = nil
	j.resumedBytesTotal = 0
	j.resumed = false
	j.continuedFromOtherJob = false
	return nil
}

// ContinueRun binds a resumed journal to this run's job WITHOUT discarding
// its entries: the control plane let this job take over the unpublished
// snapshot an earlier job of the same dispatched base was writing (a
// brokered write). The earlier job's entries are then reused only after the
// stored objects are checked (VerifyStoredEntries), and its control objects
// are rebuilt rather than adopted.
func (j *snapshotJournal) ContinueRun(jobID, dispatchedBaseSnapshotID string) error {
	if j == nil {
		return nil
	}
	if j.header.JobID != jobID {
		j.continuedFromOtherJob = true
		j.header.VerifyStoredEntries = true
	}
	j.header.JobID = jobID
	j.header.DispatchedBaseSnapshotID = dispatchedBaseSnapshotID
	return j.rewriteHeader()
}

// VerifyStoredEntries reports whether a resumed entry must also match the
// stored object before it is reused (see ContinueRun).
func (j *snapshotJournal) VerifyStoredEntries() bool {
	return j != nil && j.header.VerifyStoredEntries
}

// ContinuedFromOtherJob reports whether this run took over a snapshot an
// earlier job was writing (see ContinueRun).
func (j *snapshotJournal) ContinuedFromOtherJob() bool {
	return j != nil && j.continuedFromOtherJob
}

// StartAttempt starts this run's attempt at the journal's snapshot: it drops
// the base decision and control objects an earlier attempt of the same job
// recorded (the adoption check, which needs them, runs before this).
// Uploaded entries are kept. Best effort, like every journal write.
func (j *snapshotJournal) StartAttempt() error {
	if j == nil {
		return nil
	}
	j.header.BaseDecided = false
	j.header.ParentSnapshotID = ""
	j.header.PublishedObjects = nil
	return j.rewriteHeader()
}

// RecordBaseDecision records the base this run actually uses ("" = a full
// run), before any object referencing it is published.
func (j *snapshotJournal) RecordBaseDecision(parentSnapshotID string) error {
	if j == nil {
		return nil
	}
	j.header.BaseDecided = true
	j.header.ParentSnapshotID = parentSnapshotID
	return j.rewriteHeader()
}

// RecordPublishedObject records a control object this run is about to
// upload, replacing any earlier record for the same role.
func (j *snapshotJournal) RecordPublishedObject(obj PublishedObject) error {
	if j == nil {
		return nil
	}
	objects := make([]PublishedObject, 0, len(j.header.PublishedObjects)+1)
	for _, o := range j.header.PublishedObjects {
		if o.Role != obj.Role {
			objects = append(objects, o)
		}
	}
	j.header.PublishedObjects = append(objects, obj)
	return j.rewriteHeader()
}

// journalHeaderUpdate is a journal line that replaces the header's run
// bindings and published control objects (everything but the snapshot id,
// creation time, identity and format, which never change). Appending it is
// one flushed line, however large the journal already is.
type journalHeaderUpdate struct {
	HeaderUpdate journalHeader `json:"headerUpdate"`
}

var journalHeaderUpdatePrefix = []byte(`{"headerUpdate":`)

// rewriteHeader records j.header by appending a header-update line; the
// latest one wins when the journal is read back (see readJournal).
func (j *snapshotJournal) rewriteHeader() error {
	if j.file == nil {
		return errors.New("backup journal is closed")
	}
	line, err := json.Marshal(journalHeaderUpdate{HeaderUpdate: j.header})
	if err != nil {
		return fmt.Errorf("failed to encode backup journal header update: %w", err)
	}
	if _, err := j.writer.Write(append(line, '\n')); err != nil {
		slog.Warn("failed to write backup journal header update", "path", j.path, "error", err.Error())
		return err
	}
	if err := j.writer.Flush(); err != nil {
		slog.Warn("failed to flush backup journal header update", "path", j.path, "error", err.Error())
		return err
	}
	return nil
}

// applyHeaderUpdate folds a header-update line into header.
func applyHeaderUpdate(header *journalHeader, update journalHeader) {
	header.JobID = update.JobID
	header.DispatchedBaseSnapshotID = update.DispatchedBaseSnapshotID
	header.BaseDecided = update.BaseDecided
	header.ParentSnapshotID = update.ParentSnapshotID
	header.PublishedObjects = update.PublishedObjects
	header.VerifyStoredEntries = update.VerifyStoredEntries
}

// StaleSnapshotID returns the snapshot ID of a stale journal that Open
// discarded in favor of a fresh one, and whether one existed. Callers use
// this to best-effort clean up the abandoned remote prefix.
func (j *snapshotJournal) StaleSnapshotID() (string, bool) {
	if j == nil || j.staleSnapshotID == "" {
		return "", false
	}
	return j.staleSnapshotID, true
}

// Record appends f as a successfully uploaded file, flushing so the entry
// is durably visible to a later process (e.g. a crashed-and-restarted
// agent) without waiting for Close/Complete/Abandon. Per-line fsync is
// deliberately skipped as overkill; a flush per file is enough to survive
// anything short of a power loss, which the journal doesn't try to
// guarantee against anyway.
//
// A write failure here is logged and returned but must NOT be treated as
// fatal by the caller — a journal is a checkpoint, not a correctness
// requirement: a dead journal degrades resume to "start fresh next time,"
// it never fails the backup in progress.
func (j *snapshotJournal) Record(f SnapshotFile) error {
	if j == nil {
		return nil
	}
	if j.file == nil {
		return errors.New("backup journal is closed")
	}
	if !f.HasContent() {
		// Content-less entries (symlinks/directories) are rebuilt from the
		// live filesystem on every run, never resumed from a checkpoint —
		// see contentlessEntry's doc comment (snapshot.go).
		return nil
	}
	line, err := json.Marshal(f)
	if err != nil {
		slog.Warn("failed to encode backup journal entry", "path", j.path, "error", err.Error())
		return err
	}
	if _, err := j.writer.Write(append(line, '\n')); err != nil {
		slog.Warn("failed to write backup journal entry", "path", j.path, "error", err.Error())
		return err
	}
	if err := j.writer.Flush(); err != nil {
		slog.Warn("failed to flush backup journal entry", "path", j.path, "error", err.Error())
		return err
	}
	if j.entries == nil {
		j.entries = make(map[string]SnapshotFile)
	}
	// Keyed by journalEntryKey, not always f.SourcePath: under VSS,
	// SourcePath is a fresh per-run shadow-copy device path, so keying on it
	// directly would mean run 2 never matches anything run 1 recorded — see
	// journalEntryKey and backupFile.originalPath. last-entry-wins on reload.
	j.entries[journalEntryKey(f)] = f
	return nil
}

// Lookup reports whether a prior run's journal already recorded key (see
// journalEntryKey / journalLookupKey — OriginalPath when VSS is active,
// else SourcePath) with exactly this size and modTime — the resume-match
// rule. A changed file (different size or modTime) is a miss: it will be
// re-uploaded, and its new entry supersedes the old one on the next Record.
func (j *snapshotJournal) Lookup(key string, size int64, modTime time.Time) (SnapshotFile, bool) {
	if j == nil {
		return SnapshotFile{}, false
	}
	entry, ok := j.entries[key]
	if !ok || entry.Size != size || !entry.ModTime.Equal(modTime) {
		return SnapshotFile{}, false
	}
	return entry, true
}

// foldCollidingKeys returns the BackupPaths of every entry this journal
// holds (matched by this run's walk or not) that folds onto another entry's
// distinct BackupPath — see foldCollidingBackupPaths. Only a journal written
// by a pre-#5582 agent can hold such a pair; on a case-insensitive store the
// shared object holds whichever twin landed last, so the caller must not
// resume either of them. nil for a nil journal or no collisions.
func (j *snapshotJournal) foldCollidingKeys() map[string]bool {
	if j == nil || len(j.entries) == 0 {
		return nil
	}
	all := make([]SnapshotFile, 0, len(j.entries))
	for _, e := range j.entries {
		all = append(all, e)
	}
	return foldCollidingBackupPaths(all)
}

// ResumedBytes returns the total size of the entries loaded from a resumed
// journal (0 for a fresh journal). It reflects the state at Open time only
// — later Record calls in the same run do not change it — so callers should
// read it once, before the upload loop starts, to seed progress reporting.
func (j *snapshotJournal) ResumedBytes() int64 {
	if j == nil {
		return 0
	}
	return j.resumedBytesTotal
}

// Age reports how long ago this journal was originally created (the
// header's CreatedAt, unaffected by resume — see the createdAt field doc).
// A nil journal reports zero age.
func (j *snapshotJournal) Age() time.Duration {
	if j == nil || j.createdAt.IsZero() {
		return 0
	}
	return time.Since(j.createdAt)
}

// journalRemoveFn is a test seam over os.Remove so Complete's Remove-failure
// (poison) path can be exercised deterministically regardless of process
// privilege — a read-only parent dir does not block removal when the test runs
// as root, so a seam is the only reliable way to force the failure.
var journalRemoveFn = os.Remove

// setJournalRemoveFnForTest overrides journalRemoveFn so tests can force
// Complete's remove-failure (poison) path deterministically. Call the returned
// restore func (typically via defer) to put os.Remove back.
func setJournalRemoveFnForTest(fn func(string) error) (restore func()) {
	old := journalRemoveFn
	journalRemoveFn = fn
	return func() { journalRemoveFn = old }
}

// Complete marks the run as fully successful: closes the journal file and
// removes it. Call this only after the snapshot manifest has been uploaded
// — the point at which the snapshot is restorable and the checkpoint is no
// longer needed.
//
// If the remove fails (e.g. a read-only parent dir), the file survives on disk
// still carrying the COMPLETED snapshot's ID and a valid header. Left as-is,
// the NEXT run would RESUME it — same snapshot ID, changed files uploaded into
// the already-completed prefix, manifest.json overwritten — silently mutating a
// historical restore point. To prevent that, Complete poisons the file
// (truncates it to empty) so it can never be resumed: openSnapshotJournal reads
// an empty journal as corrupt and discards it, starting fresh with no resume
// and no stale-prefix cleanup. Truncating the FILE needs only file-level write
// permission, which survives the read-only PARENT dir that blocked the remove.
func (j *snapshotJournal) Complete() error {
	if j == nil {
		return nil
	}
	var closeErr error
	if j.file != nil {
		closeErr = j.file.Close()
	}
	if rmErr := journalRemoveFn(j.path); rmErr != nil && !os.IsNotExist(rmErr) {
		poisonErr := poisonJournalFile(j.path)
		return errors.Join(closeErr, rmErr, poisonErr)
	}
	return closeErr
}

// poisonJournalFile renders the journal at path permanently non-resumable by
// truncating it to empty. openSnapshotJournal treats an empty journal as
// corrupt — discarding it and starting a fresh run — rather than resuming a
// COMPLETED snapshot's ID. Used by Complete when the remove fails.
func poisonJournalFile(path string) error {
	if err := os.Truncate(path, 0); err != nil {
		return fmt.Errorf("failed to poison completed backup journal %s: %w", path, err)
	}
	return nil
}

// Abandon closes the journal file handle but keeps the file on disk: the
// partial remote upload prefix plus the journal together ARE the resume
// state for a stopped or failed run. Call this on every exit path except a
// fully successful Complete.
func (j *snapshotJournal) Abandon() {
	if j == nil || j.file == nil {
		return
	}
	if err := j.file.Close(); err != nil {
		slog.Warn("failed to close backup journal", "path", j.path, "error", err.Error())
	}
}
