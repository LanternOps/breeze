package backup

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestOpenSnapshotJournal_FreshWhenNoFileExists(t *testing.T) {
	dir := t.TempDir()

	j, resumed, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed {
		t.Fatal("resumed should be false when no journal file exists")
	}
	if j == nil {
		t.Fatal("journal should not be nil")
	}
	if j.snapshotID == "" {
		t.Error("fresh journal should have a generated snapshot ID")
	}
	if _, ok := j.StaleSnapshotID(); ok {
		t.Error("StaleSnapshotID should report false for a fresh journal with no prior file")
	}
	if got := j.ResumedBytes(); got != 0 {
		t.Errorf("ResumedBytes = %d, want 0 for a fresh journal", got)
	}
	j.Abandon()

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("ReadDir: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly one journal file on disk, got %d", len(entries))
	}
	if !strings.HasPrefix(entries[0].Name(), "backup-journal-") || !strings.HasSuffix(entries[0].Name(), ".jsonl") {
		t.Errorf("unexpected journal filename: %s", entries[0].Name())
	}
}

func TestSnapshotJournal_RoundTrip(t *testing.T) {
	dir := t.TempDir()

	j1, resumed, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed {
		t.Fatal("first open of a nonexistent journal should not resume")
	}

	modTime := time.Date(2026, 7, 1, 10, 0, 0, 0, time.UTC)
	files := []SnapshotFile{
		{SourcePath: "/data/a.txt", BackupPath: "snap/a.txt.gz", Size: 100, ModTime: modTime, Checksum: "aaa"},
		{SourcePath: "/data/b.txt", BackupPath: "snap/b.txt.gz", Size: 200, ModTime: modTime, Checksum: "bbb"},
		{SourcePath: "/data/c.txt", BackupPath: "snap/c.txt.gz", Size: 300, ModTime: modTime, Checksum: "ccc"},
	}
	for _, f := range files {
		if err := j1.Record(f); err != nil {
			t.Fatalf("Record(%s) failed: %v", f.SourcePath, err)
		}
	}
	wantSnapshotID := j1.snapshotID
	j1.Abandon()

	// Reopen: same identity, same directory — must resume with all three
	// entries loaded and the same snapshot ID.
	j2, resumed, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	if !resumed {
		t.Fatal("reopening a valid, fresh journal should resume")
	}
	if j2.snapshotID != wantSnapshotID {
		t.Errorf("snapshotID = %q, want %q (same as first run)", j2.snapshotID, wantSnapshotID)
	}

	// Lookup hits with matching size/modTime.
	entry, ok := j2.Lookup("/data/a.txt", 100, modTime)
	if !ok {
		t.Fatal("expected Lookup hit for /data/a.txt with matching size/modTime")
	}
	if entry.Checksum != "aaa" {
		t.Errorf("Lookup returned wrong entry: %+v", entry)
	}

	// Miss on changed size.
	if _, ok := j2.Lookup("/data/a.txt", 999, modTime); ok {
		t.Error("Lookup should miss when size changed")
	}
	// Miss on changed modTime.
	if _, ok := j2.Lookup("/data/a.txt", 100, modTime.Add(time.Hour)); ok {
		t.Error("Lookup should miss when modTime changed")
	}
	// Miss for a path never recorded.
	if _, ok := j2.Lookup("/data/never.txt", 1, modTime); ok {
		t.Error("Lookup should miss for an unrecorded path")
	}

	if got, want := j2.ResumedBytes(), int64(100+200+300); got != want {
		t.Errorf("ResumedBytes = %d, want %d", got, want)
	}
	j2.Abandon()
}

func TestSnapshotJournal_LastEntryWins(t *testing.T) {
	dir := t.TempDir()

	j1, _, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	oldModTime := time.Date(2026, 7, 1, 0, 0, 0, 0, time.UTC)
	newModTime := time.Date(2026, 7, 2, 0, 0, 0, 0, time.UTC)

	if err := j1.Record(SnapshotFile{SourcePath: "/data/a.txt", Size: 100, ModTime: oldModTime, Checksum: "old"}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	// Same sourcePath, changed since the first record — supersedes it.
	if err := j1.Record(SnapshotFile{SourcePath: "/data/a.txt", Size: 150, ModTime: newModTime, Checksum: "new"}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	j1.Abandon()

	j2, resumed, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("reopen failed: %v", err)
	}
	if !resumed {
		t.Fatal("expected resume")
	}

	// The old (size, modTime) pair must no longer match.
	if _, ok := j2.Lookup("/data/a.txt", 100, oldModTime); ok {
		t.Error("stale first entry should have been superseded, not matched")
	}
	// The new (size, modTime) pair must match, with the new checksum.
	entry, ok := j2.Lookup("/data/a.txt", 150, newModTime)
	if !ok {
		t.Fatal("expected the superseding entry to match")
	}
	if entry.Checksum != "new" {
		t.Errorf("checksum = %q, want %q (last-entry-wins)", entry.Checksum, "new")
	}
	if got, want := j2.ResumedBytes(), int64(150); got != want {
		t.Errorf("ResumedBytes = %d, want %d (only the winning entry counted once)", got, want)
	}
	j2.Abandon()
}

func TestOpenSnapshotJournal_CorruptLineStartsFresh(t *testing.T) {
	dir := t.TempDir()

	// Seed a journal, corrupt the file. The path must be deterministic from
	// (dir, identity) so we can write directly at it.
	j1, _, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	oldSnapshotID := j1.snapshotID
	journalPath := j1.path
	j1.Abandon()

	// Overwrite with a valid header followed by a malformed data line.
	corrupt := `{"snapshotId":"snapshot-corrupt","createdAt":"2026-07-01T00:00:00Z","identity":"test-identity"}
{this is not valid json`
	if err := os.WriteFile(journalPath, []byte(corrupt), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	j2, resumed, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal should never fail the backup over a corrupt journal, got: %v", err)
	}
	if resumed {
		t.Fatal("a corrupt journal must never resume")
	}
	if j2.snapshotID == oldSnapshotID || j2.snapshotID == "snapshot-corrupt" {
		t.Errorf("expected a brand-new snapshot ID after discarding the corrupt journal, got %q", j2.snapshotID)
	}
	if _, ok := j2.Lookup("/data/a.txt", 1, time.Now()); ok {
		t.Error("a fresh journal after corruption should have no entries")
	}
	j2.Abandon()
}

func TestOpenSnapshotJournal_CorruptHeaderStartsFresh(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, journalFileName("test-identity"))
	if err := os.WriteFile(path, []byte("not even json\n"), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	j, resumed, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal should never fail the backup over a corrupt header, got: %v", err)
	}
	if resumed {
		t.Fatal("a corrupt header must never resume")
	}
	j.Abandon()
}

func TestOpenSnapshotJournal_StaleHeaderDoesNotResume(t *testing.T) {
	dir := t.TempDir()

	j1, _, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := j1.Record(SnapshotFile{SourcePath: "/data/a.txt", Size: 10, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	staleID := j1.snapshotID
	j1.Abandon()

	// A journal older than a very small maxAge is stale even though it's
	// only microseconds old in wall-clock terms.
	time.Sleep(2 * time.Millisecond)
	j2, resumed, err := openSnapshotJournal(dir, "test-identity", time.Millisecond)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed {
		t.Fatal("a stale journal must never resume")
	}
	if j2.snapshotID == staleID {
		t.Error("expected a brand-new snapshot ID for a stale journal")
	}
	if got, ok := j2.StaleSnapshotID(); !ok || got != staleID {
		t.Errorf("StaleSnapshotID = (%q, %v), want (%q, true)", got, ok, staleID)
	}
	if _, ok := j2.Lookup("/data/a.txt", 10, time.Now()); ok {
		t.Error("a stale journal's entries must not be loaded")
	}
	j2.Abandon()
}

// TestOpenSnapshotJournal_IdentityMismatchDoesNotResume is FIX C's
// regression test: openSnapshotJournal must verify header.Identity against
// the caller-supplied identity, not just trust whatever's on disk at the
// (identity-hash-derived) path. In normal operation the two can never
// diverge — the path itself is sha256(identity) — so this can only really
// happen via a hash collision or direct file tampering, but both must be
// treated the same as staleness: discard and start fresh, never resume.
func TestOpenSnapshotJournal_IdentityMismatchDoesNotResume(t *testing.T) {
	dir := t.TempDir()

	j1, _, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := j1.Record(SnapshotFile{SourcePath: "/data/a.txt", Size: 10, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	mismatchedID := j1.snapshotID
	journalPath := j1.path
	j1.Abandon()

	// Tamper with the on-disk header's identity field while keeping the
	// file at the same (identity-a-derived) path — reopening with the SAME
	// identity string used to create it must still refuse to resume, since
	// the file's own claimed identity no longer matches what was recorded.
	raw, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	rest := ""
	if idx := strings.IndexByte(string(raw), '\n'); idx >= 0 {
		rest = string(raw)[idx+1:]
	}
	tamperedHeader := `{"snapshotId":"` + mismatchedID + `","createdAt":"` + time.Now().UTC().Format(time.RFC3339) + `","identity":"identity-b"}` + "\n"
	if err := os.WriteFile(journalPath, []byte(tamperedHeader+rest), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	j2, resumed, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed {
		t.Fatal("an identity-mismatched journal must never resume")
	}
	if j2.snapshotID == mismatchedID {
		t.Error("expected a brand-new snapshot ID after an identity mismatch")
	}
	if got, ok := j2.StaleSnapshotID(); !ok || got != mismatchedID {
		t.Errorf("StaleSnapshotID = (%q, %v), want (%q, true) — a mismatch should get the same remote-cleanup treatment as staleness",
			got, ok, mismatchedID)
	}
	if _, ok := j2.Lookup("/data/a.txt", 10, time.Now()); ok {
		t.Error("an identity-mismatched journal's entries must not be loaded")
	}
	j2.Abandon()
}

func TestOpenSnapshotJournal_DifferentIdentitiesGetDifferentFiles(t *testing.T) {
	dir := t.TempDir()

	jA, _, err := openSnapshotJournal(dir, "identity-a", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := jA.Record(SnapshotFile{SourcePath: "/data/a.txt", Size: 1, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	jA.Abandon()

	jB, resumed, err := openSnapshotJournal(dir, "identity-b", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if resumed {
		t.Fatal("a different identity must not resume another identity's journal")
	}
	if jB.path == jA.path {
		t.Fatal("different identities must map to different journal file paths")
	}
	jB.Abandon()
}

func TestSnapshotJournal_Complete_RemovesFile(t *testing.T) {
	dir := t.TempDir()
	j, _, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	path := j.path
	if err := j.Complete(); err != nil {
		t.Fatalf("Complete failed: %v", err)
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("expected journal file to be removed after Complete, stat err = %v", err)
	}
}

// When Complete's remove fails (e.g. a read-only parent dir), the surviving
// journal file must be POISONED (emptied) so the next run cannot resume the
// already-COMPLETED snapshot's ID and silently mutate a historical restore
// point. The remove failure is forced via the journalRemoveFn seam so the test
// is deterministic regardless of process privilege.
func TestSnapshotJournal_Complete_PoisonsWhenRemoveFails(t *testing.T) {
	dir := t.TempDir()
	identity := "poison-identity"
	j, _, err := openSnapshotJournal(dir, identity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	if err := j.Record(SnapshotFile{SourcePath: "/data.txt", Size: 5, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	path := j.path
	completedID := j.snapshotID

	restore := setJournalRemoveFnForTest(func(string) error { return os.ErrPermission })
	defer restore()

	if err := j.Complete(); err == nil {
		t.Fatal("Complete must report an error when the remove fails")
	}

	// The file must still exist (remove was blocked) but be empty (poisoned).
	info, statErr := os.Stat(path)
	if statErr != nil {
		t.Fatalf("expected the journal file to survive a failed remove, stat err = %v", statErr)
	}
	if info.Size() != 0 {
		t.Fatalf("expected the journal to be poisoned (empty), got size %d", info.Size())
	}

	// Re-opening the poisoned journal (with a real remove restored) must NOT
	// resume the completed snapshot and must not trigger stale-prefix cleanup.
	restore()
	j2, resumed, err := openSnapshotJournal(dir, identity, journalMaxAge)
	if err != nil {
		t.Fatalf("re-open after poison failed: %v", err)
	}
	if resumed {
		t.Fatal("a poisoned journal must never be resumed")
	}
	if j2.snapshotID == completedID {
		t.Fatal("a poisoned journal must not carry the completed snapshot ID forward")
	}
	if _, ok := j2.StaleSnapshotID(); ok {
		t.Fatal("a poisoned (empty→corrupt) journal must not trigger stale-prefix cleanup")
	}
	j2.Abandon()
}

func TestSnapshotJournal_Abandon_KeepsFile(t *testing.T) {
	dir := t.TempDir()
	j, _, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	path := j.path
	j.Abandon()
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("expected journal file to remain on disk after Abandon, got stat err = %v", err)
	}
}

func TestSnapshotJournal_NilSafe(t *testing.T) {
	var j *snapshotJournal

	if err := j.Record(SnapshotFile{SourcePath: "/x"}); err != nil {
		t.Errorf("Record on nil journal should be a no-op, got %v", err)
	}
	if _, ok := j.Lookup("/x", 1, time.Now()); ok {
		t.Error("Lookup on nil journal should always miss")
	}
	if got := j.ResumedBytes(); got != 0 {
		t.Errorf("ResumedBytes on nil journal = %d, want 0", got)
	}
	if err := j.Complete(); err != nil {
		t.Errorf("Complete on nil journal should be a no-op, got %v", err)
	}
	if _, ok := j.StaleSnapshotID(); ok {
		t.Error("StaleSnapshotID on nil journal should report false")
	}
	j.Abandon() // must not panic
}

// The old behavior — empty dir falls back to os.TempDir() — was removed
// deliberately: a deterministic root-owned filename in a world-writable dir
// is a symlink/tamper surface. Empty dir is now an error and callers
// (resolveJournalDir) decide the secure location or disable journaling.
func TestOpenSnapshotJournal_EmptyDirRejected(t *testing.T) {
	j, resumed, err := openSnapshotJournal("", "test-identity", journalMaxAge)
	if err == nil || j != nil || resumed {
		t.Fatalf("empty dir must be rejected (no os.TempDir fallback), got (%v, %v, %v)", j, resumed, err)
	}
}

func TestOpenSnapshotJournal_CreatesMissingDir0700(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "journal-dir")
	j, resumed, err := openSnapshotJournal(dir, "test-identity", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	defer j.Abandon()
	if resumed {
		t.Fatal("fresh journal must not report resumed")
	}
	info, err := os.Stat(dir)
	if err != nil {
		t.Fatalf("journal dir was not created: %v", err)
	}
	if !info.IsDir() {
		t.Fatalf("journal dir is not a directory")
	}
	if runtime.GOOS != "windows" {
		if perm := info.Mode().Perm(); perm != 0o700 {
			t.Fatalf("journal dir must be 0700, got %o", perm)
		}
	}
}

// A symlink (or anything else that is not a regular file) planted at the
// deterministic journal path must never be read or resumed from — the
// helper runs as root/SYSTEM, so following it would let an attacker feed a
// forged journal (remote snapshot cleanup, silent file skips). It is
// deleted and replaced with a fresh journal.
func TestOpenSnapshotJournal_RefusesSymlinkJournal(t *testing.T) {
	dir := t.TempDir()
	identity := "test-identity"

	// Build a VALID journal at an attacker-controlled location...
	attackerDir := t.TempDir()
	attackerPath := filepath.Join(attackerDir, "forged.jsonl")
	forged, _, err := createFreshJournal(attackerPath, identity)
	if err != nil {
		t.Fatalf("createFreshJournal failed: %v", err)
	}
	if err := forged.Record(SnapshotFile{SourcePath: "/etc/forged.txt", Size: 4, ModTime: time.Now()}); err != nil {
		t.Fatalf("Record failed: %v", err)
	}
	forgedSnapshotID := forged.snapshotID
	forged.Abandon()

	// ...and symlink the real journal path at it.
	journalPath := filepath.Join(dir, journalFileName(identity))
	if err := os.Symlink(attackerPath, journalPath); err != nil {
		t.Skipf("cannot create symlinks on this platform: %v", err)
	}

	j, resumed, err := openSnapshotJournal(dir, identity, journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal failed: %v", err)
	}
	defer j.Abandon()
	if resumed {
		t.Fatal("a symlinked journal must never be resumed from")
	}
	if j.snapshotID == forgedSnapshotID {
		t.Fatal("fresh journal must not adopt the forged journal's snapshot ID")
	}
	if _, ok := j.Lookup("/etc/forged.txt", 4, time.Now()); ok {
		t.Fatal("forged entries must not be loaded")
	}
	// The symlink itself must be gone — replaced by a regular file.
	fi, lstatErr := os.Lstat(journalPath)
	if lstatErr != nil {
		t.Fatalf("journal path missing after open: %v", lstatErr)
	}
	if !fi.Mode().IsRegular() {
		t.Fatalf("journal path must now be a regular file, got mode %v", fi.Mode())
	}
	// The attacker's file must be untouched (we removed the link, not the target).
	if _, err := os.Stat(attackerPath); err != nil {
		t.Fatalf("symlink target must not be deleted: %v", err)
	}
}
