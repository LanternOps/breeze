package backup

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path"
	pathpkg "path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// A journaled entry is reused only when the current source still hashes to
// the recorded digest: a file rewritten with the same size and modification
// time is uploaded again, not carried forward with a digest that no longer
// describes it.
func TestResume_JournaledEntryWithChangedContentIsReuploaded(t *testing.T) {
	dir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	src := createTempFile(t, dir, "doc.txt", "AAAA")
	_ = os.Chtimes(src, modTime, modTime)
	journalDir := t.TempDir()
	j, _, err := openSnapshotJournal(journalDir, "identity-x", journalMaxAge)
	if err != nil {
		t.Fatal(err)
	}
	_ = j.BindRun("job-1", "")
	old := digestBytes([]byte("AAAA"))
	key := path.Join(snapshotRootDir, j.snapshotID, "files", "path_0", "doc.txt.gz")
	_ = j.Record(SnapshotFile{SourcePath: src, BackupPath: key, Size: 4, ModTime: modTime, Checksum: old.SHA256})
	j.Abandon()

	// Same size, same modification time, different content.
	if err := os.WriteFile(src, []byte("BBBB"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = os.Chtimes(src, modTime, modTime)

	j2, resumed, err := openSnapshotJournal(journalDir, "identity-x", journalMaxAge)
	if err != nil || !resumed {
		t.Fatalf("resume: %v %v", resumed, err)
	}
	backing := newMockProvider()
	p := &digestReportingProvider{mockProvider: backing}
	snap, err := createSnapshotWithProgress(context.Background(), p, []backupFile{{sourcePath: src, snapshotPath: "path_0/doc.txt", size: 4, modTime: modTime}}, nil, j2, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	if p.digestCalls == 0 {
		t.Fatal("changed file was not uploaded again")
	}
	want := digestBytes([]byte("BBBB"))
	if snap.Files[0].Checksum != want.SHA256 {
		t.Fatalf("entry checksum %s, want the current content's %s", snap.Files[0].Checksum, want.SHA256)
	}
}

func TestResume_JournaledEntryWithUnchangedContentIsReused(t *testing.T) {
	dir := t.TempDir()
	modTime := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	src := createTempFile(t, dir, "doc.txt", "AAAA")
	_ = os.Chtimes(src, modTime, modTime)
	journalDir := t.TempDir()
	j, _, _ := openSnapshotJournal(journalDir, "identity-x", journalMaxAge)
	_ = j.BindRun("job-1", "")
	key := path.Join(snapshotRootDir, j.snapshotID, "files", "path_0", "doc.txt.gz")
	_ = j.Record(SnapshotFile{SourcePath: src, BackupPath: key, Size: 4, ModTime: modTime, Checksum: digestBytes([]byte("AAAA")).SHA256})
	j.Abandon()

	j2, _, _ := openSnapshotJournal(journalDir, "identity-x", journalMaxAge)
	p := &digestReportingProvider{mockProvider: newMockProvider()}
	snap, err := createSnapshotWithProgress(context.Background(), p, []backupFile{{sourcePath: src, snapshotPath: "path_0/doc.txt", size: 4, modTime: modTime}}, nil, j2, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	if p.digestCalls != 1 { // the manifest only
		t.Fatalf("unchanged journaled file was uploaded again (%d digest uploads)", p.digestCalls)
	}
	if snap.Files[0].BackupPath != key {
		t.Fatal("journaled entry not reused")
	}
}

// reuploadFailsProvider stores the first upload of the live file, then
// changes the source (so it must be sent again) and refuses the second.
type reuploadFailsProvider struct {
	*digestReportingProvider
	src      string
	attempts int
}

func (p *reuploadFailsProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	if l != p.src {
		return p.digestReportingProvider.UploadWithDigest(ctx, l, r)
	}
	p.attempts++
	if p.attempts > 1 {
		return providers.UploadDigest{}, errors.New("upload refused")
	}
	d, err := p.digestReportingProvider.UploadWithDigest(ctx, l, r)
	_ = os.WriteFile(p.src, []byte("grown-content"), 0o644)
	future := time.Now().Add(2 * time.Second)
	_ = os.Chtimes(p.src, future, future)
	return d, err
}

func TestCreateSnapshot_FailedReuploadOfAChangingFileFailsTheFile(t *testing.T) {
	restore := setUploadRetryDelayForTest(time.Millisecond)
	defer restore()
	dir := t.TempDir()
	src := createTempFile(t, dir, "live.log", "start")
	other := createTempFile(t, dir, "ok.txt", "fine")
	p := &reuploadFailsProvider{digestReportingProvider: &digestReportingProvider{mockProvider: newMockProvider()}, src: src}
	now := time.Now()
	snap, err := createSnapshotWithProgress(context.Background(), p, []backupFile{
		{sourcePath: src, snapshotPath: "path_0/live.log", size: 5, modTime: now},
		{sourcePath: other, snapshotPath: "path_0/ok.txt", size: 4, modTime: now},
	}, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	for _, f := range snap.Files {
		if f.SourcePath == src {
			t.Fatalf("a file whose re-upload failed was kept in the manifest: %+v", f)
		}
	}
	if snap.IncompleteFiles != 1 || snap.IncompleteFilePaths[0] != src {
		t.Fatalf("file not recorded as incomplete: %d %v", snap.IncompleteFiles, snap.IncompleteFilePaths)
	}
}

func TestSweepStaleStagedCopies(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, age time.Duration) string {
		p := pathpkg.Join(dir, name)
		_ = os.WriteFile(p, []byte("x"), 0o600)
		old := time.Now().Add(-age)
		_ = os.Chtimes(p, old, old)
		return p
	}
	const deadPID = 0x7ffffff0
	ownOld := write(fmt.Sprintf("breeze-upload-%d-111", os.Getpid()), 30*24*time.Hour)
	deadStale := write(fmt.Sprintf("breeze-upload-%d-222", deadPID), 48*time.Hour)
	deadFresh := write(fmt.Sprintf("breeze-upload-%d-333", deadPID), time.Minute)
	noPIDRecent := write("breeze-upload-444", 48*time.Hour)
	noPIDOld := write("breeze-upload-555", 8*24*time.Hour)
	other := write("breeze-layout-666.json", 30*24*time.Hour)

	if n := sweepStaleStagedCopies(dir, 24*time.Hour); n != 2 {
		t.Fatalf("removed %d, want 2", n)
	}
	for _, p := range []string{deadStale, noPIDOld} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Fatalf("%s should have been removed", p)
		}
	}
	for _, p := range []string{ownOld, deadFresh, noPIDRecent, other} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s must be kept", p)
		}
	}
}

// A staged copy is named for the process that owns it, so another helper
// process never removes it while that process still runs.
func TestStagedCopyNameCarriesTheOwningProcess(t *testing.T) {
	path, _, err := stageCopy(context.Background(), t.TempDir(), createTempFile(t, t.TempDir(), "a.txt", "abc"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.Remove(path) }()
	if pid, ok := stagedCopyOwner(pathpkg.Base(path)); !ok || pid != os.Getpid() {
		t.Fatalf("staged copy %s does not name this process (pid %d ok %v)", pathpkg.Base(path), pid, ok)
	}
}

// A resumed run on a local destination removes temp upload files an
// interrupted attempt left under its snapshot prefix.
func TestRunBackupContext_ResumeSweepsStaleUploadTempFiles(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	store := t.TempDir()
	provider := providers.NewLocalProvider(store)
	base := ""
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{src}, StagingDir: staging, AgentID: testAgentID,
		JobID: testJobID, BaseSnapshotID: &base, PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour)})
	id := seedBoundJournal(t, staging, backupIdentity(provider, []string{src}), testJobID, "")
	leftDir := pathpkg.Join(store, "snapshots", id, "files", "path_0")
	_ = os.MkdirAll(leftDir, 0o755)
	left := pathpkg.Join(leftDir, ".big.bin.gz.upload-999")
	_ = os.WriteFile(left, []byte("partial"), 0o644)
	old := time.Now().Add(-48 * time.Hour)
	_ = os.Chtimes(left, old, old)

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID != id {
		t.Fatal("setup: run did not resume the journaled snapshot")
	}
	if _, err := os.Stat(left); !os.IsNotExist(err) {
		t.Fatal("stale temp upload file left in the resumed prefix")
	}
}

// notFoundDeleteProvider answers a delete of a missing key with the
// provider not-found error, as some SDKs do.
type notFoundDeleteProvider struct{ *digestReportingProvider }

func (p *notFoundDeleteProvider) Delete(key string) error {
	p.mu.Lock()
	_, ok := p.files[key]
	p.mu.Unlock()
	if !ok {
		return fmt.Errorf("%w: %s", providers.ErrObjectNotFound, key)
	}
	return p.digestReportingProvider.Delete(key)
}

func TestResume_ClearingAMissingControlObjectDoesNotWithholdTheAttestation(t *testing.T) {
	src := t.TempDir()
	createTempFile(t, src, "a.txt", "alpha")
	staging := t.TempDir()
	provider := &notFoundDeleteProvider{&digestReportingProvider{mockProvider: newMockProvider()}}
	base := ""
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{src}, StagingDir: staging, AgentID: testAgentID,
		JobID: testJobID, BaseSnapshotID: &base, PublishLeaseExpiresAt: time.Now().Add(4 * time.Hour)})
	id := seedBoundJournal(t, staging, backupIdentity(provider, []string{src}), testJobID, "")

	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.Snapshot.ID != id {
		t.Fatal("setup: run did not resume")
	}
	if strings.Contains(job.Warning, warnAttestationUnavailable) {
		t.Fatalf("a missing control object must not withhold the attestation: %q", job.Warning)
	}
	decodeAttestation(t, job)
}

func TestUploadWithDigest_PassesTheImmutableSourceMarkThrough(t *testing.T) {
	src := createTempFile(t, t.TempDir(), "db.bak", "bak")
	var sawImmutable bool
	p := &ctxRecordingDigestProvider{mockProvider: newMockProvider(), record: func(ctx context.Context) { sawImmutable = providers.IsImmutableSource(ctx) }}
	if _, err := UploadImmutableWithDigest(context.Background(), p, "", src, "k"); err != nil {
		t.Fatal(err)
	}
	if !sawImmutable {
		t.Fatal("the immutable-source mark did not reach the provider")
	}
}

type ctxRecordingDigestProvider struct {
	*mockProvider
	record func(context.Context)
}

func (p *ctxRecordingDigestProvider) UploadWithDigest(ctx context.Context, l, r string) (providers.UploadDigest, error) {
	p.record(ctx)
	return digestLocalFile(l)
}

func mustDigestFile(t *testing.T, p string) string {
	t.Helper()
	d, err := digestLocalFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return d.SHA256
}
