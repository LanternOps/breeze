package backup

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"time"
)

const resumeStateFile = "resume-state.json"

// resumeJournalFile is the append-only log of files completed since the
// resume-state snapshot was last written (#7333). One JSON record per line.
const resumeJournalFile = "resume-journal.jsonl"

// The journal is fsync'd at most this often. A power loss can lose at most
// the unsynced tail, which only means those files are downloaded and
// installed again on resume — safe, since installation is an idempotent
// atomic replace with verified bytes. A process crash loses nothing: every
// record is written to the OS before the next file starts.
const (
	resumeJournalSyncEvery    = 256
	resumeJournalSyncInterval = 5 * time.Second
)

// saveResumeStateFn is the persistence seam the restore writes the
// resume-state snapshot through; tests swap it to count snapshot rewrites.
var saveResumeStateFn = SaveResumeState

// ResumeState tracks which files have been restored so a partial restore can
// be resumed without re-downloading completed files.
type ResumeState struct {
	SnapshotID     string          `json:"snapshotId"`
	CompletedFiles map[string]bool `json:"completedFiles"` // backupPath -> true
	BytesRestored  int64           `json:"bytesRestored"`
}

// LoadResumeState reads resume state from the staging directory.
// Returns (nil, nil) if the state file does not exist.
func LoadResumeState(stagingDir string) (*ResumeState, error) {
	p := filepath.Join(stagingDir, resumeStateFile)
	data, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read resume state: %w", err)
	}

	var state ResumeState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("decode resume state: %w", err)
	}
	return &state, nil
}

// SaveResumeState writes resume state atomically (write temp, fsync, rename).
func SaveResumeState(stagingDir string, state *ResumeState) error {
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode resume state: %w", err)
	}

	tmpFile, err := os.CreateTemp(stagingDir, "resume-state-*.tmp")
	if err != nil {
		return fmt.Errorf("create temp resume state: %w", err)
	}
	tmpPath := tmpFile.Name()

	if _, err := tmpFile.Write(data); err != nil {
		_ = tmpFile.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("write resume state: %w", err)
	}
	// The snapshot supersedes the journal, which is deleted right after this
	// rename: its bytes must be durable before the journal goes.
	if err := tmpFile.Sync(); err != nil {
		_ = tmpFile.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("sync resume state: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("close resume state: %w", err)
	}

	target := filepath.Join(stagingDir, resumeStateFile)
	if err := os.Rename(tmpPath, target); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("rename resume state: %w", err)
	}
	return nil
}

// CleanupResumeState removes the resume state file from the staging directory.
func CleanupResumeState(stagingDir string) error {
	p := filepath.Join(stagingDir, resumeStateFile)
	if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("cleanup resume state: %w", err)
	}
	return nil
}

// resumeJournalRecord is one journal line: a file installed and verified.
type resumeJournalRecord struct {
	Path string `json:"p"` // SnapshotFile.BackupPath
	Size int64  `json:"b"`
}

// resumeTracker persists restore progress in O(N) total writes (#7333).
//
// It used to rewrite resume-state.json — a map of EVERY completed path —
// after every file, so a 133k-file restore wrote hundreds of GB of state.
// Now the snapshot (resume-state.json, format unchanged) is written only on
// compaction, and each completed file appends one short record to
// resume-journal.jsonl. Compaction (snapshot write, then journal removal)
// happens when a run opens state left by a previous run and when a run ends
// without completing, so the snapshot alone is always current between runs
// and an older agent that only reads resume-state.json loses nothing.
//
// Crash safety: records are appended only after a file is installed, exactly
// where the snapshot used to be saved. Replay is a set union, so replaying a
// journal the snapshot already contains (a crash between compaction's rename
// and the journal removal) is a no-op. A torn or unreadable line is skipped;
// the worst outcome of losing a record is re-downloading and re-installing
// that one file, which the restore already treats as idempotent (a completed
// entry is honoured only when the target exists at the manifest size).
type resumeTracker struct {
	stagingDir string
	state      *ResumeState

	journal         *os.File
	journalDisabled bool // opening the journal failed; warned once
	needNewline     bool // the journal may end mid-line (torn tail, failed write)
	writeFailures   int
	syncFailures    int
	unsynced        int
	lastSync        time.Time

	dirty  bool // state holds progress the on-disk snapshot does not
	closed bool
}

// openResumeTracker loads the snapshot and replays any journal a previous run
// left, then compacts the two so this run starts from a single file. Every
// failure degrades toward "re-restore more files", never toward an error.
func openResumeTracker(stagingDir, snapshotID string) *resumeTracker {
	t := &resumeTracker{stagingDir: stagingDir, lastSync: time.Now()}

	state, err := LoadResumeState(stagingDir)
	if err != nil {
		slog.Warn("failed to load resume state, starting fresh", "error", err.Error())
	}
	if state == nil {
		state = &ResumeState{SnapshotID: snapshotID}
	}
	if state.CompletedFiles == nil {
		state.CompletedFiles = make(map[string]bool)
	}
	t.state = state

	journalPresent, cleanEnd, err := replayResumeJournal(t.journalPath(), state)
	if err != nil {
		slog.Warn("failed to read resume journal; files it recorded will be restored again", "error", err.Error())
	}
	if journalPresent {
		t.needNewline = !cleanEnd
		t.dirty = true
		t.compact()
	}
	return t
}

func (t *resumeTracker) journalPath() string {
	return filepath.Join(t.stagingDir, resumeJournalFile)
}

func (t *resumeTracker) completed(backupPath string) bool {
	return t.state.CompletedFiles[backupPath]
}

// forget drops a completed entry whose target no longer matches, so it is
// restored again. Persisted by the next compaction; until then the stale
// entry on disk is harmless because resume re-checks the target anyway.
func (t *resumeTracker) forget(backupPath string) {
	if _, ok := t.state.CompletedFiles[backupPath]; ok {
		delete(t.state.CompletedFiles, backupPath)
		t.dirty = true
	}
}

// markCompleted records a file as installed and appends it to the journal.
// Failures are logged, not returned: resume state is an optimisation, and the
// restore it describes has already succeeded.
func (t *resumeTracker) markCompleted(backupPath string, size int64) {
	t.state.CompletedFiles[backupPath] = true
	t.state.BytesRestored += size
	t.dirty = true

	if t.closed || !t.ensureJournal() {
		return
	}
	line, err := json.Marshal(resumeJournalRecord{Path: backupPath, Size: size})
	if err != nil {
		t.warnWrite(err)
		return
	}
	line = append(line, '\n')
	if t.needNewline {
		line = append([]byte{'\n'}, line...)
	}
	if _, err := t.journal.Write(line); err != nil {
		// A short write may have left a partial line; start the next
		// record on a fresh one so it stays readable.
		t.needNewline = true
		t.warnWrite(err)
		return
	}
	t.needNewline = false
	t.unsynced++
	if t.unsynced >= resumeJournalSyncEvery || time.Since(t.lastSync) >= resumeJournalSyncInterval {
		t.syncJournal()
	}
}

func (t *resumeTracker) ensureJournal() bool {
	if t.journal != nil {
		return true
	}
	if t.journalDisabled {
		return false
	}
	f, err := os.OpenFile(t.journalPath(), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		t.journalDisabled = true
		slog.Warn("failed to open resume journal; progress will be saved only when the restore ends", "error", err.Error())
		return false
	}
	t.journal = f
	return true
}

func (t *resumeTracker) warnWrite(err error) {
	t.writeFailures++
	// Once, then every 1000th: a full disk would otherwise log per file.
	if t.writeFailures == 1 || t.writeFailures%1000 == 0 {
		slog.Warn("failed to save resume state", "error", err.Error(), "failures", t.writeFailures)
	}
}

func (t *resumeTracker) syncJournal() {
	if t.journal == nil || t.unsynced == 0 {
		return
	}
	if err := t.journal.Sync(); err != nil {
		t.syncFailures++
		// Same cadence as warnWrite: a failing disk would otherwise log
		// every 5 s for the rest of a multi-hour restore.
		if t.syncFailures == 1 || t.syncFailures%1000 == 0 {
			slog.Warn("failed to sync resume journal", "error", err.Error(), "failures", t.syncFailures)
		}
	}
	t.unsynced = 0
	t.lastSync = time.Now()
}

// compact writes the full state as the snapshot, then removes the journal it
// now subsumes. On failure the journal stays and remains authoritative.
func (t *resumeTracker) compact() {
	if !t.dirty {
		return
	}
	if err := saveResumeStateFn(t.stagingDir, t.state); err != nil {
		slog.Warn("failed to save resume state", "error", err.Error())
		return
	}
	t.dirty = false
	if t.journal != nil {
		_ = t.journal.Close()
		t.journal = nil
		t.unsynced = 0
	}
	if err := os.Remove(t.journalPath()); err != nil && !os.IsNotExist(err) {
		// Harmless: its records are all in the snapshot, and replay is a set
		// union. Appends continue on a fresh line.
		t.needNewline = true
		slog.Warn("failed to remove compacted resume journal", "error", err.Error())
		return
	}
	t.needNewline = false
}

// close flushes the journal and compacts it into the snapshot. Called when a
// run ends without completing (cancel, partial, failed). Idempotent.
func (t *resumeTracker) close() {
	if t.closed {
		return
	}
	t.syncJournal()
	t.compact()
	t.closed = true
	if t.journal != nil {
		_ = t.journal.Close()
		t.journal = nil
	}
}

// discard releases the journal handle without writing anything: the caller
// is about to delete the staging directory (a handle held open would block
// that on Windows). Idempotent, and a no-op after close.
func (t *resumeTracker) discard() {
	t.closed = true
	if t.journal != nil {
		_ = t.journal.Close()
		t.journal = nil
	}
}

// replayResumeJournal applies every readable journal record to state.
// present reports whether a journal file existed; cleanEnd whether it ended
// on a line boundary (so an append can follow without a separator).
func replayResumeJournal(path string, state *ResumeState) (present, cleanEnd bool, err error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return false, true, nil
		}
		// Present but unreadable: have the caller compact over it so the
		// run does not keep appending to a file it can never replay.
		return true, false, err
	}
	defer func() { _ = f.Close() }()

	r := bufio.NewReader(f)
	skipped := 0
	cleanEnd = true
	for {
		line, readErr := r.ReadBytes('\n')
		if len(line) > 0 {
			cleanEnd = line[len(line)-1] == '\n'
			if trimmed := bytes.TrimSpace(line); len(trimmed) > 0 {
				var rec resumeJournalRecord
				if json.Unmarshal(trimmed, &rec) != nil || rec.Path == "" {
					skipped++
				} else if !state.CompletedFiles[rec.Path] {
					state.CompletedFiles[rec.Path] = true
					state.BytesRestored += rec.Size
				}
			}
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) {
				return true, false, readErr
			}
			break
		}
	}
	if skipped > 0 {
		// Expected after a crash mid-append (a torn final line); those files
		// are restored again.
		slog.Info("skipped unreadable resume journal records", "count", skipped)
	}
	return true, cleanEnd, nil
}
