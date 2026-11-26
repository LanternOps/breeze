package backup

import (
	"context"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// segmentCappedProvider models an object store backed by a filesystem (MinIO
// on a disk, the local provider): it refuses any key with a '/'-separated
// segment longer than segmentCap bytes, or a key longer than keyCap bytes,
// the way #12692 observed MinIO answer a 255-character file name
// (XMinioInvalidObjectName). The limits are checked here by plain byte
// counts, independent of the production code, so the test cannot pass by
// agreeing with itself.
type segmentCappedProvider struct {
	*mockProvider
	segmentCap int
	keyCap     int
}

func newSegmentCappedProvider(segmentCap int) *segmentCappedProvider {
	return &segmentCappedProvider{mockProvider: newMockProvider(), segmentCap: segmentCap, keyCap: 1024}
}

func (p *segmentCappedProvider) Upload(localPath, remotePath string) error {
	if len(remotePath) > p.keyCap {
		return fmt.Errorf("storage answered status 400 (KeyTooLongError): key is %d bytes", len(remotePath))
	}
	for seg := range strings.SplitSeq(remotePath, "/") {
		if len(seg) > p.segmentCap {
			return fmt.Errorf("storage answered status 400 (XMinioInvalidObjectName): segment is %d bytes", len(seg))
		}
	}
	return p.mockProvider.Upload(localPath, remotePath)
}

// longLeafNames are file names at and just past the point where the natural
// key (name + ".gz") stops fitting a 255-byte segment, in ASCII and in
// multi-byte UTF-8 where the byte count runs well ahead of the character
// count.
func longLeafNames() map[string]string {
	return map[string]string{
		"ascii-253":  strings.Repeat("a", 253),
		"ascii-254":  strings.Repeat("b", 254),
		"ascii-255":  strings.Repeat("c", 255),
		"latin-255B": strings.Repeat("é", 127) + "x", // 128 characters, 255 bytes
		"cjk-255B":   strings.Repeat("日", 85),        // 85 characters, 255 bytes
		"emoji-253B": strings.Repeat("😀", 63) + "x",  // 64 characters, 253 bytes
	}
}

func TestLongLeafNamesFixture(t *testing.T) {
	for label, name := range longLeafNames() {
		if len(name) < 253 || len(name) > 255 {
			t.Errorf("%s: %d bytes, want 253..255 (the natural key segment must be 256..258)", label, len(name))
		}
		if strings.HasPrefix(label, "ascii") {
			continue
		}
		if utf8.RuneCountInString(name) >= len(name) {
			t.Errorf("%s: want a name whose bytes exceed its characters", label)
		}
	}
}

// #12692: files whose names are 253 to 255 bytes must be backed up on a
// store that caps a key segment at 255 bytes, and restore to their original
// names. A name whose natural key still fits keeps that exact key, so every
// file that backed up before keeps the key it always had.
func TestRunBackup_LongNamesBackUpAndRestoreOnSegmentCappedStore(t *testing.T) {
	restoreDelay := setUploadRetryDelayForTest(0)
	defer restoreDelay()

	src := t.TempDir()
	want := map[string]string{} // source path -> content
	for label, name := range longLeafNames() {
		p := createTempFile(t, src, name, "content of "+label)
		want[p] = "content of " + label
	}
	fits := createTempFile(t, src, strings.Repeat("f", 252), "natural key is exactly 255 bytes")
	want[fits] = "natural key is exactly 255 bytes"
	short := createTempFile(t, src, "short.txt", "short")
	want[short] = "short"

	provider := newSegmentCappedProvider(255)
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{src}, StagingDir: t.TempDir()})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("RunBackupContext: %v", err)
	}
	if job.ErrorCount != 0 || job.Status != jobStatusCompleted {
		t.Fatalf("status=%q errorCount=%d warning=%q; every long name must be backed up", job.Status, job.ErrorCount, job.Warning)
	}
	snap := job.Snapshot
	if snap == nil {
		t.Fatal("job carries no snapshot")
	}
	assertEveryEntryRestoresItsOwnBytes(t, provider, snap)

	// Files whose natural key fits keep it unchanged.
	for _, p := range []string{fits, short} {
		e := entryFor(t, snap, p)
		if strings.Contains(e.BackupPath, "/"+longNameDir+"/") {
			t.Errorf("%s: key %q moved off its natural key, which still fits", filepath.Base(p), e.BackupPath)
		}
		if !strings.HasSuffix(e.BackupPath, "/"+filepath.Base(p)+".gz") {
			t.Errorf("%s: key %q is not the natural key", filepath.Base(p), e.BackupPath)
		}
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
			t.Errorf("%d-byte name not restored under its original name: %v", len(filepath.Base(p)), err)
			continue
		}
		if string(got) != content {
			t.Errorf("%d-byte name restored %q, want %q", len(filepath.Base(p)), got, content)
		}
	}
}

// A directory segment can pass 255 bytes too: NTFS allows 255 UTF-16 units
// per name, which is up to 765 bytes of UTF-8. And a deep path can pass the
// 1024-byte key limit every object store shares even when each segment fits.
func TestCreateSnapshot_OverlongDirectoryAndKeyBackUpOnCappedStore(t *testing.T) {
	restoreDelay := setUploadRetryDelayForTest(0)
	defer restoreDelay()

	dir := t.TempDir()
	mod := time.Unix(1_700_000_000, 0)
	a := createTempFileIn(t, filepath.Join(dir, "a"), "f.txt", "under a 400-byte directory name")
	b := createTempFileIn(t, filepath.Join(dir, "b"), "g.txt", "under an 1100-byte path")
	deep := strings.TrimSuffix(strings.Repeat(strings.Repeat("d", 99)+"/", 11), "/")
	files := []backupFile{
		{sourcePath: a, snapshotPath: "path_0/" + strings.Repeat("é", 200) + "/f.txt", size: fileSize(t, a), modTime: mod},
		{sourcePath: b, snapshotPath: "path_0/" + deep + "/g.txt", size: fileSize(t, b), modTime: mod},
	}
	provider := newSegmentCappedProvider(255)
	snap, err := CreateSnapshot(provider, files)
	if err != nil {
		t.Fatalf("CreateSnapshot: %v", err)
	}
	if len(snap.UploadFailures) != 0 {
		t.Fatalf("upload failures: %v", snap.UploadFailures)
	}
	assertEveryEntryRestoresItsOwnBytes(t, provider, snap)
	for _, f := range snap.Files {
		if !strings.HasPrefix(f.BackupPath, snapshotRootDir+"/"+snap.ID+"/") {
			t.Errorf("key %q must stay under the snapshot's own prefix (GC and reference detection key off it)", f.BackupPath)
		}
		if !strings.HasSuffix(f.BackupPath, ".gz") {
			t.Errorf("key %q must keep the .gz suffix (the local provider compresses on it)", f.BackupPath)
		}
	}
}

// A file the store refuses even under the bounded key is reported by name
// in the job result and makes the job partial — never dropped silently.
func TestRunBackup_UnstorableLongNameIsReportedAndPartial(t *testing.T) {
	restoreDelay := setUploadRetryDelayForTest(0)
	defer restoreDelay()

	src := t.TempDir()
	long := strings.Repeat("z", 200) + ".txt"
	createTempFile(t, src, long, "cannot be stored here")
	createTempFile(t, src, "ok.txt", "fine")

	// 64-byte segments: every natural key segment of ok.txt fits, but neither
	// the long name nor any 64-hex-digit hashed name does.
	provider := newSegmentCappedProvider(64)
	mgr := NewBackupManager(BackupConfig{Provider: provider, Paths: []string{src}, StagingDir: t.TempDir()})
	job, err := mgr.RunBackupContext(context.Background(), nil)
	if err != nil {
		t.Fatalf("a per-file refusal must not fail the run: %v", err)
	}
	if job.Status != jobStatusPartial || job.ErrorCount != 1 {
		t.Fatalf("status=%q errorCount=%d, want partial with 1 error", job.Status, job.ErrorCount)
	}
	if !strings.Contains(job.Warning, long) {
		t.Fatalf("warning must name the file that could not be stored, got %q", job.Warning)
	}
	if job.FilesBackedUp != 1 {
		t.Fatalf("FilesBackedUp = %d, want 1", job.FilesBackedUp)
	}
}

func TestObjectKeyFitsStore(t *testing.T) {
	prefix := path.Join(snapshotRootDir, "snapshot-x", snapshotFilesDir)
	cases := []struct {
		key  string
		fits bool
	}{
		{prefix + "/path_0/" + strings.Repeat("a", 252) + ".gz", true},  // 255-byte segment
		{prefix + "/path_0/" + strings.Repeat("a", 253) + ".gz", false}, // 256-byte segment
		{prefix + "/path_0/" + strings.Repeat("é", 126) + ".gz", true},  // 255 bytes
		{prefix + "/path_0/" + strings.Repeat("é", 127) + ".gz", false}, // 257 bytes, 130 characters
		{prefix + "/path_0/" + strings.Repeat("é", 128) + "/x.gz", false},
		{prefix + "/" + strings.Repeat("d/", 600) + "x.gz", false}, // over 1024 bytes
	}
	for i, c := range cases {
		if got := objectKeyFitsStore(c.key); got != c.fits {
			t.Errorf("case %d (%d bytes): objectKeyFitsStore = %v, want %v", i, len(c.key), got, c.fits)
		}
	}
}

// The bounded key for an overlong name is injective over snapshot paths and
// shares no namespace with natural keys or case-twin keys.
func TestLongNameBackupPath_Disjoint(t *testing.T) {
	prefix := path.Join(snapshotRootDir, "snapshot-x")
	a := "path_0/" + strings.Repeat("a", 300)
	b := "path_0/" + strings.Repeat("a", 299) + "b"
	ka, kb := longNameBackupPath(prefix, a), longNameBackupPath(prefix, b)
	if ka == kb || foldObjectKey(ka) == foldObjectKey(kb) {
		t.Fatalf("distinct snapshot paths share a bounded key: %q %q", ka, kb)
	}
	if !objectKeyFitsStore(ka) {
		t.Fatalf("bounded key %q does not itself fit", ka)
	}
	if foldObjectKey(ka) == foldObjectKey(caseTwinBackupPath(prefix, a)) {
		t.Fatalf("bounded key collides with the case-twin key for the same path")
	}
	rel := strings.TrimPrefix(ka, path.Join(prefix, snapshotFilesDir)+"/")
	if strings.HasPrefix(strings.ToLower(rel), "path_") {
		t.Fatalf("bounded key %q shares the natural-key namespace", ka)
	}

	claims := objectKeyClaims{}
	natural := ensureGzipExtension(path.Join(prefix, snapshotFilesDir, a))
	if got := claims.assign(prefix, a, natural); got != ka {
		t.Fatalf("assign(%d-byte natural key) = %q, want the bounded key %q", len(natural), got, ka)
	}
}
