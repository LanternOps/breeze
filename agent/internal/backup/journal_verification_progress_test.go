package backup

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

// Where the resume pass's progress reporting (#11014) meets its verification
// records (#11043).

// An entry a record lets through without a read still counts as verified: a
// resume made of those would otherwise report no progress at all, and the
// server's no-transfer rule reaps it. Each source is rewritten keeping its size
// and mtime, so only a real skip reuses it: a re-hash would send it to upload.
func TestResumeVerify_RecordedEntriesStillCountAsVerified(t *testing.T) {
	restore := setProgressThrottleForTest(0)
	defer restore()

	cases := []struct {
		name      string
		continued bool
		check     storedObjectCheck
	}{
		{name: "same job: source hash skipped", continued: false, check: storedCheckNone},
		{name: "continued from another job: source hash and read-back skipped", continued: true, check: storedCheckOK},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := settledFile(t, t.TempDir(), "a.txt", "alpha")
			journal, _, err := openSnapshotJournal(t.TempDir(), "verified-recorded", journalMaxAge)
			if err != nil {
				t.Fatalf("openSnapshotJournal: %v", err)
			}
			entry := journaledEntry(t, src, journal.snapshotID, "alpha")
			if err := journal.Record(entry); err != nil {
				t.Fatal(err)
			}
			if tc.continued {
				if err := journal.ContinueRun("a-later-job", "", false); err != nil {
					t.Fatal(err)
				}
			}
			if err := journal.recordVerification(entry, journalVerification{
				StoredObjectCheck: tc.check,
				VerifiedAt:        time.Now().UTC().Add(-time.Hour),
				BaseGeneration:    journal.baseGeneration(),
			}); err != nil {
				t.Fatal(err)
			}
			rewriteKeepingStat(t, src, "omega")

			// No digests: a read-back would answer "missing" and force an upload.
			p := &digestingMockProvider{mockProvider: newMockProvider(), digests: map[string]storedDigestAnswer{}}
			p.files[entry.BackupPath] = []byte("alpha")

			var mu sync.Mutex
			var last RunProgress
			_, err = createSnapshotWithProgress(context.Background(), p, []backupFile{
				{sourcePath: src, snapshotPath: "p/a.txt", size: entry.Size, modTime: entry.ModTime},
			}, func(rp RunProgress) {
				mu.Lock()
				last = rp
				mu.Unlock()
			}, journal, nil, nil)
			if err != nil {
				t.Fatalf("createSnapshotWithProgress: %v", err)
			}
			if _, uploaded := p.uploads[entry.BackupPath]; uploaded {
				t.Fatal("the entry was uploaded again: the record was not what let it through")
			}
			mu.Lock()
			defer mu.Unlock()
			if last.VerifiedFiles != 1 || last.VerifiedBytes != entry.Size {
				t.Fatalf("verified = %d files / %d bytes, want 1 / %d", last.VerifiedFiles, last.VerifiedBytes, entry.Size)
			}
			if last.FilesDone != 1 || last.BytesDone != entry.Size {
				t.Fatalf("done = %d files / %d bytes, want 1 / %d", last.FilesDone, last.BytesDone, entry.Size)
			}
		})
	}
}

// A source that cannot be read is headed for an upload like a changed one, so it
// loses its record too, and the failed read is not progress.
func TestResumeVerify_UnreadableSourceLosesItsRecordAndIsNotCounted(t *testing.T) {
	restore := setProgressThrottleForTest(0)
	defer restore()

	src := settledFile(t, t.TempDir(), "a.txt", "alpha")
	journal, _, err := openSnapshotJournal(t.TempDir(), "verified-unreadable-record", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal: %v", err)
	}
	entry := journaledEntry(t, src, journal.snapshotID, "alpha")
	if err := journal.Record(entry); err != nil {
		t.Fatal(err)
	}
	// A failed verdict does not stand, so the pass has to read the source.
	if err := journal.recordVerification(entry, journalVerification{
		StoredObjectCheck: storedCheckMissing,
		VerifiedAt:        time.Now().UTC().Add(-time.Hour),
		BaseGeneration:    journal.baseGeneration(),
	}); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(src); err != nil {
		t.Fatal(err)
	}

	var mu sync.Mutex
	verified := 0
	_, _ = createSnapshotWithProgress(context.Background(), newMockProvider(), []backupFile{
		{sourcePath: src, snapshotPath: "p/a.txt", size: entry.Size, modTime: entry.ModTime},
	}, func(rp RunProgress) {
		mu.Lock()
		verified = max(verified, rp.VerifiedFiles)
		mu.Unlock()
	}, journal, nil, nil)

	if v, ok := journal.verifications[journalEntryKey(entry)]; ok {
		t.Fatalf("record survived an unreadable source: %+v", v)
	}
	mu.Lock()
	defer mu.Unlock()
	if verified != 0 {
		t.Fatalf("verified = %d, a failed read must not count", verified)
	}
}

// A stop part way through keeps what the pass already proved on disk, so the
// next job carries on instead of starting over. That is the point of the records
// (#11043), and the stop check (#11014) must not cost it.
func TestResumeVerify_StopMidPassKeepsTheRecordsAlreadyWritten(t *testing.T) {
	restore := setProgressThrottleForTest(0)
	defer restore()

	dir := t.TempDir()
	journal, _, err := openSnapshotJournal(t.TempDir(), "verified-stop-records", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal: %v", err)
	}
	var files []backupFile
	for _, name := range []string{"a.txt", "b.txt", "c.txt"} {
		src := settledFile(t, dir, name, "alpha")
		entry := journaledEntry(t, src, journal.snapshotID, "alpha")
		if err := journal.Record(entry); err != nil {
			t.Fatal(err)
		}
		files = append(files, backupFile{sourcePath: src, snapshotPath: "p/" + name, size: entry.Size, modTime: entry.ModTime})
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	_, err = createSnapshotWithProgress(ctx, newMockProvider(), files, func(rp RunProgress) {
		if rp.VerifiedFiles >= 1 {
			cancel()
		}
	}, journal, nil, nil)
	if !errors.Is(err, errBackupStopped) {
		t.Fatalf("err = %v, want errBackupStopped", err)
	}
	if got := len(journal.verifications); got != 1 {
		t.Fatalf("%d records in memory after a stop at the first file, want 1", got)
	}
	raw, err := os.ReadFile(journal.path)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(raw), `"verification":`); got != 1 {
		t.Fatalf("%d records on disk after a stop at the first file, want 1:\n%s", got, raw)
	}
}
