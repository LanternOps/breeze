package backup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// tempShapedSystemStateNames are system-state artifact paths whose leaf has
// the shape of a temporary upload file of this agent or an earlier one. A
// system-state artifact keeps its collected name with no ".gz" suffix, and
// the collector copies whole trees (all of /etc on Linux), so the store can
// hold an object with any of these names.
var tempShapedSystemStateNames = []string{
	".breeze-upload-ABCDEFGHIJKLMNOPQRSTUVWX27",     // the current form
	"etc/.breeze-upload-ABCDEFGHIJKLMNOPQRSTUVWX27", // the current form, deeper
	"etc/.bashrc.upload-123",                        // os.CreateTemp era
	"etc/.y.upload-ABCDEFGHIJKLMNOPQRSTUVWX27",      // rand.Text() era
	"etc/.a.gz.upload-1",                            // os.CreateTemp era, ".gz" stem
	"etc/.b.gz.upload-ABCDEFGHIJKLMNOPQRSTUVWX27",   // rand.Text() era, ".gz" stem
	"etc/.x.upload-notes",                           // the sweep before #12799
}

// stubTempShapedSystemState makes every collection return the artifacts in
// tempShapedSystemStateNames, each with its own content, from a fresh
// staging directory. It returns the content by artifact path.
func stubTempShapedSystemState(t *testing.T) map[string]string {
	t.Helper()
	content := map[string]string{}
	for _, name := range tempShapedSystemStateNames {
		content[name] = "system state object " + name
	}
	stubCollectSystemState(t, func() (*systemstate.SystemStateManifest, string, error) {
		dir := t.TempDir()
		m := &systemstate.SystemStateManifest{Platform: "test"}
		for _, name := range tempShapedSystemStateNames {
			p := filepath.Join(dir, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
				return nil, "", err
			}
			if err := os.WriteFile(p, []byte(content[name]), 0o600); err != nil {
				return nil, "", err
			}
			sum := sha256.Sum256([]byte(content[name]))
			m.Artifacts = append(m.Artifacts, systemstate.Artifact{
				Name: name, Category: "config", Path: name,
				SizeBytes: int64(len(content[name])), Checksum: hex.EncodeToString(sum[:]),
			})
		}
		return m, dir, nil
	})
	return content
}

// ageStore moves the modification time of every file in the store back by
// d, past the sweep's cutoff.
func ageStore(t *testing.T, store string, d time.Duration) {
	t.Helper()
	old := time.Now().Add(-d)
	err := filepath.WalkDir(store, func(p string, e fs.DirEntry, err error) error {
		if err != nil || e.IsDir() {
			return err
		}
		return os.Chtimes(p, old, old)
	})
	if err != nil {
		t.Fatal(err)
	}
}

// plantStaleUploadLeftover writes an aged temporary file of an interrupted
// upload under the snapshot's files/ tree and returns its path.
func plantStaleUploadLeftover(t *testing.T, store, snapshotID string) string {
	t.Helper()
	dir := filepath.Join(store, snapshotRootDir, snapshotID, snapshotFilesDir, "path_0")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	left := filepath.Join(dir, ".big.bin.gz.upload-999")
	if err := os.WriteFile(left, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	old := time.Now().Add(-48 * time.Hour)
	if err := os.Chtimes(left, old, old); err != nil {
		t.Fatal(err)
	}
	return left
}

// assertSystemStateObjectsIntact checks each object's bytes in the store,
// then reads the snapshot's system state the way a recovery does, which
// verifies every artifact against the published system-state manifest.
func assertSystemStateObjectsIntact(t *testing.T, store, snapshotID string, content map[string]string) {
	t.Helper()
	for name, want := range content {
		got, err := os.ReadFile(filepath.Join(store, snapshotRootDir, snapshotID, systemStateDir, filepath.FromSlash(name)))
		if err != nil {
			t.Errorf("stored system-state object %q is gone: %v", name, err)
			continue
		}
		if string(got) != want {
			t.Errorf("stored system-state object %q = %q, want %q", name, got, want)
		}
	}
	provider := privateTestLocalProvider(t, store)
	staging := t.TempDir()
	m, _, err := bmr.DownloadSystemState(context.Background(), provider, snapshotID, true, staging)
	if err != nil {
		t.Fatalf("reading the snapshot's system state: %v", err)
	}
	if len(m.Artifacts) != len(content) {
		t.Fatalf("system state lists %d artifacts, want %d", len(m.Artifacts), len(content))
	}
	for name, want := range content {
		got, err := os.ReadFile(filepath.Join(staging, filepath.FromSlash(name)))
		if err != nil || string(got) != want {
			t.Errorf("system-state artifact %q read back %q (%v), want %q", name, got, err, want)
		}
	}
}

// A run that published its snapshot but stopped before it removed its
// checkpoint journal is resumed by the next run, which finds the manifest
// already published and reports the snapshot without uploading anything.
// Nothing that run does may remove an object of the published snapshot:
// nothing would upload it again.
func TestRunBackup_LocalStoreResumeOfPublishedSnapshotKeepsEveryObject(t *testing.T) {
	restoreDelay := setUploadRetryDelayForTest(0)
	defer restoreDelay()
	content := stubTempShapedSystemState(t)

	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	store := privateStoreTempDir(t)
	cfg := BackupConfig{
		Provider: privateTestLocalProvider(t, store), Paths: []string{src}, StagingDir: staging,
		SystemStateEnabled: true, AgentID: testAgentID, JobID: testJobID,
	}

	// First run: publishes, then "stops" before the journal is removed.
	restoreRemove := setJournalRemoveFnForTest(func(string) error { return nil })
	first, err := NewBackupManager(cfg).RunBackupContext(context.Background(), nil)
	restoreRemove()
	if err != nil || first.Status != jobStatusCompleted || first.Snapshot == nil {
		t.Fatalf("first run: status=%q err=%v warning=%q", first.Status, err, first.Warning)
	}
	id := first.Snapshot.ID
	assertSystemStateObjectsIntact(t, store, id, content)

	// One to seven days later (the journal is still usable), the next run.
	ageStore(t, store, 48*time.Hour)
	left := plantStaleUploadLeftover(t, store, id)
	cfg.Provider = privateTestLocalProvider(t, store)
	second, err := NewBackupManager(cfg).RunBackupContext(context.Background(), nil)
	if err != nil || second.Status != jobStatusCompleted || second.Snapshot == nil {
		t.Fatalf("second run: status=%q err=%v warning=%q", second.Status, err, second.Warning)
	}
	if second.Snapshot.ID != id {
		t.Fatalf("setup: the second run did not resume the published snapshot (%s, want %s)", second.Snapshot.ID, id)
	}

	assertSystemStateObjectsIntact(t, store, id, content)
	// A published snapshot is not swept at all; its prefix delete removes
	// the leftover with the snapshot.
	if _, err := os.Stat(left); err != nil {
		t.Errorf("the resume of a published snapshot swept it: %v", err)
	}
	verify, err := VerifyIntegrity(privateTestLocalProvider(t, store), id)
	if err != nil || verify.Status != "passed" || verify.FilesVerified != 1 {
		t.Fatalf("VerifyIntegrity: status=%q verified=%d err=%v error=%q", verify.Status, verify.FilesVerified, err, verify.Error)
	}
}

// A resumed run of a snapshot that is not yet published sweeps the leftovers
// of the interrupted attempt's file uploads, and never touches an object the
// attempt stored under system-state/, whatever its name.
func TestRunBackup_LocalStoreResumeSweepsFileLeftoversOnly(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	store := privateStoreTempDir(t)
	provider := privateTestLocalProvider(t, store)
	base := ""
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{src}, StagingDir: staging, AgentID: testAgentID,
		JobID: testJobID, BaseSnapshotID: &base, PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour)})
	id := seedBoundJournal(t, staging, backupIdentity(provider, []string{src}), testJobID, "")

	// What the interrupted attempt stored under system-state/.
	planted := map[string]string{}
	for _, name := range tempShapedSystemStateNames {
		p := filepath.Join(store, snapshotRootDir, id, systemStateDir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
			t.Fatal(err)
		}
		planted[p] = "stored by the interrupted attempt: " + name
		if err := os.WriteFile(p, []byte(planted[p]), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	ageStore(t, store, 48*time.Hour)
	left := plantStaleUploadLeftover(t, store, id)

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot == nil || job.Snapshot.ID != id {
		t.Fatal("setup: run did not resume the journaled snapshot")
	}
	if _, err := os.Stat(left); !os.IsNotExist(err) {
		t.Error("stale temporary upload file left under the resumed snapshot's files/")
	}
	for p, want := range planted {
		got, err := os.ReadFile(p)
		if err != nil || string(got) != want {
			t.Errorf("system-state object %q: got %q (%v), want it kept intact", path.Base(filepath.ToSlash(p)), got, err)
		}
	}
}
