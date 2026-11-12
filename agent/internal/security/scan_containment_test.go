package security

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/yarascan"
)

// recordingMatcher records every path a worker was asked to read and can run
// a hook before answering, so a test can change the tree mid-scan.
type recordingMatcher struct {
	mu     sync.Mutex
	paths  []string
	sizes  map[string]int64 // bytes the worker was told to scan, by path
	onScan func(path string)
	hit    bool // report one match for every file
}

func (r *recordingMatcher) Engine() string                      { return "recording" }
func (r *recordingMatcher) Close()                              {}
func (r *recordingMatcher) NewWorker() (yarascan.Worker, error) { return recordingWorker{r}, nil }

func (r *recordingMatcher) scanned() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.paths...)
}

type recordingWorker struct{ r *recordingMatcher }

func (w recordingWorker) Close() {}
func (w recordingWorker) ScanFile(_ *os.File, size int64, p string) ([]yarascan.Match, error) {
	w.r.mu.Lock()
	w.r.paths = append(w.r.paths, p)
	if w.r.sizes == nil {
		w.r.sizes = map[string]int64{}
	}
	w.r.sizes[p] = size
	hook := w.r.onScan
	w.r.mu.Unlock()
	if hook != nil {
		hook(p)
	}
	if w.r.hit {
		return []yarascan.Match{{RuleSetID: "s", RuleID: "r", RuleName: "rec_rule", Severity: "high", ThreatType: "malware"}}, nil
	}
	return nil, nil
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestScanSkipsProtectedFilesDuringDescent(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{".env", "normal.txt"} {
		writeFixture(t, filepath.Join(root, name), syntheticMarker)
	}
	m := syntheticMatcher(t)
	res, err := walkAndMatch(context.Background(), []string{root}, scanOptionsForTest(), m, yaraCfg(1))
	if err != nil {
		t.Fatal(err)
	}
	if res.FilesScanned != 1 {
		t.Fatalf("scanned=%d, want 1", res.FilesScanned)
	}
	if len(res.Threats) != 1 || filepath.Base(res.Threats[0].Path) != "normal.txt" {
		t.Fatalf("unexpected threats: %+v", res.Threats)
	}
}

func TestRuleSetScanNeverReadsProtectedFiles(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "normal.txt"), "x")
	writeFixture(t, filepath.Join(root, ".env"), "x")
	writeFixture(t, filepath.Join(root, "home", ".ssh", "id_ed25519"), "x")
	writeFixture(t, filepath.Join(root, "home", ".aws", "credentials"), "x")

	m := &recordingMatcher{}
	res, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(2))
	if err != nil {
		t.Fatal(err)
	}
	got := m.scanned()
	if len(got) != 1 || filepath.Base(got[0]) != "normal.txt" || res.FilesScanned != 1 {
		t.Fatalf("files read = %v (scanned %d), want only normal.txt", got, res.FilesScanned)
	}
}

func TestScanRootThatIsProtectedIsNotWalked(t *testing.T) {
	root, _ := agentConfigFixture(t, filepath.Join(t.TempDir(), "agentcfg"))
	writeFixture(t, filepath.Join(root, "normal.txt"), "x")

	m := &recordingMatcher{}
	if _, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	if got := m.scanned(); len(got) != 0 {
		t.Fatalf("a protected scan root was walked: %v", got)
	}
}

// A protected folder below a root is not descended into, whatever the
// files inside it are called.
func TestScanDoesNotDescendIntoProtectedDirectory(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, filepath.Join(root, "normal.txt"), "x")
	agentConfigFixture(t, filepath.Join(root, "agentcfg"))
	writeFixture(t, filepath.Join(root, "agentcfg", "inner.txt"), "x")

	m := &recordingMatcher{}
	if _, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	if got := m.scanned(); len(got) != 1 || filepath.Base(got[0]) != "normal.txt" {
		t.Fatalf("files read = %v, want only normal.txt", got)
	}
}

// The threat's hash describes the file that was scanned, even if the path
// names different content by the time the hash is taken.
func TestThreatHashIsOfTheScannedFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("replacing an open file by rename is not allowed on Windows")
	}
	root := t.TempDir()
	target := filepath.Join(root, "a.bin")
	writeFixture(t, target, "x")
	replacement := filepath.Join(t.TempDir(), "b.bin")
	writeFixture(t, replacement, "something else")

	m := &recordingMatcher{hit: true}
	m.onScan = func(string) {
		if err := os.Rename(replacement, target); err != nil {
			t.Error(err)
		}
	}
	res, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(1))
	if err != nil {
		t.Fatal(err)
	}
	const sumX = "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" // sha256("x")
	if len(res.Threats) != 1 || res.Threats[0].SHA256 != sumX {
		t.Fatalf("threat hash = %+v, want the scanned content's hash", res.Threats)
	}
}

// A file the walk queued is checked again when a worker picks it up: if it
// has since become a link into a protected location, it is not read.
func TestScanWorkerRechecksQueuedFileBeforeReading(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation needs a privilege Windows CI does not grant")
	}
	protected := filepath.Join(t.TempDir(), ".env")
	writeFixture(t, protected, "x")

	root := t.TempDir()
	first := filepath.Join(root, "a.txt")
	second := filepath.Join(root, "b.txt")
	writeFixture(t, first, "x")
	writeFixture(t, second, "x")

	m := &recordingMatcher{}
	m.onScan = func(p string) {
		if p != first {
			return
		}
		// b.txt is already queued behind a.txt (one worker, lexical walk).
		if err := os.Remove(second); err != nil {
			t.Error(err)
		}
		if err := os.Symlink(protected, second); err != nil {
			t.Error(err)
		}
	}
	if _, err := walkAndMatch(context.Background(), []string{root}, defaultThreatScanOptions(), m, yaraCfg(1)); err != nil {
		t.Fatal(err)
	}
	for _, p := range m.scanned() {
		if p == second {
			t.Fatalf("a queued file that became a link was read: %v", m.scanned())
		}
	}
}

func TestCustomScanRefusesProtectedRoot(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	writeFixture(t, path, "x")
	scanner := &SecurityScanner{}
	if _, err := scanner.ScanWithContext(context.Background(), "custom", []string{path}); err == nil {
		t.Fatal("expected a protected-path refusal")
	}
}

func TestCustomScanRefusesNetworkAndRelativeRoots(t *testing.T) {
	for _, p := range []string{`\\fileserver\share`, `//fileserver/share`, `\\?\C:\Windows`, `relative/folder`, `C:folder`} {
		scanner := &SecurityScanner{}
		if _, err := scanner.ScanWithContext(context.Background(), "custom", []string{p}); err == nil {
			t.Errorf("%q: expected a path-form refusal", p)
		}
	}
}
