package security

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/yarascan"
)

type stubMatcher struct {
	delay     time.Duration
	hits      map[string]bool
	fileErr   map[string]error
	failInit  int64 // first N NewWorker calls fail
	initCalls atomic.Int64
	calls     atomic.Int64
}

func (s *stubMatcher) Engine() string { return "stub" }
func (s *stubMatcher) Close()         {}
func (s *stubMatcher) NewWorker() (yarascan.Worker, error) {
	if s.initCalls.Add(1) <= s.failInit {
		return nil, errors.New("stub engine init failed")
	}
	return stubWorker{s}, nil
}

type stubWorker struct{ s *stubMatcher }

func (w stubWorker) Close() {}
func (w stubWorker) ScanFile(p string) ([]yarascan.Match, error) {
	w.s.calls.Add(1)
	time.Sleep(w.s.delay)
	if err := w.s.fileErr[filepath.Base(p)]; err != nil {
		return nil, err
	}
	if w.s.hits[filepath.Base(p)] {
		return []yarascan.Match{
			{RuleSetID: "s", RuleID: "r", RuleName: "stub_rule", Severity: "high", ThreatType: "malware", Tags: []string{"t"}, AutoQuarantine: true},
			{RuleSetID: "s", RuleID: "r", RuleName: "stub_rule", Severity: "high", ThreatType: "malware"}, // duplicate: deduped
		}, nil
	}
	return nil, nil
}

func tree(t *testing.T, n int) string {
	t.Helper()
	dir := t.TempDir()
	for i := 0; i < n; i++ {
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%03d", i)), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func yaraCfg(workers int) walkConfig {
	c := yaraWalkConfig()
	c.Workers = workers
	return c
}

func TestWalkPoolFindsAndAttributes(t *testing.T) {
	dir := tree(t, 30)
	m := &stubMatcher{hits: map[string]bool{"f007": true, "f021": true}}
	res, err := walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, yaraCfg(4))
	if err != nil || res.FilesScanned != 30 || len(res.Threats) != 2 {
		t.Fatalf("got %d threats, %d scanned, err %v", len(res.Threats), res.FilesScanned, err)
	}
	if filepath.Base(res.Threats[0].Path) != "f007" || filepath.Base(res.Threats[1].Path) != "f021" {
		t.Fatalf("multi-worker results must be sorted by path: %s, %s", res.Threats[0].Path, res.Threats[1].Path)
	}
	th := res.Threats[0]
	if th.RuleName != "stub_rule" || th.RuleSetID != "s" || th.RuleID != "r" || th.Name != "stub_rule" || len(th.Tags) != 1 || !th.autoQuarantine {
		t.Fatalf("threat not attributed: %+v", th)
	}
	if th.SHA256 != "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" { // sha256("x")
		t.Fatalf("sha256 wrong: %q", th.SHA256)
	}
	if m.initCalls.Load() != 4 {
		t.Fatalf("want one matcher worker per goroutine, got %d", m.initCalls.Load())
	}
}

func TestWalkPoolHonoursDeadlineWithSlowWorker(t *testing.T) {
	dir := tree(t, 200)
	m := &stubMatcher{delay: 20 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	start := time.Now()
	res, err := walkAndMatch(ctx, []string{dir}, defaultThreatScanOptions(), m, yaraCfg(2))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("want deadline error, got %v", err)
	}
	if time.Since(start) > 2*time.Second || res.FilesScanned >= 200 {
		t.Fatalf("deadline not honoured: %v elapsed, %d scanned", time.Since(start), res.FilesScanned)
	}
}

// Deadline firing after the producer queued its last file: the dropped
// queued files must still surface as a deadline error (partial scan).
func TestWalkPoolDeadlineAfterProducerFinishedIsReported(t *testing.T) {
	dir := tree(t, 6) // fits the channel buffer: produce returns immediately
	m := &stubMatcher{delay: 80 * time.Millisecond}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	res, err := walkAndMatch(ctx, []string{dir}, defaultThreatScanOptions(), m, yaraCfg(2))
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("dropped queued files must report the deadline, got %v (scanned %d)", err, res.FilesScanned)
	}
	if res.FilesScanned >= 6 {
		t.Fatalf("expected queued files to be dropped, scanned %d", res.FilesScanned)
	}
}

func TestWalkPoolHonoursExclusions(t *testing.T) {
	dir := tree(t, 5)
	sub := filepath.Join(dir, "skip")
	_ = os.Mkdir(sub, 0o700)
	_ = os.WriteFile(filepath.Join(sub, "f000"), []byte("x"), 0o600)
	opts := defaultThreatScanOptions()
	opts.ExcludePaths = append(opts.ExcludePaths, sub)
	res, _ := walkAndMatch(context.Background(), []string{dir}, opts, &stubMatcher{}, yaraCfg(2))
	if res.FilesScanned != 5 {
		t.Fatalf("excluded dir scanned: %d", res.FilesScanned)
	}
}

func TestWalkPoolSkipsOversizedOnlyWhenConfigured(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "small"), []byte("x"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "big"), make([]byte, 2048), 0o600)
	opts := defaultThreatScanOptions()
	opts.MaxFileSize = 1024
	res, _ := walkAndMatch(context.Background(), []string{dir}, opts, &stubMatcher{}, yaraCfg(1))
	if res.FilesScanned != 1 {
		t.Fatalf("YARA walk must skip files over the cap: scanned %d", res.FilesScanned)
	}
	res, _ = walkAndMatch(context.Background(), []string{dir}, opts, &stubMatcher{}, legacyWalkConfig())
	if res.FilesScanned != 2 {
		t.Fatalf("legacy walk must offer every file (filename signatures): scanned %d", res.FilesScanned)
	}
}

func TestWalkPoolFileErrorsNonFatalForYara(t *testing.T) {
	dir := tree(t, 10)
	m := &stubMatcher{hits: map[string]bool{"f005": true}, fileErr: map[string]error{"f002": errors.New("locked"), "f003": os.ErrPermission}}
	res, err := walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, yaraCfg(2))
	if err != nil {
		t.Fatalf("per-file errors must not fail a YARA walk: %v", err)
	}
	if res.FilesFailed != 2 || len(res.Threats) != 1 || res.FilesScanned != 8 {
		t.Fatalf("want 2 failed, 1 threat, 8 scanned (failures are not scans); got %+v", res)
	}
	// Legacy (W01) semantics: non-permission file errors are joined into the
	// error; permission errors are skipped silently.
	res, err = walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, legacyWalkConfig())
	if err == nil || errors.Is(err, os.ErrPermission) || res.FilesFailed != 0 || len(res.Threats) != 1 {
		t.Fatalf("legacy error semantics changed: %v %+v", err, res)
	}
}

func TestWalkPoolSurvivesPartialWorkerInitFailure(t *testing.T) {
	dir := tree(t, 40)
	m := &stubMatcher{failInit: 3, hits: map[string]bool{"f039": true}}
	res, err := walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, yaraCfg(4))
	if err != nil {
		t.Fatalf("one healthy worker must finish the scan: %v", err)
	}
	// Failed workers must not have drained jobs away from the healthy one.
	if res.FilesScanned != 40 || len(res.Threats) != 1 || m.calls.Load() != 40 {
		t.Fatalf("files lost to failed workers: scanned %d, calls %d, threats %d", res.FilesScanned, m.calls.Load(), len(res.Threats))
	}
}

func TestWalkPoolAllWorkersFailIsAnError(t *testing.T) {
	dir := tree(t, 50) // more files than the channel buffer: producer must not deadlock
	m := &stubMatcher{failInit: 2}
	done := make(chan struct{})
	var err error
	go func() {
		_, err = walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, yaraCfg(2))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("walk deadlocked when every worker failed to start")
	}
	if !errors.Is(err, ErrNoScanWorkers) {
		t.Fatalf("want ErrNoScanWorkers, got %v", err)
	}
}

func TestLegacyMatcherKeepsW01ThreatShape(t *testing.T) {
	if (legacyMatcher{}).Engine() != "legacy" {
		t.Fatal("legacy engine label changed")
	}
	th := threatFromMatch(yarascan.Match{RuleName: "Sig", Severity: "high", ThreatType: "malware", Tags: []string{"x"}, AutoQuarantine: true}, "/p", "abc")
	if th.Name != "Sig" || th.RuleName != "" || th.RuleID != "" || th.Tags != nil || th.autoQuarantine || th.SHA256 != "abc" {
		t.Fatalf("legacy threat must keep the W01 shape plus sha256: %+v", th)
	}
}

func TestFileSHA256ReportsErrors(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	_ = os.WriteFile(p, []byte("x"), 0o600)
	if sum, err := fileSHA256(p); err != nil || sum == "" {
		t.Fatalf("hash of a readable file failed: %q %v", sum, err)
	}
	if sum, err := fileSHA256(filepath.Join(t.TempDir(), "missing")); err == nil || sum != "" {
		t.Fatal("an unreadable file must be an error, never an empty 'verified' hash")
	}
}

// A worker whose engine dies mid-scan retires; the others finish the scan.
func TestWalkPoolRetiresWorkerThatLosesItsEngine(t *testing.T) {
	dir := tree(t, 40)
	m := &stubMatcher{fileErr: map[string]error{"f005": fmt.Errorf("%w: reinit failed", yarascan.ErrWorkerUnavailable)}, hits: map[string]bool{"f039": true}}
	res, err := walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, yaraCfg(2))
	if err != nil {
		t.Fatalf("one healthy worker must finish the scan: %v", err)
	}
	if res.FilesFailed != 1 || res.FilesScanned != 39 || len(res.Threats) != 1 {
		t.Fatalf("want 1 failed, 39 scanned, 1 threat; got %+v", res)
	}
}

// Every worker losing its engine is ErrNoScanWorkers, with threats found
// before that preserved, and no deadlock.
func TestWalkPoolAllWorkersLostKeepsPartialThreats(t *testing.T) {
	dir := tree(t, 50)
	lost := fmt.Errorf("%w: reinit failed", yarascan.ErrWorkerUnavailable)
	errs := map[string]error{}
	for i := 10; i < 50; i++ {
		errs[fmt.Sprintf("f%03d", i)] = lost
	}
	m := &stubMatcher{fileErr: errs, hits: map[string]bool{"f000": true}}
	done := make(chan struct{})
	var res walkResult
	var err error
	go func() {
		res, err = walkAndMatch(context.Background(), []string{dir}, defaultThreatScanOptions(), m, yaraCfg(1))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("walk deadlocked after every worker lost its engine")
	}
	if !errors.Is(err, ErrNoScanWorkers) || len(res.Threats) != 1 {
		t.Fatalf("want ErrNoScanWorkers with the f000 threat kept, got %v %+v", err, res)
	}
}
