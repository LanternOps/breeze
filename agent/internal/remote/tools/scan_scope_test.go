package tools

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func writeScanFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func lstatT(t *testing.T, p string) fs.FileInfo {
	t.Helper()
	info, err := os.Lstat(p)
	if err != nil {
		t.Fatal(err)
	}
	return info
}

func skipWithoutSymlinks(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege Windows CI does not grant")
	}
}

// OpenFile judges the file where the handle really landed: a path that
// reaches a protected folder through a linked folder is not read.
func TestScanOpenFileChecksWhereTheHandleLanded(t *testing.T) {
	skipWithoutSymlinks(t)
	base := t.TempDir()
	secrets := protectedConfigFixture(t, filepath.Join(base, "agentcfg"))
	link := filepath.Join(base, "link")
	if err := os.Symlink(filepath.Dir(secrets), link); err != nil {
		t.Fatal(err)
	}
	f, err := NewScanScope().OpenFile(filepath.Join(link, "secrets.yaml"), nil)
	if f != nil {
		_ = f.Close()
	}
	if !errors.Is(err, ErrScanSkipped) {
		t.Fatalf("err = %v, want the file skipped", err)
	}
}

// OpenFile reads only the file the walk saw.
func TestScanOpenFileRefusesADifferentFileThanTheWalkSaw(t *testing.T) {
	dir := t.TempDir()
	a := filepath.Join(dir, "a.bin")
	b := filepath.Join(dir, "b.bin")
	writeScanFixture(t, a, "a")
	writeScanFixture(t, b, "b")
	f, err := NewScanScope().OpenFile(a, lstatT(t, b))
	if f != nil {
		_ = f.Close()
	}
	if !errors.Is(err, ErrScanSkipped) {
		t.Fatalf("err = %v, want the file skipped", err)
	}
	f, err = NewScanScope().OpenFile(a, lstatT(t, a))
	if err != nil {
		t.Fatalf("the walked file itself was refused: %v", err)
	}
	_ = f.Close()
}

// OpenFile does not follow a link at the leaf.
func TestScanOpenFileDoesNotFollowALinkAtTheLeaf(t *testing.T) {
	skipWithoutSymlinks(t)
	dir := t.TempDir()
	target := filepath.Join(dir, "ordinary.bin")
	writeScanFixture(t, target, "x")
	link := filepath.Join(dir, "link.bin")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	f, err := NewScanScope().OpenFile(link, nil)
	if f != nil {
		_ = f.Close()
	}
	if !errors.Is(err, ErrScanSkipped) {
		t.Fatalf("err = %v, want the link skipped", err)
	}
}

// Skip judges an entry at the root's canonical location too, so a root
// reached through a link still recognises a protected folder below it.
func TestScanSkipJudgesEntriesAtTheCanonicalRoot(t *testing.T) {
	skipWithoutSymlinks(t)
	base := t.TempDir()
	real := filepath.Join(base, "real")
	protectedConfigFixture(t, filepath.Join(real, "agentcfg"))
	alias := filepath.Join(base, "alias")
	if err := os.Symlink(real, alias); err != nil {
		t.Fatal(err)
	}
	s := NewScanScope()
	r, err := s.CheckRoot(alias)
	if err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(alias, "agentcfg")
	if !s.Skip(r, entry, lstatT(t, entry)) {
		t.Fatal("the protected folder below a linked root was not recognised")
	}
}

// The sensitive-data scan checks each opened file where it really is.
func TestSensitiveScanFileChecksWhereTheHandleLanded(t *testing.T) {
	skipWithoutSymlinks(t)
	base := t.TempDir()
	cfg := filepath.Join(base, "agentcfg")
	protectedConfigFixture(t, cfg)
	writeScanFixture(t, filepath.Join(cfg, "notes.txt"), "AKIA1234567890ABCDEF\n")
	link := filepath.Join(base, "link")
	if err := os.Symlink(cfg, link); err != nil {
		t.Fatal(err)
	}
	payload := map[string]any{"detectionClasses": []any{"credential"}}
	scope := parseSensitiveScope(payload)
	patterns := buildActiveSensitivePatterns(parseDetectionClasses(payload), scope)
	scanned, _, _, findings, _, _ := scanSensitiveFile(filepath.Join(link, "notes.txt"), patterns, scope)
	if scanned != 0 || len(findings) != 0 {
		t.Fatalf("a file in the protected folder was read: scanned=%d findings=%d", scanned, len(findings))
	}
}

// Scans treat the agent's data folder (Linux: /var/lib/breeze) as protected.
func TestScanTreatsAgentDataFolderAsProtected(t *testing.T) {
	for _, p := range []string{"/var/lib/breeze", "/var/lib/breeze/keys/pam-rules.key"} {
		if !NewScanScope().locationProtected(p, strings.HasSuffix(p, "breeze"), "") {
			t.Errorf("%s: scan did not treat the agent data folder as protected", p)
		}
	}
}

// fakeVolume makes every path at or below root report device dev, as if a
// separate volume were mounted there, and hides the mount table.
func fakeVolume(t *testing.T, root string, dev uint64) {
	t.Helper()
	canonical := root
	if resolved, ok := resolveForContainment(root); ok {
		canonical = resolved
	}
	// Without a mount table the scan compares devices instead.
	origTable := loadMountTable
	loadMountTable = func() ([]string, bool) { return nil, false }
	t.Cleanup(func() { loadMountTable = origTable })
	orig := scanDeviceOf
	scanDeviceOf = func(path string, info fs.FileInfo) (uint64, bool) {
		if path == canonical || strings.HasPrefix(path, canonical+string(filepath.Separator)) {
			return dev, true
		}
		return orig(path, info)
	}
	t.Cleanup(func() { scanDeviceOf = orig })
}

// A mounted volume is a volume root of its own: protected locations match at
// its top too, while folders that only share their names elsewhere do not.
func TestScanProtectsLocationsAtTheTopOfMountedVolumes(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("mounted folders are anchored by drive letter on Windows")
	}
	base := t.TempDir()
	vol := filepath.Join(base, "mnt", "oldroot")
	protectedFiles := []string{
		filepath.Join(vol, "etc", "shadow"),
		filepath.Join(vol, "Library", "Application Support", "Breeze", "secrets.yaml"),
		filepath.Join(vol, "var", "lib", "breeze", "keys", "pam-rules.key"),
	}
	scanned := []string{
		filepath.Join(vol, "srv", "etc", "shadow"),
		filepath.Join(base, "x", "etc", "shadow"),
		filepath.Join(vol, "home", "notes.txt"),
	}
	for _, p := range append(append([]string{}, protectedFiles...), scanned...) {
		writeScanFixture(t, p, "x")
	}
	fakeVolume(t, vol, 0xfeedface)

	s := NewScanScope()
	r, err := s.CheckRoot(base)
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range protectedFiles {
		if !s.Skip(r, p, lstatT(t, p)) {
			t.Errorf("%s: not recognised at the top of its volume", p)
		}
		f, err := s.OpenFile(p, lstatT(t, p))
		if f != nil {
			_ = f.Close()
		}
		if !errors.Is(err, ErrScanSkipped) {
			t.Errorf("%s: OpenFile err = %v, want skipped", p, err)
		}
	}
	for _, p := range scanned {
		if s.Skip(r, p, lstatT(t, p)) {
			t.Errorf("%s: skipped, but it is not at the top of a volume", p)
		}
	}
	dir := filepath.Join(vol, "etc")
	if _, err := s.CheckRoot(filepath.Join(vol, "etc", "shadow")); err == nil {
		t.Error("a protected file at the top of a mounted volume was accepted as a root")
	}
	if _, err := s.CheckRoot(dir); err != nil {
		t.Errorf("an ordinary folder on a mounted volume was refused as a root: %v", err)
	}
}

// When the protected-file identities could not all be recorded, a file with
// several names cannot be cleared, so it is refused.
func TestIncompleteIdentitySetRefusesMultiLinkedFiles(t *testing.T) {
	protectedConfigFixture(t, filepath.Join(t.TempDir(), "agentcfg"))
	origCap := maxProtectedIdentityEntries
	maxProtectedIdentityEntries = 0
	t.Cleanup(func() { maxProtectedIdentityEntries = origCap })

	dir := t.TempDir()
	orig := filepath.Join(dir, "a.txt")
	writeScanFixture(t, orig, "hello\n")
	link := filepath.Join(dir, "b.txt")
	if err := os.Link(orig, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	ids := collectProtectedIdentities()
	if ids.complete {
		t.Fatal("identity set reported complete although nothing below the folders was recorded")
	}
	f, err := os.Open(link)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if !isOtherNameOfProtectedFile(f, func() protectedIdentitySet { return ids }) {
		t.Fatal("a multi-linked file was cleared against an incomplete identity set")
	}
	single := filepath.Join(dir, "c.txt")
	writeScanFixture(t, single, "x")
	g, err := os.Open(single)
	if err != nil {
		t.Fatal(err)
	}
	defer g.Close()
	if isOtherNameOfProtectedFile(g, func() protectedIdentitySet { return ids }) {
		t.Fatal("a single-link file was refused")
	}
}

// A file whose identity cannot be read is treated as protected.
func TestUnreadableIdentityIsTreatedAsProtected(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.txt")
	writeScanFixture(t, p, "x")
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	orig := openFileIdentity
	openFileIdentity = func(*os.File) (fileIdentity, uint32, error) { return fileIdentity{}, 0, errors.New("unavailable") }
	t.Cleanup(func() { openFileIdentity = orig })
	if !isOtherNameOfProtectedFile(f, func() protectedIdentitySet { return protectedIdentitySet{complete: true} }) {
		t.Fatal("a file with an unreadable identity was cleared")
	}
}

// Each protected folder is walked once, even when the configured folder and
// a default location are the same or nested.
func TestProtectedFoldersAreWalkedOnce(t *testing.T) {
	in := []string{"/a/b", "/a", "/c", "/a/", "/c/d", "/e"}
	for i := range in {
		in[i] = filepath.FromSlash(in[i])
	}
	got := uniqueOuterDirs(in)
	if filepath.ToSlash(strings.Join(got, ",")) != "/a,/c,/e" {
		t.Fatalf("folders = %v", got)
	}
}

// Another name of a key in the agent's data folder is refused like another
// name of its configuration files.
func TestReadFileRefusesOtherNameOfAgentKey(t *testing.T) {
	protectedConfigFixture(t, filepath.Join(t.TempDir(), "agentcfg"))
	data := filepath.Join(t.TempDir(), "data")
	key := filepath.Join(data, "keys", "pam-rules.key")
	writeScanFixture(t, key, "key")
	orig := agentDataDirFunc
	agentDataDirFunc = func() string { return data }
	t.Cleanup(func() { agentDataDirFunc = orig })

	link := filepath.Join(t.TempDir(), "notes.txt")
	if err := os.Link(key, link); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	if result := ReadFile(map[string]any{"path": link}); result.Status != "failed" {
		t.Fatalf("status=%s, want a refusal", result.Status)
	}
}
