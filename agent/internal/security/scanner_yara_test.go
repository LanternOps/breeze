package security

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/yarascan"
)

// #6263 W02 — ScanWithContext with a YARA matcher, and the auto-quarantine
// rules (D7, once per file, sha256 re-verify).

func TestScanWithContextFallsBackToLegacyWhenEngineCannotStart(t *testing.T) {
	root := t.TempDir()
	// Legacy filename signature (bare literal also used in threats_test.go).
	if err := os.WriteFile(filepath.Join(root, "how_to_decrypt.txt"), []byte("benign"), 0o600); err != nil {
		t.Fatal(err)
	}
	s := &SecurityScanner{QuarantineDir: filepath.Join(root, "q"), Matcher: &stubMatcher{failInit: 1 << 30}}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatalf("an engine that cannot start must not fail the scan: %v", err)
	}
	if out.Engine != yarascan.EngineLegacy || out.EngineError == "" {
		t.Fatalf("fallback must be reported as a degraded legacy run: engine=%q engineError=%q", out.Engine, out.EngineError)
	}
	if len(out.Threats) != 1 || out.FilesScanned != 1 || out.FilesFailed != 0 {
		t.Fatalf("legacy fallback must still detect: %+v", out)
	}
}

func TestScanWithContextYaraCountsFailedFiles(t *testing.T) {
	root := t.TempDir()
	for _, n := range []string{"f000", "f001", "f002"} {
		_ = os.WriteFile(filepath.Join(root, n), []byte("x"), 0o600)
	}
	m := &stubMatcher{hits: map[string]bool{"f000": true}, fileErr: map[string]error{"f001": os.ErrDeadlineExceeded}}
	s := &SecurityScanner{QuarantineDir: filepath.Join(root, "q"), Matcher: m}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatalf("a per-file engine error must not fail a YARA scan: %v", err)
	}
	if out.Engine != "stub" || out.EngineError != "" || out.FilesFailed != 1 || out.FilesScanned != 2 || len(out.Threats) != 1 {
		t.Fatalf("outcome wrong: %+v", out)
	}
}

// An engine that fails on at least as many files as it scans is reported as
// degraded (EngineError), never as a clean YARA scan.
func TestScanWithContextYaraMostlyFailingIsDegraded(t *testing.T) {
	root := t.TempDir()
	errs := map[string]error{}
	for _, n := range []string{"f000", "f001", "f002"} {
		_ = os.WriteFile(filepath.Join(root, n), []byte("x"), 0o600)
		errs[n] = os.ErrDeadlineExceeded
	}
	s := &SecurityScanner{QuarantineDir: filepath.Join(root, "q"), Matcher: &stubMatcher{fileErr: errs}}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if out.Engine != "stub" || out.EngineError == "" || out.FilesFailed != 3 || out.FilesScanned != 0 {
		t.Fatalf("all-failed YARA scan must be flagged degraded: %+v", out)
	}
}

func TestScanWithContextEngineLostMidScanKeepsYaraHits(t *testing.T) {
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "a-hit"), []byte("x"), 0o600)
	_ = os.WriteFile(filepath.Join(root, "how_to_decrypt.txt"), []byte("benign"), 0o600) // legacy signature
	// Every non-hit file kills the worker that receives it. With at least as
	// many such files as workers (defaultScanWorkers() <= 4), every worker
	// dies: each dying file is received by a distinct live worker.
	dies := map[string]error{"how_to_decrypt.txt": yarascan.ErrWorkerUnavailable}
	for i := 0; i < 8; i++ {
		n := fmt.Sprintf("z-dies-%d", i)
		_ = os.WriteFile(filepath.Join(root, n), []byte("x"), 0o600)
		dies[n] = yarascan.ErrWorkerUnavailable
	}
	m := &stubMatcher{hits: map[string]bool{"a-hit": true}, fileErr: dies}
	s := &SecurityScanner{QuarantineDir: filepath.Join(root, "q"), Matcher: m}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if out.Engine != yarascan.EngineLegacy || out.EngineError == "" {
		t.Fatalf("losing every worker must fall back to legacy, degraded: %+v", out)
	}
	var yaraHit, legacyHit bool
	for _, th := range out.Threats {
		yaraHit = yaraHit || th.RuleSetID == "s"
		legacyHit = legacyHit || (th.RuleSetID == "" && filepath.Base(th.Path) == "how_to_decrypt.txt")
	}
	// "a-hit" is first in walk order and the channel is FIFO, so some live
	// worker always receives and scans it before the last worker can die:
	// the YARA hit found before the engine was lost must survive the merge.
	if !legacyHit || !yaraHit {
		t.Fatalf("want both the pre-loss YARA hit and the legacy fallback hit: %+v", out.Threats)
	}
}

func TestAutoQuarantineRefusesUnhashedFile(t *testing.T) {
	dir := t.TempDir()
	q := filepath.Join(dir, "q")
	p, _ := writeVictim(t, dir, "v.bin")
	threats := []Threat{{Name: "r", Path: p, RuleSetID: "s1", autoQuarantine: true, hashFailed: true}}
	(&SecurityScanner{QuarantineDir: q}).autoQuarantine(threats)
	if !threats[0].QuarantineFailed || bqzCount(t, q) != 0 {
		t.Fatalf("an unverifiable file must not be moved: %+v", threats[0])
	}
}

func writeVictim(t *testing.T, dir, name string) (string, string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	sum, err := fileSHA256(p)
	if err != nil {
		t.Fatal(err)
	}
	return p, sum
}

func bqzCount(t *testing.T, dir string) int {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(dir, "*.bqz"))
	return len(m)
}

func TestAutoQuarantineRules(t *testing.T) {
	cases := []struct {
		name          string
		ruleSetID     string
		setOptIn      bool
		wantMoved     bool
		wantFailedFlg bool
	}{
		{"legacy hit follows the policy flag alone", "", false, true, false},
		{"YARA hit with set opt-in is quarantined", "s1", true, true, false},
		{"YARA hit without set opt-in is left in place (D7)", "s1", false, false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			q := filepath.Join(dir, "q")
			p, sum := writeVictim(t, dir, "v.bin")
			threats := []Threat{{Name: "r", Path: p, SHA256: sum, RuleSetID: tc.ruleSetID, autoQuarantine: tc.setOptIn}}
			(&SecurityScanner{QuarantineDir: q}).autoQuarantine(threats)
			_, statErr := os.Stat(p)
			moved := os.IsNotExist(statErr)
			if moved != tc.wantMoved || (threats[0].QuarantinedTo != "") != tc.wantMoved || threats[0].QuarantineFailed != tc.wantFailedFlg {
				t.Fatalf("moved=%v threat=%+v", moved, threats[0])
			}
		})
	}
}

func TestAutoQuarantineSkipsFileChangedSinceScan(t *testing.T) {
	dir := t.TempDir()
	q := filepath.Join(dir, "q")
	p, _ := writeVictim(t, dir, "v.bin")
	threats := []Threat{{Name: "r", Path: p, SHA256: "0000000000000000000000000000000000000000000000000000000000000000", RuleSetID: "s1", autoQuarantine: true}}
	(&SecurityScanner{QuarantineDir: q}).autoQuarantine(threats)
	if !threats[0].QuarantineFailed || threats[0].QuarantinedTo != "" {
		t.Fatalf("changed file must be reported as quarantine-failed: %+v", threats[0])
	}
	if _, err := os.Stat(p); err != nil {
		t.Fatal("a file that changed since the scan must not be moved")
	}
	if bqzCount(t, q) != 0 {
		t.Fatal("no payload may be written for a skipped file")
	}
}

// Two rules on one file, only one set opted in: the opted-in hit quarantines
// the file; the other hit is left undecorated (it never asked for it).
func TestAutoQuarantineMixedOptInOnSameFile(t *testing.T) {
	dir := t.TempDir()
	q := filepath.Join(dir, "q")
	p, sum := writeVictim(t, dir, "v.bin")
	threats := []Threat{
		{Name: "a", Path: p, SHA256: sum, RuleSetID: "noopt", autoQuarantine: false},
		{Name: "b", Path: p, SHA256: sum, RuleSetID: "opt", autoQuarantine: true},
	}
	(&SecurityScanner{QuarantineDir: q}).autoQuarantine(threats)
	if threats[0].QuarantinedTo != "" || threats[0].QuarantineFailed {
		t.Fatalf("non-opted threat must stay undecorated: %+v", threats[0])
	}
	if threats[1].QuarantinedTo == "" || bqzCount(t, q) != 1 {
		t.Fatalf("opted-in threat must quarantine the file once: %+v", threats[1])
	}
}
