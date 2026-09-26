package backup

import (
	"bytes"
	"context"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// caseInsensitiveProvider models a case- and normalization-insensitive object
// store (MinIO bind-mounted on APFS/NTFS, or the local provider on a macOS or
// Windows vault) the way #5582 observed it: two keys that fold to the same
// string address ONE object, so the second upload silently replaces the
// first one's bytes. It wraps mockProvider and routes every key through a
// fold that is deliberately independent of the production foldObjectKey
// (plain strings.ToLower plus an NFD→NFC collapse of the one sequence the
// tests use), so the test cannot pass merely by agreeing with itself.
type caseInsensitiveProvider struct {
	*mockProvider
}

func testStoreFold(k string) string {
	// "e" + U+0301 COMBINING ACUTE ACCENT (NFD) and U+00E9 (NFC) name the
	// same file on APFS.
	return strings.ToLower(strings.ReplaceAll(k, "é", "é"))
}

func newCaseInsensitiveProvider() *caseInsensitiveProvider {
	return &caseInsensitiveProvider{mockProvider: newMockProvider()}
}

func (p *caseInsensitiveProvider) Upload(localPath, remotePath string) error {
	return p.mockProvider.Upload(localPath, testStoreFold(remotePath))
}

func (p *caseInsensitiveProvider) Download(remotePath, localPath string) error {
	return p.mockProvider.Download(testStoreFold(remotePath), localPath)
}

func (p *caseInsensitiveProvider) Delete(remotePath string) error {
	return p.mockProvider.Delete(testStoreFold(remotePath))
}

// assertEveryEntryRestoresItsOwnBytes downloads every content entry's
// BackupPath from provider and checks it returns exactly the bytes of that
// entry's own source file — the property #5582 broke.
func assertEveryEntryRestoresItsOwnBytes(t *testing.T, provider interface {
	Download(string, string) error
}, snap *Snapshot) {
	t.Helper()
	dir := t.TempDir()
	for i, f := range snap.Files {
		if !f.HasContent() {
			continue
		}
		want, err := os.ReadFile(f.SourcePath)
		if err != nil {
			t.Fatalf("read source %s: %v", f.SourcePath, err)
		}
		dst := filepath.Join(dir, strings.Repeat("x", i+1))
		if err := provider.Download(f.BackupPath, dst); err != nil {
			t.Fatalf("download %s: %v", f.BackupPath, err)
		}
		got, err := os.ReadFile(dst)
		if err != nil {
			t.Fatalf("read restored %s: %v", dst, err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("entry %s (key %s) restored %q, want its own bytes %q", f.SourcePath, f.BackupPath, got, want)
		}
	}
}

func twinFiles(t *testing.T) (dir string, upper, lower backupFile) {
	t.Helper()
	dir = t.TempDir()
	mod := time.Unix(1_700_000_000, 0)
	// Separate directories so both twins can exist on a case-insensitive
	// test host (macOS/Windows CI); only snapshotPath has to differ by case.
	a := createTempFileIn(t, filepath.Join(dir, "a"), "xt_CONNMARK.h", "upper-case twin, 199 bytes in the lab")
	b := createTempFileIn(t, filepath.Join(dir, "b"), "xt_connmark.h", "lower-case twin, 646")
	upper = backupFile{sourcePath: a, snapshotPath: "path_0/usr/include/linux/netfilter/xt_CONNMARK.h", size: fileSize(t, a), modTime: mod}
	lower = backupFile{sourcePath: b, snapshotPath: "path_0/usr/include/linux/netfilter/xt_connmark.h", size: fileSize(t, b), modTime: mod}
	return dir, upper, lower
}

func fileSize(t *testing.T, p string) int64 {
	t.Helper()
	info, err := os.Stat(p)
	if err != nil {
		t.Fatalf("stat %s: %v", p, err)
	}
	return info.Size()
}

func entryFor(t *testing.T, snap *Snapshot, sourcePath string) SnapshotFile {
	t.Helper()
	for _, f := range snap.Files {
		if f.SourcePath == sourcePath {
			return f
		}
	}
	t.Fatalf("no manifest entry for %s", sourcePath)
	return SnapshotFile{}
}

// #5582: case-only twins must land on distinct objects of a case-insensitive
// store, and the first twin (and every non-colliding file) must keep the
// exact key the pre-fix encoding produced, so nothing about existing
// snapshots or ordinary files changes.
func TestCreateSnapshot_CaseTwinsGetDistinctObjectsOnCaseInsensitiveStore(t *testing.T) {
	dir, upper, lower := twinFiles(t)
	other := createTempFileIn(t, filepath.Join(dir, "c"), "plain.txt", "unrelated")
	plain := backupFile{sourcePath: other, snapshotPath: "path_0/etc/plain.txt", size: fileSize(t, other), modTime: upper.modTime}

	provider := newCaseInsensitiveProvider()
	snap, err := CreateSnapshot(provider, []backupFile{upper, lower, plain})
	if err != nil {
		t.Fatalf("CreateSnapshot: %v", err)
	}
	assertEveryEntryRestoresItsOwnBytes(t, provider, snap)

	prefix := path.Join(snapshotRootDir, snap.ID, snapshotFilesDir)
	if got, want := entryFor(t, snap, upper.sourcePath).BackupPath, path.Join(prefix, upper.snapshotPath)+".gz"; got != want {
		t.Errorf("first twin key = %q, want the unchanged natural key %q", got, want)
	}
	if got, want := entryFor(t, snap, other).BackupPath, path.Join(prefix, plain.snapshotPath)+".gz"; got != want {
		t.Errorf("non-colliding key = %q, want the unchanged natural key %q", got, want)
	}
	twinKey := entryFor(t, snap, lower.sourcePath).BackupPath
	if !strings.HasPrefix(twinKey, snapshotRootDir+"/"+snap.ID+"/") {
		t.Errorf("disambiguated key %q must stay under the snapshot's own prefix (GC + reference detection key off it)", twinKey)
	}
	if !strings.HasSuffix(twinKey, ".gz") {
		t.Errorf("disambiguated key %q must keep the .gz suffix (the local provider compresses on it)", twinKey)
	}
}

// APFS is normalization-insensitive as well as case-insensitive: NFC "é"
// and NFD "e"+U+0301 are one file.
func TestCreateSnapshot_NormalizationTwinsGetDistinctObjects(t *testing.T) {
	dir := t.TempDir()
	mod := time.Unix(1_700_000_000, 0)
	a := createTempFileIn(t, filepath.Join(dir, "a"), "nfc", "nfc bytes")
	b := createTempFileIn(t, filepath.Join(dir, "b"), "nfd", "nfd bytes, longer")
	files := []backupFile{
		{sourcePath: a, snapshotPath: "path_0/café.txt", size: fileSize(t, a), modTime: mod},
		{sourcePath: b, snapshotPath: "path_0/café.txt", size: fileSize(t, b), modTime: mod},
	}
	provider := newCaseInsensitiveProvider()
	snap, err := CreateSnapshot(provider, files)
	if err != nil {
		t.Fatalf("CreateSnapshot: %v", err)
	}
	assertEveryEntryRestoresItsOwnBytes(t, provider, snap)
}

// A journal-resumed twin already owns its natural key in the store. A
// not-yet-uploaded twin that comes EARLIER in walk order must not claim a
// key that folds onto it — the resumed entries' keys are claimed before the
// loop starts.
func TestCreateSnapshot_ResumedTwinKeyIsClaimedBeforeNewUploads(t *testing.T) {
	_, upper, lower := twinFiles(t)
	journal, _, err := openSnapshotJournal(t.TempDir(), "case-twin-resume", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal: %v", err)
	}
	provider := newCaseInsensitiveProvider()
	upperKey := path.Join(snapshotRootDir, journal.snapshotID, snapshotFilesDir, upper.snapshotPath) + ".gz"
	if err := provider.Upload(upper.sourcePath, upperKey); err != nil {
		t.Fatalf("seed prior-run object: %v", err)
	}
	if err := journal.Record(SnapshotFile{
		SourcePath: upper.sourcePath, BackupPath: upperKey, Size: upper.size, ModTime: upper.modTime,
	}); err != nil {
		t.Fatalf("Record: %v", err)
	}

	// lower walks first, upper (resumed) second.
	snap, err := createSnapshotWithProgress(context.Background(), provider, []backupFile{lower, upper}, nil, journal, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	if got := entryFor(t, snap, upper.sourcePath).BackupPath; got != upperKey {
		t.Fatalf("resumed twin key = %q, want its journaled key %q", got, upperKey)
	}
	assertEveryEntryRestoresItsOwnBytes(t, provider, snap)
}

// A journal written by a pre-fix agent can hold BOTH twins at keys that fold
// together — on a case-insensitive store one object, holding whichever
// landed last. Neither can be trusted, so both are re-uploaded.
func TestCreateSnapshot_FoldCollidingResumedEntriesAreReuploaded(t *testing.T) {
	_, upper, lower := twinFiles(t)
	journal, _, err := openSnapshotJournal(t.TempDir(), "case-twin-legacy-journal", journalMaxAge)
	if err != nil {
		t.Fatalf("openSnapshotJournal: %v", err)
	}
	provider := newCaseInsensitiveProvider()
	for _, f := range []backupFile{upper, lower} {
		key := path.Join(snapshotRootDir, journal.snapshotID, snapshotFilesDir, f.snapshotPath) + ".gz"
		if err := provider.Upload(f.sourcePath, key); err != nil {
			t.Fatalf("seed legacy object: %v", err)
		}
		if err := journal.Record(SnapshotFile{SourcePath: f.sourcePath, BackupPath: key, Size: f.size, ModTime: f.modTime}); err != nil {
			t.Fatalf("Record: %v", err)
		}
	}

	snap, err := createSnapshotWithProgress(context.Background(), provider, []backupFile{upper, lower}, nil, journal, nil, nil)
	if err != nil {
		t.Fatalf("createSnapshotWithProgress: %v", err)
	}
	assertEveryEntryRestoresItsOwnBytes(t, provider, snap)
}

// An incremental run must not keep referencing a previous manifest's twin
// objects: on a case-insensitive store they are one object and one of the
// two entries is already corrupt. Both twins re-upload (and so self-heal
// the chain); an ordinary unchanged file still references.
func TestBuildPreviousIndex_ExcludesFoldCollidingKeys(t *testing.T) {
	_, upper, lower := twinFiles(t)
	dir := t.TempDir()
	plainPath := createTempFile(t, dir, "plain.txt", "unchanged")
	plain := backupFile{sourcePath: plainPath, snapshotPath: "path_0/plain.txt", size: fileSize(t, plainPath), modTime: upper.modTime}

	prevPrefix := path.Join(snapshotRootDir, "snapshot-prev", snapshotFilesDir)
	prev := &Snapshot{ID: "snapshot-prev", Files: []SnapshotFile{
		{SourcePath: upper.sourcePath, BackupPath: path.Join(prevPrefix, upper.snapshotPath) + ".gz", Size: upper.size, ModTime: upper.modTime},
		{SourcePath: lower.sourcePath, BackupPath: path.Join(prevPrefix, lower.snapshotPath) + ".gz", Size: lower.size, ModTime: lower.modTime},
		{SourcePath: plainPath, BackupPath: path.Join(prevPrefix, plain.snapshotPath) + ".gz", Size: plain.size, ModTime: plain.modTime},
	}}
	idx := buildPreviousIndex(prev)
	for _, f := range []backupFile{upper, lower} {
		if d, _ := decideFile(f, idx); d != decideUpload {
			t.Errorf("%s: decision = %v, want decideUpload (its previous object folds onto its twin's)", f.snapshotPath, d)
		}
	}
	if d, _ := decideFile(plain, idx); d != decideReference {
		t.Errorf("plain unchanged file: decision = %v, want decideReference", d)
	}
}

func TestFoldObjectKey(t *testing.T) {
	cases := []struct{ a, b string }{
		{"snapshots/s/files/path_0/xt_DSCP.ko.zst.gz", "snapshots/s/files/path_0/xt_dscp.ko.zst.gz"},
		{"snapshots/s/files/path_0/café.gz", "snapshots/s/files/path_0/CAFÉ.gz"},
		{"snapshots/s/files/path_0/STRASSE.gz", "snapshots/s/files/path_0/straße.gz"},
	}
	for _, c := range cases {
		if foldObjectKey(c.a) != foldObjectKey(c.b) {
			t.Errorf("foldObjectKey(%q) != foldObjectKey(%q); a case-insensitive store may treat them as one object", c.a, c.b)
		}
	}
	if foldObjectKey("snapshots/s/files/path_0/a.gz") == foldObjectKey("snapshots/s/files/path_0/b.gz") {
		t.Error("distinct names must not fold together")
	}
}

// The disambiguated key must never fold onto a natural key: every natural
// key's first segment under files/ is a walk root label (path_<n>).
func TestCaseTwinBackupPath_DisjointFromNaturalKeys(t *testing.T) {
	prefix := path.Join(snapshotRootDir, "snapshot-x")
	k1 := caseTwinBackupPath(prefix, "path_0/usr/xt_connmark.h")
	k2 := caseTwinBackupPath(prefix, "path_0/usr/xt_CONNMARK.h")
	if foldObjectKey(k1) == foldObjectKey(k2) {
		t.Fatalf("disambiguated keys for distinct snapshot paths fold together: %q %q", k1, k2)
	}
	rel := strings.TrimPrefix(k1, path.Join(prefix, snapshotFilesDir)+"/")
	if strings.HasPrefix(strings.ToLower(rel), "path_") {
		t.Fatalf("disambiguated key %q shares the natural-key namespace", k1)
	}
}

func createTempFileIn(t *testing.T, dir, name, content string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	return createTempFile(t, dir, name, content)
}
