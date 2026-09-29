package backup

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	pathpkg "path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/layout"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/backup/systemstate"
)

// mutatingUploadProvider has no digest support. Its Upload runs a hook
// before reading localPath, so a test can change the ORIGINAL source while
// the upload is in flight.
type mutatingUploadProvider struct {
	*mockProvider
	beforeRead func(localPath, remotePath string)
}

func (p *mutatingUploadProvider) Upload(localPath, remotePath string) error {
	if p.beforeRead != nil {
		p.beforeRead(localPath, remotePath)
	}
	return p.mockProvider.Upload(localPath, remotePath)
}

func TestUploadWithDigest_WithoutProviderSupportUploadsAnImmutableCopy(t *testing.T) {
	dir := t.TempDir()
	src := createTempFile(t, dir, "src.txt", "original bytes")
	backing := newMockProvider()
	p := &mutatingUploadProvider{mockProvider: backing, beforeRead: func(_, _ string) {
		// The source changes after staging, while the upload is in flight.
		if err := os.WriteFile(src, []byte("rewritten while uploading"), 0o644); err != nil {
			t.Error(err)
		}
	}}
	stagingDir := t.TempDir()

	d, err := uploadWithDigest(context.Background(), p, stagingDir, src, "snapshots/s/files/src.txt.gz")
	if err != nil {
		t.Fatalf("uploadWithDigest: %v", err)
	}
	stored := backing.files["snapshots/s/files/src.txt.gz"]
	if string(stored) != "original bytes" {
		t.Fatalf("stored %q, want the bytes staged before the source changed", stored)
	}
	if d != digestBytes(stored) {
		t.Fatalf("digest %+v does not describe the stored bytes %+v", d, digestBytes(stored))
	}
	if strings.HasPrefix(backing.uploadCalls[0].localPath, dir) {
		t.Fatal("the provider was handed the live source instead of a staged copy")
	}
	if entries, _ := os.ReadDir(stagingDir); len(entries) != 0 {
		t.Fatalf("staged copy left behind: %v", entries)
	}
}

// digestReportingProvider reports a digest itself and records whether the
// plain upload path was used.
type digestReportingProvider struct {
	*mockProvider
	digestErr    error
	digestCalls  int
	reportDigest providers.UploadDigest
}

func (p *digestReportingProvider) UploadWithDigest(_ context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	p.digestCalls++
	if p.digestErr != nil {
		return providers.UploadDigest{}, p.digestErr
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		return providers.UploadDigest{}, err
	}
	p.mu.Lock()
	p.files[remotePath] = data
	p.mu.Unlock()
	if p.reportDigest.SHA256 != "" {
		return p.reportDigest, nil
	}
	return digestBytes(data), nil
}

func TestUploadWithDigest_UsesTheProviderDigest(t *testing.T) {
	src := createTempFile(t, t.TempDir(), "a.txt", "abc")
	want := providers.UploadDigest{SHA256: strings.Repeat("d", 64), Size: 3}
	p := &digestReportingProvider{mockProvider: newMockProvider(), reportDigest: want}
	got, err := uploadWithDigest(context.Background(), p, "", src, "k")
	if err != nil {
		t.Fatalf("uploadWithDigest: %v", err)
	}
	if got != want || p.digestCalls != 1 || len(p.uploadCalls) != 0 {
		t.Fatalf("provider digest not used: got %+v, digestCalls=%d, plain uploads=%d", got, p.digestCalls, len(p.uploadCalls))
	}
}

func TestUploadWithDigest_DigestUnavailableFallsBackToStagedCopy(t *testing.T) {
	src := createTempFile(t, t.TempDir(), "a.txt", "abc")
	p := &digestReportingProvider{mockProvider: newMockProvider(), digestErr: fmt.Errorf("%w: test", providers.ErrDigestUnavailable)}
	got, err := uploadWithDigest(context.Background(), p, "", src, "k")
	if err != nil {
		t.Fatalf("uploadWithDigest: %v", err)
	}
	if len(p.uploadCalls) != 1 || got != digestBytes([]byte("abc")) {
		t.Fatalf("want one staged upload with the staged digest, got calls=%d digest=%+v", len(p.uploadCalls), got)
	}
}

func TestUploadWithDigest_OtherProviderErrorsAreNotRetriedAsStaging(t *testing.T) {
	src := createTempFile(t, t.TempDir(), "a.txt", "abc")
	p := &digestReportingProvider{mockProvider: newMockProvider(), digestErr: errors.New("access denied")}
	if _, err := uploadWithDigest(context.Background(), p, "", src, "k"); err == nil || len(p.uploadCalls) != 0 {
		t.Fatalf("want the provider error returned without a staged retry, got err=%v calls=%d", err, len(p.uploadCalls))
	}
}

func TestLeaseGate_ForwardsDigestUploadsAndStillFencesManifests(t *testing.T) {
	src := createTempFile(t, t.TempDir(), "a.txt", "abc")
	inner := &digestReportingProvider{mockProvider: newMockProvider()}
	live := &leaseGate{BackupProvider: inner, publishLeaseExpiresAt: time.Now().Add(3 * time.Hour)}
	var du providers.DigestUploader = live
	if _, err := du.UploadWithDigest(context.Background(), src, "snapshots/s/manifest.json"); err != nil {
		t.Fatalf("within the lease: %v", err)
	}
	if inner.digestCalls != 1 {
		t.Fatal("leaseGate did not forward the digest upload")
	}
	expired := &leaseGate{BackupProvider: inner, publishLeaseExpiresAt: time.Now().Add(30 * time.Minute)}
	if _, err := uploadWithDigest(context.Background(), expired, "", src, "snapshots/s/manifest.json"); !errors.Is(err, ErrPublishLeaseExpired) {
		t.Fatalf("want ErrPublishLeaseExpired past the lease, got %v", err)
	}
	// Without digest support underneath, nothing is uploaded by the gate
	// itself and the staged copy still passes the fence.
	plain := &leaseGate{BackupProvider: newMockProvider(), publishLeaseExpiresAt: time.Now().Add(30 * time.Minute)}
	if _, err := uploadWithDigest(context.Background(), plain, "", src, "snapshots/s/manifest.json"); !errors.Is(err, ErrPublishLeaseExpired) {
		t.Fatalf("staged path must be fenced too, got %v", err)
	}
}

func storedDigest(t *testing.T, m *mockProvider, key string) providers.UploadDigest {
	t.Helper()
	m.mu.Lock()
	defer m.mu.Unlock()
	data, ok := m.files[key]
	if !ok {
		t.Fatalf("nothing stored at %s", key)
	}
	return digestBytes(data)
}

// Every regular entry's Size/Checksum is the digest of the stored object.
func TestCreateSnapshot_EntriesDescribeTheStoredObjects(t *testing.T) {
	for _, withDigest := range []bool{false, true} {
		t.Run(fmt.Sprintf("providerDigest=%v", withDigest), func(t *testing.T) {
			dir := t.TempDir()
			now := time.Now()
			files := []backupFile{
				{sourcePath: createTempFile(t, dir, "a.txt", "alpha"), snapshotPath: "path_0/a.txt", size: 5, modTime: now},
				{sourcePath: createTempFile(t, dir, "b.txt", "bravo!"), snapshotPath: "path_0/b.txt", size: 6, modTime: now},
			}
			backing := newMockProvider()
			var p providers.BackupProvider = backing
			if withDigest {
				p = &digestReportingProvider{mockProvider: backing}
			}
			snap, err := createSnapshotWithProgress(context.Background(), p, files, nil, nil, nil, nil)
			if err != nil {
				t.Fatalf("createSnapshotWithProgress: %v", err)
			}
			for _, f := range snap.Files {
				d := storedDigest(t, backing, f.BackupPath)
				if f.Checksum != d.SHA256 || f.Size != d.Size {
					t.Fatalf("%s: entry %s/%d, stored %s/%d", f.SourcePath, f.Checksum, f.Size, d.SHA256, d.Size)
				}
			}
		})
	}
}

// A source that keeps changing across the upload and its one retry: the
// entry is Volatile, and still describes exactly what the key holds.
func TestCreateSnapshot_VolatileEntryDescribesTheStoredObject(t *testing.T) {
	dir := t.TempDir()
	src := createTempFile(t, dir, "live.log", "start")
	backing := newMockProvider()
	grows := 0
	var mu sync.Mutex
	p := &growAfterReadProvider{mockProvider: backing, after: func() {
		mu.Lock()
		defer mu.Unlock()
		grows++
		f, err := os.OpenFile(src, os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = f.WriteString("-more")
		_ = f.Close()
		future := time.Now().Add(time.Duration(grows) * time.Second)
		_ = os.Chtimes(src, future, future)
	}}
	files := []backupFile{{sourcePath: src, snapshotPath: "path_0/live.log", size: 5, modTime: time.Now()}}
	snap, err := createSnapshotWithProgress(context.Background(), p, files, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	e := snap.Files[0]
	if !e.Volatile {
		t.Fatal("a source that changed across the retry must be recorded volatile")
	}
	d := storedDigest(t, backing, e.BackupPath)
	if e.Checksum != d.SHA256 || e.Size != d.Size {
		t.Fatalf("volatile entry %s/%d does not describe the stored object %s/%d", e.Checksum, e.Size, d.SHA256, d.Size)
	}
	live, _ := os.ReadFile(src)
	if int64(len(live)) == e.Size {
		t.Fatal("test did not exercise a source that moved on after the stored upload")
	}
}

// growAfterReadProvider reports digests and changes the source right after
// reading it, as a live log does.
type growAfterReadProvider struct {
	*mockProvider
	after func()
}

func (p *growAfterReadProvider) UploadWithDigest(_ context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	data, err := os.ReadFile(localPath)
	if err != nil {
		return providers.UploadDigest{}, err
	}
	p.mu.Lock()
	p.files[remotePath] = data
	p.mu.Unlock()
	if strings.Contains(remotePath, "/files/") {
		p.after()
	}
	return digestBytes(data), nil
}

func TestCreateSnapshot_PreUploadStatFailureStillRecordsTheUploadDigest(t *testing.T) {
	src := createTempFile(t, t.TempDir(), "a.txt", "alpha")
	old := statBeforeUpload
	statBeforeUpload = func(string) (filePreUploadMeasurement, error) {
		return filePreUploadMeasurement{}, errors.New("stat failed")
	}
	defer func() { statBeforeUpload = old }()
	backing := newMockProvider()
	p := &digestReportingProvider{mockProvider: backing}
	snap, err := createSnapshotWithProgress(context.Background(), p, []backupFile{{sourcePath: src, snapshotPath: "path_0/a.txt", size: 5, modTime: time.Now()}}, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	e := snap.Files[0]
	if e.Checksum == "" || e.Checksum != storedDigest(t, backing, e.BackupPath).SHA256 {
		t.Fatalf("entry checksum %q must be the upload digest", e.Checksum)
	}
}

// failingDigestProvider fails every upload of one source (a read error part
// way through the stream) and stores the rest.
type failingDigestProvider struct {
	*digestReportingProvider
	failBase string
	attempts map[string]int
	secondOK bool
	onRetry  func()
}

func (p *failingDigestProvider) UploadWithDigest(ctx context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	if pathpkg.Base(localPath) == p.failBase {
		p.attempts[localPath]++
		if !p.secondOK || p.attempts[localPath] == 1 {
			if p.onRetry != nil {
				p.onRetry()
			}
			return providers.UploadDigest{}, errors.New("read error part way through the stream")
		}
	}
	return p.digestReportingProvider.UploadWithDigest(ctx, localPath, remotePath)
}

func TestCreateSnapshot_FailedUploadIsAbsentAndNoEntryLacksAChecksum(t *testing.T) {
	restore := setUploadRetryDelayForTest(time.Millisecond)
	defer restore()
	dir := t.TempDir()
	now := time.Now()
	good := createTempFile(t, dir, "good.txt", "good")
	bad := createTempFile(t, dir, "bad.txt", "bad!")
	backing := newMockProvider()
	p := &failingDigestProvider{digestReportingProvider: &digestReportingProvider{mockProvider: backing}, failBase: "bad.txt", attempts: map[string]int{}}
	snap, err := createSnapshotWithProgress(context.Background(), p, []backupFile{
		{sourcePath: good, snapshotPath: "path_0/good.txt", size: 4, modTime: now},
		{sourcePath: bad, snapshotPath: "path_0/bad.txt", size: 4, modTime: now},
	}, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	if len(snap.Files) != 1 || snap.Files[0].SourcePath != good {
		t.Fatalf("want only the good file in the manifest, got %+v", snap.Files)
	}
	if snap.IncompleteFiles != 1 || len(snap.IncompleteFilePaths) != 1 || snap.IncompleteFilePaths[0] != bad {
		t.Fatalf("failed file not recorded as incomplete: %d %v", snap.IncompleteFiles, snap.IncompleteFilePaths)
	}
	manifestKey := pathpkg.ToSlash(pathpkg.Join("snapshots", snap.ID, "manifest.json"))
	var published Snapshot
	if err := jsonUnmarshalStored(backing, manifestKey, &published); err != nil {
		t.Fatal(err)
	}
	for _, f := range published.Files {
		if f.HasContent() && f.Checksum == "" {
			t.Fatalf("published manifest has a regular entry without a checksum: %+v", f)
		}
	}
}

func TestCreateSnapshot_RetriedUploadRecordsTheSuccessfulAttempt(t *testing.T) {
	restore := setUploadRetryDelayForTest(time.Millisecond)
	defer restore()
	src := createTempFile(t, t.TempDir(), "flaky.txt", "first")
	backing := newMockProvider()
	p := &failingDigestProvider{
		digestReportingProvider: &digestReportingProvider{mockProvider: backing},
		failBase:                "flaky.txt",
		attempts:                map[string]int{},
		secondOK:                true,
		onRetry: func() {
			// Between the failed attempt and the retry the source changes.
			_ = os.WriteFile(src, []byte("second"), 0o644)
		},
	}
	snap, err := createSnapshotWithProgress(context.Background(), p, []backupFile{{sourcePath: src, snapshotPath: "path_0/flaky.txt", size: 5, modTime: time.Now()}}, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	e := snap.Files[0]
	want := digestBytes([]byte("second"))
	if e.Checksum != want.SHA256 || e.Size != want.Size {
		t.Fatalf("entry %s/%d, want the successful retry's digest %s/%d", e.Checksum, e.Size, want.SHA256, want.Size)
	}
}

func jsonUnmarshalStored(m *mockProvider, key string, v any) error {
	m.mu.Lock()
	data, ok := m.files[key]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("nothing stored at %s", key)
	}
	return jsonUnmarshal(data, v)
}

// Every control object the run publishes is recorded with the digest of the
// bytes stored under its key.
func TestCreateSnapshot_PublishedControlObjectsCarryUploadDigests(t *testing.T) {
	dir := t.TempDir()
	stagingDir := t.TempDir()
	artifact := createTempFile(t, stagingDir, "hosts", "127.0.0.1 localhost\n")
	ssm := &systemstate.SystemStateManifest{
		Platform:  "test",
		Artifacts: []systemstate.Artifact{{Name: "hosts", Category: "config", Path: "hosts", SizeBytes: int64(len("127.0.0.1 localhost\n"))}},
	}
	_ = artifact
	backing := newMockProvider()
	p := &digestReportingProvider{mockProvider: backing}
	files := []backupFile{{sourcePath: createTempFile(t, dir, "a.txt", "alpha"), snapshotPath: "path_0/a.txt", size: 5, modTime: time.Now()}}
	snap, err := createSnapshotWithProgress(context.Background(), p, files, nil, nil, nil, nil,
		withSystemState(stagingDir, ssm), withLayout(&layout.Manifest{}))
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	for _, role := range []string{AttestationRoleManifest, AttestationRoleLayout, AttestationRoleSystemStateManifest} {
		obj, ok := snap.PublishedObjects[role]
		if !ok {
			t.Fatalf("no published object recorded for %s", role)
		}
		wantKey, _ := ControlObjectKey(snap.ID, role)
		if obj.Key != wantKey || obj.Role != role {
			t.Fatalf("%s recorded as %+v, want key %s", role, obj, wantKey)
		}
		d := storedDigest(t, backing, wantKey)
		if obj.SHA256 != d.SHA256 || obj.Size != d.Size {
			t.Fatalf("%s recorded %s/%d, stored %s/%d", role, obj.SHA256, obj.Size, d.SHA256, d.Size)
		}
	}
}

// The recorder keeps the LAST successful publish per role, so a manifest
// published twice is described by its final upload.
func TestPublishSnapshotManifest_RepublishRecordsTheFinalUpload(t *testing.T) {
	backing := newMockProvider()
	rec := newControlRecorder(nil)
	snap := &Snapshot{ID: "snapshot-20260101T000000Z-aaaaaaaa", Timestamp: time.Unix(0, 0).UTC(), Files: []SnapshotFile{}}
	if _, err := publishSnapshotManifest(context.Background(), backing, "", rec, snap); err != nil {
		t.Fatal(err)
	}
	first := rec.objects[AttestationRoleManifest]
	snap.Files = append(snap.Files, SnapshotFile{SourcePath: "/x", BackupPath: "snapshots/" + snap.ID + "/files/x.gz", Size: 1, Checksum: strings.Repeat("a", 64)})
	if _, err := publishSnapshotManifest(context.Background(), backing, "", rec, snap); err != nil {
		t.Fatal(err)
	}
	final := rec.objects[AttestationRoleManifest]
	if final == first {
		t.Fatal("republish did not replace the recorded manifest")
	}
	if d := storedDigest(t, backing, final.Key); d.SHA256 != final.SHA256 || d.Size != final.Size {
		t.Fatal("recorded manifest digest is not the final upload's")
	}
}

func jsonUnmarshal(data []byte, v any) error { return json.Unmarshal(data, v) }
