package backup

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// plannerMockProvider is a mockProvider that also takes an upload plan, so a
// run makes its dedupe decisions in the up-front pre-pass the brokered
// writer gets (createSnapshotWithProgress's UploadPlanner branch).
type plannerMockProvider struct {
	*mockProvider
	prepared atomic.Int32
}

func (p *plannerMockProvider) PrepareUploads([]providers.PlannedUpload) { p.prepared.Add(1) }

// digestingMockProvider answers stored-object readbacks from a table.
type storedDigestAnswer struct {
	digest providers.UploadDigest
	err    error
}

type digestingMockProvider struct {
	*mockProvider
	digests map[string]storedDigestAnswer
}

func (p *digestingMockProvider) StoredObjectDigest(_ context.Context, remotePath string) (providers.UploadDigest, error) {
	a, ok := p.digests[remotePath]
	if !ok {
		return providers.UploadDigest{}, fmt.Errorf("%s: %w", remotePath, providers.ErrObjectNotFound)
	}
	return a.digest, a.err
}

// #11014: the checks a run makes before it uploads anything (the resume pass
// re-reads every journaled file; the dedupe pre-pass hashes a file whose
// modification time moved) can take hours on a multi-TB selection and used to
// leave every progress counter at zero, so the server reaped a healthy run.
// They now advance VerifiedFiles/VerifiedBytes, while FilesDone/BytesDone keep
// their meaning.
func TestCreateSnapshotWithProgress_VerifiedCounters(t *testing.T) {
	restore := setProgressThrottleForTest(0)
	defer restore()

	oldMod := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	newMod := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)

	type tc struct {
		name string
		// build returns the run's inputs.
		build             func(t *testing.T) (provider providers.BackupProvider, files []backupFile, journal *snapshotJournal, prev *Snapshot)
		wantVerifiedFiles int
		wantVerifiedBytes int64
		wantFilesDone     int
		wantBytesDone     int64
		// wantVerifiedBeforeSeed: an emission must report verified work while
		// FilesDone is still 0, i.e. DURING the pass rather than after it.
		wantVerifiedBeforeSeed bool
	}

	cases := []tc{
		{
			name: "resume: every journaled file re-hashed counts as verified, matched or not",
			build: func(t *testing.T) (providers.BackupProvider, []backupFile, *snapshotJournal, *Snapshot) {
				dir := t.TempDir()
				journal, _, err := openSnapshotJournal(t.TempDir(), "verified-resume", journalMaxAge)
				if err != nil {
					t.Fatalf("openSnapshotJournal: %v", err)
				}
				matched := createTempFile(t, dir, "matched.txt", "hello")  // 5 bytes, journaled, unchanged
				changed := createTempFile(t, dir, "changed.txt", "world!") // 6 bytes, journaled, content changed
				fresh := createTempFile(t, dir, "fresh.txt", "new!")       // 4 bytes, never journaled
				if err := journal.Record(SnapshotFile{SourcePath: matched, BackupPath: "k/matched", Size: 5, ModTime: oldMod, Checksum: digestBytes([]byte("hello")).SHA256}); err != nil {
					t.Fatal(err)
				}
				if err := journal.Record(SnapshotFile{SourcePath: changed, BackupPath: "k/changed", Size: 6, ModTime: oldMod, Checksum: digestBytes([]byte("before")).SHA256}); err != nil {
					t.Fatal(err)
				}
				files := []backupFile{
					{sourcePath: matched, snapshotPath: "p/matched.txt", size: 5, modTime: oldMod},
					{sourcePath: changed, snapshotPath: "p/changed.txt", size: 6, modTime: oldMod},
					{sourcePath: fresh, snapshotPath: "p/fresh.txt", size: 4, modTime: oldMod},
				}
				return newMockProvider(), files, journal, nil
			},
			wantVerifiedFiles:      2,
			wantVerifiedBytes:      11,
			wantFilesDone:          3,
			wantBytesDone:          15,
			wantVerifiedBeforeSeed: true,
		},
		{
			name: "fresh run, no journal, no base: nothing is verified",
			build: func(t *testing.T) (providers.BackupProvider, []backupFile, *snapshotJournal, *Snapshot) {
				dir := t.TempDir()
				files := []backupFile{
					{sourcePath: createTempFile(t, dir, "a.txt", "aaa"), snapshotPath: "p/a.txt", size: 3, modTime: oldMod},
					{sourcePath: createTempFile(t, dir, "b.txt", "bbbb"), snapshotPath: "p/b.txt", size: 4, modTime: oldMod},
				}
				return &plannerMockProvider{mockProvider: newMockProvider()}, files, nil, nil
			},
			wantFilesDone: 2,
			wantBytesDone: 7,
		},
		{
			name: "dedupe pre-pass: only a file it had to hash counts as verified",
			build: func(t *testing.T) (providers.BackupProvider, []backupFile, *snapshotJournal, *Snapshot) {
				dir := t.TempDir()
				touched := createTempFile(t, dir, "touched.txt", "same-bytes") // 10 bytes, mtime moved → hashed
				still := createTempFile(t, dir, "still.txt", "untouched")      // 9 bytes, mtime equal → no hash
				prev := &Snapshot{ID: "prev-snap", Files: []SnapshotFile{
					{SourcePath: touched, BackupPath: "snapshots/prev-snap/files/touched.txt.gz", Size: 10, ModTime: oldMod, Checksum: digestBytes([]byte("same-bytes")).SHA256},
					{SourcePath: still, BackupPath: "snapshots/prev-snap/files/still.txt.gz", Size: 9, ModTime: oldMod, Checksum: digestBytes([]byte("untouched")).SHA256},
				}}
				files := []backupFile{
					{sourcePath: touched, snapshotPath: "p/touched.txt", size: 10, modTime: newMod},
					{sourcePath: still, snapshotPath: "p/still.txt", size: 9, modTime: oldMod},
				}
				return &plannerMockProvider{mockProvider: newMockProvider()}, files, nil, prev
			},
			wantVerifiedFiles: 1,
			wantVerifiedBytes: 10,
			wantFilesDone:     2,
			wantBytesDone:     19,
		},
		{
			// No planner: the decision is made at admission in the file pass.
			name: "dedupe without a planner: a file it had to hash counts once",
			build: func(t *testing.T) (providers.BackupProvider, []backupFile, *snapshotJournal, *Snapshot) {
				dir := t.TempDir()
				touched := createTempFile(t, dir, "touched.txt", "same-bytes")
				prev := &Snapshot{ID: "prev-snap", Files: []SnapshotFile{
					{SourcePath: touched, BackupPath: "snapshots/prev-snap/files/touched.txt.gz", Size: 10, ModTime: oldMod, Checksum: digestBytes([]byte("same-bytes")).SHA256},
				}}
				files := []backupFile{{sourcePath: touched, snapshotPath: "p/touched.txt", size: 10, modTime: newMod}}
				return newMockProvider(), files, nil, prev
			},
			wantVerifiedFiles: 1,
			wantVerifiedBytes: 10,
			wantFilesDone:     1,
			wantBytesDone:     10,
		},
		{
			// A read that fails is not a completed check: counting it would
			// show steady progress while every remaining file is re-uploaded.
			name: "resume: an unreadable journaled source is not counted",
			build: func(t *testing.T) (providers.BackupProvider, []backupFile, *snapshotJournal, *Snapshot) {
				dir := t.TempDir()
				journal, _, err := openSnapshotJournal(t.TempDir(), "verified-unreadable", journalMaxAge)
				if err != nil {
					t.Fatalf("openSnapshotJournal: %v", err)
				}
				good := createTempFile(t, dir, "good.txt", "hello")
				gone := filepath.Join(dir, "gone.txt") // journaled, then deleted
				for _, e := range []SnapshotFile{
					{SourcePath: good, BackupPath: "k/good", Size: 5, ModTime: oldMod, Checksum: digestBytes([]byte("hello")).SHA256},
					{SourcePath: gone, BackupPath: "k/gone", Size: 4, ModTime: oldMod, Checksum: digestBytes([]byte("gone")).SHA256},
				} {
					if err := journal.Record(e); err != nil {
						t.Fatal(err)
					}
				}
				files := []backupFile{
					{sourcePath: good, snapshotPath: "p/good.txt", size: 5, modTime: oldMod},
					{sourcePath: gone, snapshotPath: "p/gone.txt", size: 4, modTime: oldMod},
				}
				return newMockProvider(), files, journal, nil
			},
			wantVerifiedFiles: 1,
			wantVerifiedBytes: 5,
			wantFilesDone:     1, // gone.txt fails its upload and is skipped
			wantBytesDone:     5,
		},
		{
			// A snapshot continued from another job also reads each stored
			// object back (ContinueRun → VerifyStoredEntries).
			name: "continued snapshot: stored readbacks count, matched or not; a failed readback does not",
			build: func(t *testing.T) (providers.BackupProvider, []backupFile, *snapshotJournal, *Snapshot) {
				dir := t.TempDir()
				journal, _, err := openSnapshotJournal(t.TempDir(), "verified-continued", journalMaxAge)
				if err != nil {
					t.Fatalf("openSnapshotJournal: %v", err)
				}
				key := func(name string) string { return "snapshots/" + journal.snapshotID + "/files/" + name + ".gz" }
				p := &digestingMockProvider{mockProvider: newMockProvider(), digests: map[string]storedDigestAnswer{}}
				var files []backupFile
				for _, f := range []struct {
					name, content string
					answer        storedDigestAnswer
				}{
					{"intact", "aaaaa", storedDigestAnswer{digest: digestBytes([]byte("aaaaa"))}},
					{"overwritten", "bbbbbb", storedDigestAnswer{digest: digestBytes([]byte("other!"))}},
					{"unreachable", "ccccccc", storedDigestAnswer{err: errors.New("read session lost")}},
				} {
					src := createTempFile(t, dir, f.name, f.content)
					size := int64(len(f.content))
					if err := journal.Record(SnapshotFile{SourcePath: src, BackupPath: key(f.name), Size: size, ModTime: oldMod, Checksum: digestBytes([]byte(f.content)).SHA256}); err != nil {
						t.Fatal(err)
					}
					p.digests[key(f.name)] = f.answer
					files = append(files, backupFile{sourcePath: src, snapshotPath: "p/" + f.name, size: size, modTime: oldMod})
				}
				if err := journal.ContinueRun("a-later-job", "", false); err != nil {
					t.Fatal(err)
				}
				return p, files, journal, nil
			},
			wantVerifiedFiles: 2,
			wantVerifiedBytes: 11,
			wantFilesDone:     3,
			wantBytesDone:     18,
		},
		{
			name: "a file the resume pass already checked is not counted again by the dedupe pre-pass",
			build: func(t *testing.T) (providers.BackupProvider, []backupFile, *snapshotJournal, *Snapshot) {
				dir := t.TempDir()
				journal, _, err := openSnapshotJournal(t.TempDir(), "verified-once", journalMaxAge)
				if err != nil {
					t.Fatalf("openSnapshotJournal: %v", err)
				}
				src := createTempFile(t, dir, "edited.txt", "after")
				if err := journal.Record(SnapshotFile{SourcePath: src, BackupPath: "k/edited", Size: 5, ModTime: newMod, Checksum: digestBytes([]byte("befor")).SHA256}); err != nil {
					t.Fatal(err)
				}
				prev := &Snapshot{ID: "prev-snap", Files: []SnapshotFile{
					{SourcePath: src, BackupPath: "snapshots/prev-snap/files/edited.txt.gz", Size: 5, ModTime: oldMod, Checksum: digestBytes([]byte("befor")).SHA256},
				}}
				files := []backupFile{{sourcePath: src, snapshotPath: "p/edited.txt", size: 5, modTime: newMod}}
				return &plannerMockProvider{mockProvider: newMockProvider()}, files, journal, prev
			},
			wantVerifiedFiles: 1,
			wantVerifiedBytes: 5,
			wantFilesDone:     1,
			wantBytesDone:     5,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			provider, files, journal, prev := c.build(t)
			var mu sync.Mutex
			var got []RunProgress
			_, err := createSnapshotWithProgress(context.Background(), provider, files, func(p RunProgress) {
				mu.Lock()
				got = append(got, p)
				mu.Unlock()
			}, journal, prev, nil)
			if err != nil {
				t.Fatalf("createSnapshotWithProgress: %v", err)
			}
			mu.Lock()
			defer mu.Unlock()
			if len(got) == 0 {
				t.Fatal("no progress emissions")
			}
			last := got[len(got)-1]
			if last.VerifiedFiles != c.wantVerifiedFiles || last.VerifiedBytes != c.wantVerifiedBytes {
				t.Fatalf("final verified = %d files / %d bytes, want %d / %d", last.VerifiedFiles, last.VerifiedBytes, c.wantVerifiedFiles, c.wantVerifiedBytes)
			}
			// #5410: the done counters are unchanged by the verified ones.
			if last.FilesDone != c.wantFilesDone || last.BytesDone != c.wantBytesDone {
				t.Fatalf("final done = %d files / %d bytes, want %d / %d", last.FilesDone, last.BytesDone, c.wantFilesDone, c.wantBytesDone)
			}
			sawDuringPass := false
			for i, p := range got {
				if p.VerifiedFiles > 0 && p.FilesDone == 0 {
					sawDuringPass = true
				}
				if i == 0 {
					continue
				}
				prev := got[i-1]
				if p.VerifiedFiles < prev.VerifiedFiles || p.VerifiedBytes < prev.VerifiedBytes ||
					p.FilesDone < prev.FilesDone || p.BytesDone < prev.BytesDone {
					t.Fatalf("progress went backwards at emission %d: %+v -> %+v", i, prev, p)
				}
			}
			if c.wantVerifiedBeforeSeed && !sawDuringPass {
				t.Fatalf("no emission reported verified work while the pass was still running: %+v", got)
			}
		})
	}
}

// #11014: the resume pass can run for hours, so a stop (the reaper's
// backup_stop, a user cancel) must end it between files instead of being
// ignored until the first upload is admitted.
func TestCreateSnapshotWithProgress_StopDuringResumePass(t *testing.T) {
	restore := setProgressThrottleForTest(0)
	defer restore()

	mod := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	journal, _, err := openSnapshotJournal(t.TempDir(), "verified-stop", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal: %v", err)
	}
	var files []backupFile
	for _, name := range []string{"one.txt", "two.txt", "three.txt"} {
		p := createTempFile(t, dir, name, name)
		if err := journal.Record(SnapshotFile{SourcePath: p, BackupPath: "k/" + name, Size: int64(len(name)), ModTime: mod, Checksum: digestBytes([]byte(name)).SHA256}); err != nil {
			t.Fatal(err)
		}
		files = append(files, backupFile{sourcePath: p, snapshotPath: "p/" + name, size: int64(len(name)), modTime: mod})
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu sync.Mutex
	maxVerified := 0
	_, err = createSnapshotWithProgress(ctx, newMockProvider(), files, func(p RunProgress) {
		mu.Lock()
		defer mu.Unlock()
		maxVerified = max(maxVerified, p.VerifiedFiles)
		if p.VerifiedFiles == 1 {
			cancel()
		}
	}, journal, nil, nil)
	if !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if maxVerified != 1 {
		t.Fatalf("the pass checked %d files after the stop at 1; it must stop between files", maxVerified)
	}
}

// The dedupe pre-pass a brokered writer gets can hash for hours too: a stop
// ends it between files, and the partial plan is never handed to the writer.
func TestCreateSnapshotWithProgress_StopDuringDedupePrePass(t *testing.T) {
	restore := setProgressThrottleForTest(0)
	defer restore()

	oldMod := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	newMod := time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC)
	dir := t.TempDir()
	prev := &Snapshot{ID: "prev-snap"}
	var files []backupFile
	for _, name := range []string{"one.txt", "two.txt", "three.txt"} {
		src := createTempFile(t, dir, name, name)
		prev.Files = append(prev.Files, SnapshotFile{SourcePath: src, BackupPath: "snapshots/prev-snap/files/" + name + ".gz", Size: int64(len(name)), ModTime: oldMod, Checksum: digestBytes([]byte(name)).SHA256})
		files = append(files, backupFile{sourcePath: src, snapshotPath: "p/" + name, size: int64(len(name)), modTime: newMod})
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	provider := &plannerMockProvider{mockProvider: newMockProvider()}
	var mu sync.Mutex
	maxVerified := 0
	_, err := createSnapshotWithProgress(ctx, provider, files, func(p RunProgress) {
		mu.Lock()
		defer mu.Unlock()
		maxVerified = max(maxVerified, p.VerifiedFiles)
		if p.VerifiedFiles == 1 {
			cancel()
		}
	}, nil, prev, nil)
	if !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if maxVerified != 1 {
		t.Fatalf("the pre-pass hashed %d files after the stop at 1; it must stop between files", maxVerified)
	}
	if n := provider.prepared.Load(); n != 0 {
		t.Fatalf("PrepareUploads called %d times with a partial plan", n)
	}
}
