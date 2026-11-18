package backup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

var errInjectedJournalCreate = errors.New("injected: no space left on device")

// failJournalRestarts makes every restart of a journal fail to create its new
// file until the test ends. Opening a journal is not affected.
func failJournalRestarts(t *testing.T) (restore func()) {
	t.Helper()
	restore = setJournalRestartCreateFnForTest(func(string, string, string) (*snapshotJournal, bool, error) {
		return nil, false, errInjectedJournalCreate
	})
	t.Cleanup(restore)
	return restore
}

// openResumedJournalWithRecord returns a resumed journal holding one entry and
// one verification record, as a run sees it right after opening.
func openResumedJournalWithRecord(t *testing.T, dir string) (*snapshotJournal, SnapshotFile) {
	t.Helper()
	const identity = "restart-identity"
	j, _, err := openSnapshotJournal(dir, identity, journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	if err := j.BindRun("job-old", "base-old"); err != nil {
		t.Fatal(err)
	}
	entry := SnapshotFile{SourcePath: "/src/a.txt", BackupPath: "snapshots/x/files/a.txt", Size: 5,
		ModTime: time.Unix(1700000000, 0).UTC(), Checksum: digestBytes([]byte("alpha")).SHA256}
	if err := j.Record(entry); err != nil {
		t.Fatal(err)
	}
	if err := j.recordVerification(entry, journalVerification{}); err != nil {
		t.Fatal(err)
	}
	j.Abandon()

	j, resumed, err := openSnapshotJournal(dir, identity, journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(j.Abandon)
	if !resumed || len(j.entries) != 1 || len(j.verifications) != 1 {
		t.Fatalf("setup: resumed=%v entries=%d verifications=%d", resumed, len(j.entries), len(j.verifications))
	}
	j.continuedFromOtherJob = true
	j.createdAt = j.createdAt.Add(-48 * time.Hour)
	return j, entry
}

// assertNoResumeState pins what a journal holds after a failed restart: nothing
// a later reader could act on, and no way to add to it.
func assertNoResumeState(t *testing.T, j *snapshotJournal, oldID string, entry SnapshotFile) {
	t.Helper()
	if _, ok := j.Lookup(entry.SourcePath, entry.Size, entry.ModTime); ok {
		t.Error("Lookup still finds a discarded entry")
	}
	if len(j.entries) != 0 {
		t.Errorf("entries = %d, want none", len(j.entries))
	}
	if len(j.verifications) != 0 {
		t.Errorf("verifications = %d, want none", len(j.verifications))
	}
	if j.resumed {
		t.Error("journal still reports resumed")
	}
	if j.ContinuedFromOtherJob() {
		t.Error("journal still reports continuing another job's snapshot")
	}
	if age := j.Age(); age > time.Hour {
		t.Errorf("Age = %s still measures the discarded journal", age)
	}
	if got := j.ResumedBytes(); got != 0 {
		t.Errorf("ResumedBytes = %d, want 0", got)
	}
	if j.snapshotID == oldID {
		t.Errorf("journal still names the discarded snapshot %s", oldID)
	}
	if h := j.Header(); h.JobID != "" || h.DispatchedBaseSnapshotID != "" || h.SnapshotID != j.snapshotID {
		t.Errorf("header still carries the discarded run: %+v", h)
	}

	// A later append is refused: there is no file behind the journal, and it
	// must not grow in-memory state that no file backs.
	if err := j.Record(entry); err == nil {
		t.Error("Record succeeded on a journal with no file")
	}
	if err := j.recordVerification(entry, journalVerification{}); err == nil {
		t.Error("recordVerification succeeded on a journal with no file")
	}
	if err := j.StartAttempt(); err == nil {
		t.Error("a header update succeeded on a journal with no file")
	}
	if _, ok := j.Lookup(entry.SourcePath, entry.Size, entry.ModTime); ok {
		t.Error("a refused Record still added an in-memory entry")
	}
	if len(j.verifications) != 0 {
		t.Error("a refused recordVerification still added an in-memory record")
	}
}

// A real create failure rather than the seam: a directory sits where the new
// journal file must go.
func TestRestartFresh_RealCreateFailureLeavesNoResumeState(t *testing.T) {
	for _, tc := range []struct {
		name, issued string
	}{
		{"minted id", ""},
		{"issued id", brokeredIssuedID},
	} {
		t.Run(tc.name, func(t *testing.T) {
			j, entry := openResumedJournalWithRecord(t, t.TempDir())
			oldID := j.snapshotID
			_ = j.file.Close()
			if err := os.Remove(j.path); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(j.path, 0o700); err != nil {
				t.Fatal(err)
			}

			err := j.restartFreshWithID(tc.issued)
			if err == nil {
				t.Fatal("restart succeeded with a directory at the journal path")
			}
			if !errors.Is(err, errJournalUnusable) {
				t.Errorf("error %v is not errJournalUnusable, so a run cannot tell checkpointing is off", err)
			}
			if tc.issued != "" && j.snapshotID != tc.issued {
				t.Errorf("snapshot id = %s, want the issued %s", j.snapshotID, tc.issued)
			}
			assertNoResumeState(t, j, oldID, entry)
		})
	}
}

func TestBindRun_FailedRestartIsReportedAndLeavesNoResumeState(t *testing.T) {
	j, entry := openResumedJournalWithRecord(t, t.TempDir())
	oldID := j.snapshotID
	failJournalRestarts(t)

	err := j.BindRun("job-new", "")
	if !errors.Is(err, errJournalUnusable) || !errors.Is(err, errInjectedJournalCreate) {
		t.Fatalf("BindRun error = %v, want errJournalUnusable wrapping the create failure", err)
	}
	if j.DiscardedOtherRun() != "" {
		t.Errorf("reported a discard (%q) that did not complete", j.DiscardedOtherRun())
	}
	assertNoResumeState(t, j, oldID, entry)
}

// A write of the new journal's header that fails after the truncate leaves an
// empty file. The next open must start afresh rather than find old state.
func TestRestartFresh_TruncatingFailureDoesNotResumeNextRun(t *testing.T) {
	dir := t.TempDir()
	j, _ := openResumedJournalWithRecord(t, dir)
	oldID := j.snapshotID
	restore := setJournalRestartCreateFnForTest(func(p, _, _ string) (*snapshotJournal, bool, error) {
		if err := os.Truncate(p, 0); err != nil {
			t.Fatal(err)
		}
		return nil, false, errInjectedJournalCreate
	})
	defer restore()

	if err := j.BindRun("job-new", ""); err == nil {
		t.Fatal("BindRun succeeded")
	}
	j.Abandon()

	next, resumed, err := openSnapshotJournal(dir, "restart-identity", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	defer next.Abandon()
	if resumed || next.snapshotID == oldID || len(next.entries) != 0 {
		t.Fatalf("next open: resumed=%v id=%s entries=%d", resumed, next.snapshotID, len(next.entries))
	}
}

func TestRunBackupContext_FailedJournalRestartDisablesCheckpointing(t *testing.T) {
	setup := func(t *testing.T) (*mockProvider, *BackupManager, string) {
		src := t.TempDir()
		createTempFile(t, src, "a.txt", "alpha")
		staging := t.TempDir()
		provider := newMockProvider()
		mgr := serverOwnedManager(t, provider, []string{src}, "")
		mgr.config.StagingDir = staging
		identity := backupIdentity(provider, []string{src})
		seedBrokeredJournal(t, staging, identity, brokeredJournalID, brokeredOtherJob, "",
			journaledEntry(t, pathpkg.Join(src, "a.txt"), brokeredJournalID, "alpha"))
		journalDir, ok := resolveJournalDir(staging)
		if !ok {
			t.Fatal("no journal dir")
		}
		return provider, mgr, pathpkg.Join(journalDir, journalFileName(identity))
	}

	t.Run("runs under a new snapshot and uploads what the discarded journal recorded", func(t *testing.T) {
		provider, mgr, journalPath := setup(t)
		before, err := os.ReadFile(journalPath)
		if err != nil {
			t.Fatal(err)
		}
		failJournalRestarts(t)

		job, err := mgr.RunBackupContext(context.Background(), nil)
		if err != nil {
			t.Fatalf("a failed checkpoint must not fail the backup: %v", err)
		}
		if job.Status != jobStatusCompleted {
			t.Fatalf("status = %q", job.Status)
		}
		if job.Snapshot.ID == brokeredJournalID {
			t.Fatal("the run wrote into the snapshot it was discarding")
		}
		if !strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
			t.Fatalf("warning %q does not carry %s", job.Warning, warnJournalCheckpointingDisabled)
		}
		if strings.Contains(job.Warning, warnJournalDiscardedOtherRun) {
			t.Errorf("warning %q reports a discard that did not complete", job.Warning)
		}
		stored := false
		for _, f := range job.Snapshot.Files {
			if !strings.HasPrefix(f.BackupPath, path.Join(snapshotRootDir, job.Snapshot.ID)+"/") {
				t.Errorf("file %s is outside the new snapshot %s", f.BackupPath, job.Snapshot.ID)
			}
			if strings.Contains(f.BackupPath, "a.txt") {
				provider.mu.Lock()
				_, stored = provider.files[f.BackupPath]
				provider.mu.Unlock()
			}
		}
		if !stored {
			t.Fatal("a.txt was not uploaded under the new snapshot")
		}
		after, err := os.ReadFile(journalPath)
		if err != nil {
			t.Fatal(err)
		}
		if string(after) != string(before) {
			t.Errorf("a run without checkpointing changed the journal:\n%s", after)
		}
		decodeAttestation(t, job)
	})

	t.Run("does not adopt the discarded snapshot's published manifest", func(t *testing.T) {
		provider, mgr, _ := setup(t)
		manifest := Snapshot{ID: brokeredJournalID, Timestamp: time.Now().UTC(), Files: []SnapshotFile{}}
		data, _ := json.Marshal(&manifest)
		provider.mu.Lock()
		provider.files[path.Join(snapshotRootDir, brokeredJournalID, snapshotManifestKey)] = data
		provider.mu.Unlock()
		failJournalRestarts(t)

		job, err := mgr.RunBackupContext(context.Background(), nil)
		if err != nil {
			t.Fatalf("RunBackupContext: %v", err)
		}
		if job.Snapshot.ID == brokeredJournalID {
			t.Fatal("the run adopted a snapshot published for another run")
		}
		if !strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
			t.Fatalf("warning %q does not carry %s", job.Warning, warnJournalCheckpointingDisabled)
		}
	})

	t.Run("the next run restarts normally once the disk recovers", func(t *testing.T) {
		_, mgr, _ := setup(t)
		restore := failJournalRestarts(t)
		if _, err := mgr.RunBackupContext(context.Background(), nil); err != nil {
			t.Fatalf("RunBackupContext: %v", err)
		}
		restore()

		job, err := mgr.RunBackupContext(context.Background(), nil)
		if err != nil {
			t.Fatalf("RunBackupContext: %v", err)
		}
		if strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
			t.Errorf("warning %q carried over to a run with a working journal", job.Warning)
		}
		if !strings.Contains(job.Warning, warnJournalDiscardedOtherRun) {
			t.Errorf("warning %q does not report the discard that now completed", job.Warning)
		}
	})

	t.Run("a journal that needs no restart still resumes", func(t *testing.T) {
		src := t.TempDir()
		createTempFile(t, src, "a.txt", "alpha")
		staging := t.TempDir()
		provider := newMockProvider()
		mgr := serverOwnedManager(t, provider, []string{src}, "")
		mgr.config.StagingDir = staging
		entry := journaledEntry(t, pathpkg.Join(src, "a.txt"), brokeredJournalID, "alpha")
		provider.mu.Lock()
		provider.files[entry.BackupPath] = []byte("alpha")
		provider.mu.Unlock()
		seedBrokeredJournal(t, staging, backupIdentity(provider, []string{src}), brokeredJournalID, testJobID, "", entry)
		failJournalRestarts(t) // never reached: same job, same base

		job, err := mgr.RunBackupContext(context.Background(), nil)
		if err != nil {
			t.Fatalf("RunBackupContext: %v", err)
		}
		if job.Snapshot.ID != brokeredJournalID {
			t.Fatalf("same job must resume %s, got %s", brokeredJournalID, job.Snapshot.ID)
		}
		if strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
			t.Errorf("warning %q on a run whose journal never restarted", job.Warning)
		}
		reused := false
		for _, f := range job.Snapshot.Files {
			reused = reused || f.BackupPath == entry.BackupPath
		}
		if !reused {
			t.Errorf("the journaled entry was not reused: %+v", job.Snapshot.Files)
		}
	})
}

func TestBrokeredRun_FailedJournalRestartDisablesCheckpointing(t *testing.T) {
	cases := []struct {
		name string
		// seedID, seedJob and seedBase describe the journal on disk.
		seedID, seedJob, seedBase string
		resume                    func(string) (providers.ResumeMode, error)
		wantResumeAsked           bool
	}{
		{
			name:   "control plane refused the journal's snapshot",
			seedID: brokeredJournalID, seedJob: brokeredOtherJob,
			resume:          func(string) (providers.ResumeMode, error) { return 0, providers.ErrSnapshotNotResumable },
			wantResumeAsked: true,
		},
		{
			name:   "journal written for another dispatched base",
			seedID: brokeredJournalID, seedJob: testJobID, seedBase: "snapshot-20260101T000000Z-aaaaaaaaaaaaaaaaaaaaaaaa",
		},
		{
			// The brokered path that only logged: the id already matches, so
			// BindRun's restart was the only one, and its failure left the
			// other job's entries in force under the issued id.
			name:   "journal under the issued id written for another job",
			seedID: brokeredIssuedID, seedJob: brokeredOtherJob,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			src := t.TempDir()
			createTempFile(t, src, "a.txt", "alpha")
			staging := t.TempDir()
			p := newFakeIssuer(brokeredIssuedID)
			p.resume = tc.resume
			entry := journaledEntry(t, pathpkg.Join(src, "a.txt"), tc.seedID, "alpha")
			seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), tc.seedID, tc.seedJob, tc.seedBase, entry)
			// The entry's object exists, so a run that kept the entry would
			// reuse it instead of uploading.
			p.backing.files[entry.BackupPath] = []byte("alpha")
			journalDir, ok := resolveJournalDir(staging)
			if !ok {
				t.Fatal("no journal dir")
			}
			journalPath := pathpkg.Join(journalDir, journalFileName(backupIdentity(p, []string{src})))
			before, err := os.ReadFile(journalPath)
			if err != nil {
				t.Fatal(err)
			}
			restore := failJournalRestarts(t)

			job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
			if err != nil {
				t.Fatalf("a failed checkpoint must not fail the backup: %v", err)
			}
			if job.Snapshot.ID != brokeredIssuedID {
				t.Fatalf("snapshot id = %s, want the issued %s", job.Snapshot.ID, brokeredIssuedID)
			}
			if !strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
				t.Fatalf("warning %q does not carry %s", job.Warning, warnJournalCheckpointingDisabled)
			}
			if strings.Contains(job.Warning, warnJournalDiscardedOtherRun) {
				t.Errorf("warning %q reports a discard that did not complete", job.Warning)
			}
			uploaded := false
			for _, k := range p.uploadedKeys() {
				if strings.HasPrefix(k, path.Join(snapshotRootDir, brokeredIssuedID)+"/") && strings.Contains(k, "a.txt") {
					uploaded = true
				}
			}
			if !uploaded {
				t.Fatalf("a.txt was not uploaded under the issued snapshot: %v", p.uploadedKeys())
			}
			after, err := os.ReadFile(journalPath)
			if err != nil {
				t.Fatal(err)
			}
			if string(after) != string(before) {
				t.Errorf("a run without checkpointing changed the journal:\n%s", after)
			}
			asked := false
			for _, e := range p.eventList() {
				if strings.HasPrefix(e, "resume:") {
					asked = true
				}
			}
			if asked != tc.wantResumeAsked {
				t.Errorf("asked to resume = %v, want %v: %v", asked, tc.wantResumeAsked, p.eventList())
			}

			// Once the disk recovers the next run gets the journal lock back
			// and completes the discard.
			restore()
			next, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
			if err != nil {
				t.Fatalf("next run: %v", err)
			}
			if strings.Contains(next.Warning, warnJournalCheckpointingDisabled) {
				t.Errorf("next run's warning %q carries %s", next.Warning, warnJournalCheckpointingDisabled)
			}
			if !strings.Contains(next.Warning, warnJournalDiscardedOtherRun) {
				t.Errorf("next run's warning %q does not report the discard that now completed", next.Warning)
			}
		})
	}
}

// BindRun's failed restart ends the journal for this run. Trying again under the
// issued id could succeed and bury the failure: no warning, and a discard the job
// never reports.
func TestBrokeredRun_FailedBindRunRestartIsNotRetried(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	p := newFakeIssuer(brokeredIssuedID)
	seedBrokeredJournal(t, staging, backupIdentity(p, []string{src}), brokeredIssuedID, brokeredOtherJob, "")
	creates := 0
	defer setJournalRestartCreateFnForTest(func(journalPath, identity, snapshotID string) (*snapshotJournal, bool, error) {
		creates++
		if creates == 1 {
			return nil, false, errInjectedJournalCreate
		}
		return createFreshJournalWithID(journalPath, identity, snapshotID)
	})()

	job, err := brokeredManager(p, src, staging, testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if creates != 1 {
		t.Errorf("restart attempted %d times, want 1", creates)
	}
	if !strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
		t.Fatalf("warning %q does not carry %s", job.Warning, warnJournalCheckpointingDisabled)
	}
}

func TestBrokeredRun_FailedRestartOfAFreshJournalDisablesCheckpointing(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	p := newFakeIssuer(brokeredIssuedID)
	failJournalRestarts(t)

	job, err := brokeredManager(p, src, t.TempDir(), testJobID).RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID != brokeredIssuedID {
		t.Fatalf("snapshot id = %s, want the issued %s", job.Snapshot.ID, brokeredIssuedID)
	}
	if !strings.Contains(job.Warning, warnJournalCheckpointingDisabled) {
		t.Fatalf("warning %q does not carry %s", job.Warning, warnJournalCheckpointingDisabled)
	}
}
