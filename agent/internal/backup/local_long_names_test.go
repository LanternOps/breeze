package backup

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// #12799: #12722 moved a file whose natural key segment is over 255 bytes to
// a hashed key, and tested it against a store that caps a segment at 255
// bytes. The real local store wrote each object through a temporary name 35
// bytes longer than the object's, so a key leaf of 221 to 255 bytes, which
// keeps its natural key, still failed there on every run. This runs the same
// shape against the real local store.
func TestRunBackup_LocalStoreLongNamesBackUpVerifyAndRestore(t *testing.T) {
	restoreDelay := setUploadRetryDelayForTest(0)
	defer restoreDelay()

	// File names whose natural key leaf (name + ".gz") is the given size.
	ascii := func(leafBytes int) string { return strings.Repeat("k", leafBytes-len(".gz")) }
	names := map[string]string{
		"leaf-220":       ascii(220),
		"leaf-221":       ascii(221),
		"leaf-240":       ascii(240),
		"leaf-254":       ascii(250) + ".txt", // the issue's 251-character name
		"leaf-255":       ascii(255),
		"latin-leaf-255": strings.Repeat("é", 126), // 126 characters
		"cjk-leaf-255":   strings.Repeat("日", 84),  // 84 characters
		"emoji-leaf-255": strings.Repeat("😀", 63),  // 63 characters
		"short":          "short.txt",
	}
	// And names past the limit, which #12722 stores under files/long-names/.
	for label, name := range longLeafNames() {
		names["hashed-"+label] = name
	}

	src := t.TempDir()
	want := map[string]string{} // source path -> content
	natural := map[string]bool{}
	for label, name := range names {
		p := createTempFile(t, src, name, "content of "+label)
		want[p] = "content of " + label
		natural[p] = !strings.HasPrefix(label, "hashed-")
	}

	provider := privateTestLocalProvider(t, privateStoreTempDir(t))
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{src}, StagingDir: t.TempDir()})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.ErrorCount != 0 || job.Status != jobStatusCompleted {
		t.Fatalf("status=%q errorCount=%d warning=%q; every file must back up to a local store", job.Status, job.ErrorCount, job.Warning)
	}
	snap := job.Snapshot
	if snap == nil {
		t.Fatal("job carries no snapshot")
	}
	for p, isNatural := range natural {
		e := entryFor(t, snap, p)
		hashed := strings.Contains(e.BackupPath, "/"+longNameDir+"/")
		if isNatural == hashed {
			t.Errorf("%d-byte name: key %q, want natural=%v", len(path.Base(p)), e.BackupPath, isNatural)
		}
	}
	assertEveryEntryRestoresItsOwnBytes(t, provider, snap)

	items, err := provider.List(path.Join(snapshotRootDir, snap.ID))
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	for _, item := range items {
		if base := path.Base(item); strings.HasPrefix(base, ".") {
			t.Errorf("listing holds a temporary file %q", base)
		}
	}

	verify, err := VerifyIntegrity(provider, snap.ID)
	if err != nil {
		t.Fatalf("VerifyIntegrity: %v", err)
	}
	if verify.Status != "passed" || verify.FilesVerified != len(want) || verify.FilesFailed != 0 {
		t.Fatalf("verify status=%q verified=%d (want %d) failed=%v error=%q",
			verify.Status, verify.FilesVerified, len(want), verify.FailedFiles, verify.Error)
	}

	target := t.TempDir()
	result, err := RestoreFromSnapshot(provider, RestoreConfig{SnapshotID: snap.ID, TargetPath: target}, nil)
	if err != nil {
		t.Fatalf("RestoreFromSnapshot: %v", err)
	}
	if result.Status != "completed" || result.FilesRestored != len(want) {
		t.Fatalf("restore status=%q restored=%d (want %d) failed=%v warnings=%v",
			result.Status, result.FilesRestored, len(want), result.FailedFiles, result.Warnings)
	}
	for p, content := range want {
		got, err := os.ReadFile(resolveTargetPath(target, p))
		if err != nil {
			t.Errorf("%d-byte name not restored under its original name: %v", len(path.Base(p)), err)
			continue
		}
		if string(got) != content {
			t.Errorf("%d-byte name restored %q, want %q", len(path.Base(p)), got, content)
		}
	}
}

// failingLeafLocalProvider is the real local store, except that the upload
// of one source file is sent to a key whose leaf no filesystem accepts, so
// that file fails with a genuine operating-system error.
type failingLeafLocalProvider struct {
	*providers.LocalProvider
	failSource string

	mu        sync.Mutex
	failure   error
	failCalls int
}

func (p *failingLeafLocalProvider) UploadWithDigest(ctx context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	if localPath != p.failSource {
		return p.LocalProvider.UploadWithDigest(ctx, localPath, remotePath)
	}
	d, err := p.LocalProvider.UploadWithDigest(ctx, localPath, path.Dir(remotePath)+"/"+strings.Repeat("o", 253)+".gz")
	p.mu.Lock()
	p.failure, p.failCalls = err, p.failCalls+1
	p.mu.Unlock()
	return d, err
}

// A file the local store cannot write reaches the job's warning (which the
// server stores as the job's error log) with the store's full reason: the
// object and the operating system's error, not just "failed".
func TestRunBackup_LocalStoreUploadFailureReasonReachesJobWarning(t *testing.T) {
	restoreDelay := setUploadRetryDelayForTest(0)
	defer restoreDelay()

	src := t.TempDir()
	bad := createTempFile(t, src, strings.Repeat("M", 247)+".txt", "cannot be stored")
	createTempFile(t, src, "a.txt", "fine")

	provider := &failingLeafLocalProvider{
		LocalProvider: privateTestLocalProvider(t, privateStoreTempDir(t)),
		failSource:    bad,
	}
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{src}, StagingDir: t.TempDir()})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("a per-file failure must not fail the run: %v", err)
	}
	if job.Status != jobStatusPartial || job.ErrorCount != 1 {
		t.Fatalf("status=%q errorCount=%d warning=%q, want partial with 1 error", job.Status, job.ErrorCount, job.Warning)
	}
	if provider.failCalls == 0 || provider.failure == nil {
		t.Fatal("setup: the failing upload never ran")
	}
	var pathErr *fs.PathError
	var linkErr *os.LinkError
	if !errors.As(provider.failure, &pathErr) && !errors.As(provider.failure, &linkErr) {
		t.Fatalf("setup: the store's error carries no operating-system error: %v", provider.failure)
	}
	if !strings.Contains(job.Warning, bad) {
		t.Errorf("warning does not name the source file: %q", job.Warning)
	}
	if !strings.Contains(job.Warning, provider.failure.Error()) {
		t.Errorf("warning lost the store's reason %q: %q", provider.failure, job.Warning)
	}
}
