package security

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// agentConfigFixture points the agent configuration directory at a fresh
// folder holding secrets.yaml and returns both paths.
func agentConfigFixture(t *testing.T, dir string) (cfgDir, secrets string) {
	t.Helper()
	secrets = filepath.Join(dir, "secrets.yaml")
	writeFixture(t, secrets, "auth_token: test")
	restore := config.SetConfigDirForTest(dir)
	t.Cleanup(restore)
	return dir, secrets
}

func scannedBases(m *recordingMatcher) []string {
	var out []string
	for _, p := range m.scanned() {
		out = append(out, filepath.Base(p))
	}
	return out
}

// A root spelled differently from the protected folder but naming the same
// folder (case-insensitive volumes fold some letters together) is still the
// protected folder.
func TestScanRefusesAnotherSpellingOfProtectedRoot(t *testing.T) {
	base := t.TempDir()
	agentConfigFixture(t, filepath.Join(base, "Breeze-secrets"))
	alias := filepath.Join(base, "Breeze-ſecrets")
	if _, err := os.Stat(alias); err != nil {
		t.Skip("this volume does not fold the alternative spelling")
	}

	m := &recordingMatcher{}
	if _, err := walkAndMatch(context.Background(), []string{alias}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	if got := m.scanned(); len(got) != 0 {
		t.Fatalf("the protected folder was read through another spelling: %v", got)
	}
	s := &SecurityScanner{}
	if _, err := s.ScanWithContext(context.Background(), "custom", []string{alias}); err == nil {
		t.Fatal("custom scan accepted another spelling of the protected folder")
	}
}

// A root reached through a linked ancestor is judged where it really is.
func TestScanSkipsProtectedFolderBelowLinkedAncestor(t *testing.T) {
	requireSymlinks(t)
	base := t.TempDir()
	agentConfigFixture(t, filepath.Join(base, "real", "Library", "Application Support", "Breeze"))
	writeFixture(t, filepath.Join(base, "real", "Library", "Application Support", "normal.txt"), "x")
	alias := filepath.Join(base, "A")
	if err := os.Symlink(filepath.Join(base, "real", "Library"), alias); err != nil {
		t.Fatal(err)
	}
	m := &recordingMatcher{}
	if _, err := walkAndMatch(context.Background(), []string{filepath.Join(alias, "Application Support")}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	if got := scannedBases(m); len(got) != 1 || got[0] != "normal.txt" {
		t.Fatalf("files read = %v, want only normal.txt", got)
	}
}

// Folders that merely carry the name of a protected location somewhere
// other than where that location lives are scanned like any other folder;
// only files whose own names mark them as credential stores are skipped.
func TestScanReadsFoldersNamedLikeProtectedLocations(t *testing.T) {
	root := t.TempDir()
	want := []string{
		".env/lib/site-packages/evil.py",
		"Cookies/evil.bin",
		"Local State/evil.bin",
		"x/etc/breeze/evil.bin",
		"x/Library/Keychains/evil.bin",
		"x/ProgramData/Breeze/evil.exe",
		"normal.bin",
	}
	for _, rel := range want {
		writeFixture(t, filepath.Join(root, filepath.FromSlash(rel)), "x")
	}
	for _, rel := range []string{"app/.env", "Login Data", "home/.ssh/id_ed25519", "home/.aws/credentials"} {
		writeFixture(t, filepath.Join(root, filepath.FromSlash(rel)), "x")
	}

	m := &recordingMatcher{}
	if _, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, p := range m.scanned() {
		rel, _ := filepath.Rel(root, p)
		got[filepath.ToSlash(rel)] = true
	}
	for _, rel := range want {
		if !got[rel] {
			t.Errorf("%s was not scanned", rel)
		}
	}
	if len(got) != len(want) {
		t.Errorf("scanned %d files, want %d: %v", len(got), len(want), got)
	}
}

// A second name for a protected file is not read; an ordinary file with
// several names (common for system binaries) still is.
func TestScanSkipsOtherNamesOfProtectedFiles(t *testing.T) {
	base := t.TempDir()
	_, secrets := agentConfigFixture(t, filepath.Join(base, "agentcfg"))
	root := filepath.Join(base, "scan")
	writeFixture(t, filepath.Join(root, "ordinary.bin"), "x")
	if err := os.Link(secrets, filepath.Join(root, "innocent.txt")); err != nil {
		t.Skipf("hard links not available here: %v", err)
	}
	if err := os.Link(filepath.Join(root, "ordinary.bin"), filepath.Join(root, "ordinary-copy.bin")); err != nil {
		t.Fatal(err)
	}

	m := &recordingMatcher{}
	if _, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(scannedBases(m), ",")
	if strings.Contains(got, "innocent.txt") {
		t.Fatalf("a second name of a protected file was read: %s", got)
	}
	if !strings.Contains(got, "ordinary.bin") || !strings.Contains(got, "ordinary-copy.bin") {
		t.Fatalf("ordinary hard-linked files were not scanned: %s", got)
	}
}

// Roots the scan will not walk are reported, not dropped silently.
func TestScanReportsRefusedRoots(t *testing.T) {
	base := t.TempDir()
	cfg, _ := agentConfigFixture(t, filepath.Join(base, "agentcfg"))
	cwd := t.TempDir()
	writeFixture(t, filepath.Join(cwd, "folder", "normal.txt"), "x")
	t.Chdir(cwd)

	m := &recordingMatcher{}
	res, err := walkAndMatch(context.Background(), []string{cfg, "folder"}, defaultThreatScanOptions(), m, yaraCfg(1))
	if err != nil {
		t.Fatal(err)
	}
	if got := m.scanned(); len(got) != 0 {
		t.Fatalf("refused roots were walked: %v", got)
	}
	if res.FilesFailed != 2 {
		t.Fatalf("FilesFailed = %d, want 2 (one per refused root)", res.FilesFailed)
	}
}

// A protected file that matched is reported as not quarantined (not
// attempted), rather than as a failed quarantine.
func TestAutoQuarantineDoesNotAttemptProtectedFile(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, ".env")
	writeFixture(t, path, avTestContent())
	s := &SecurityScanner{QuarantineDir: filepath.Join(root, "quarantine"), AutoQuarantine: true}
	threats := []Threat{{Name: "test", Type: "malware", Severity: ThreatSeverityHigh, Path: path}}
	s.autoQuarantine(threats)
	if threats[0].QuarantineFailed || threats[0].QuarantinedTo != "" {
		t.Fatalf("protected file reported as attempted: %+v", threats[0])
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("protected file was moved: %v", err)
	}
}

// A queued file replaced by another file after the walk saw it is not read:
// the worker reads only the file the walk listed.
func TestScanWorkerSkipsFileReplacedAfterTheWalk(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "a.txt")
	second := filepath.Join(root, "b.txt")
	writeFixture(t, first, "x")
	writeFixture(t, second, "x")
	replacement := filepath.Join(t.TempDir(), "other.txt")
	writeFixture(t, replacement, "different file")

	m := &recordingMatcher{}
	m.onScan = func(p string) {
		if p != first {
			return
		}
		if err := os.Rename(replacement, second); err != nil {
			t.Error(err)
		}
	}
	if _, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	for _, p := range m.scanned() {
		if p == second {
			t.Fatalf("a file replaced after the walk was read: %v", m.scanned())
		}
	}
}

// The scan reads at most the size limit, measured on the open file when it
// is scanned, even if the file grew after the walk measured it.
func TestScanSizeLimitAppliesWhenTheFileIsRead(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "a.bin")
	second := filepath.Join(root, "b.bin")
	writeFixture(t, first, "x")
	writeFixture(t, second, "x")
	opts := defaultThreatScanOptions()
	opts.MaxFileSize = 16

	m := &recordingMatcher{}
	m.onScan = func(p string) {
		if p != first {
			return
		}
		f, err := os.OpenFile(second, os.O_APPEND|os.O_WRONLY, 0)
		if err != nil {
			t.Error(err)
			return
		}
		_, _ = f.Write(make([]byte, 4096))
		_ = f.Close()
	}
	if _, err := walkAndMatch(context.Background(), []string{root}, opts, m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if size, ok := m.sizes[second]; ok && size > opts.MaxFileSize {
		t.Fatalf("scanned %d bytes of a file over the %d-byte limit", size, opts.MaxFileSize)
	}
}
