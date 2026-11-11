package security

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// #11728 — a scan must never match (or auto-quarantine) the agent's own
// compiled YARA rule cache. A compiled rule file carries the strings its rules
// look for, and the .byrc payload's single-byte XOR is no cover against a rule
// using YARA's `xor` string modifier. For the installed Windows agent the
// cache lives under %ProgramData%, which both quick and full scans walk.

const cacheKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func writeFile(t *testing.T, p string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestYaraScanSkipsOwnRuleCache(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "Breeze", "data", "yara", "cache")
	entry := filepath.Join(cacheDir, cacheKey+".byrc")
	staging := filepath.Join(cacheDir, cacheKey+".123.tmp") // Cache.Store's temp file
	victim := filepath.Join(root, "victim.bin")
	for _, p := range []string{entry, staging, victim} {
		writeFile(t, p)
	}
	// The stub matches every file, the cache entries included: only the
	// exclusion can keep them out of the result.
	m := &stubMatcher{hits: map[string]bool{
		filepath.Base(entry): true, filepath.Base(staging): true, filepath.Base(victim): true,
	}}
	s := &SecurityScanner{
		QuarantineDir:  filepath.Join(root, "q"),
		RuleCacheDir:   cacheDir,
		Matcher:        m,
		AutoQuarantine: true,
	}

	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	for _, th := range out.Threats {
		if strings.HasPrefix(th.Path, cacheDir) {
			t.Fatalf("the agent's own rule cache must never be reported: %+v", th)
		}
	}
	// Non-vacuous: the scan did run and did report the file outside the cache.
	if len(out.Threats) != 1 || out.Threats[0].Path != victim || out.FilesScanned != 1 {
		t.Fatalf("want exactly the one hit outside the cache, 1 file scanned: %+v", out)
	}
	for _, p := range []string{entry, staging} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("a rule-cache file must never be auto-quarantined (%s): %v", p, err)
		}
	}
}

// A custom scan aimed straight at the cache directory scans nothing, the same
// as one aimed at the quarantine directory.
func TestCustomScanOfRuleCacheDirScansNothing(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "cache")
	entry := filepath.Join(cacheDir, cacheKey+".byrc")
	writeFile(t, entry)
	m := &stubMatcher{hits: map[string]bool{filepath.Base(entry): true}}
	s := &SecurityScanner{QuarantineDir: filepath.Join(root, "q"), RuleCacheDir: cacheDir, Matcher: m}

	out, err := s.ScanWithContext(context.Background(), "custom", []string{cacheDir})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Threats) != 0 || out.FilesScanned != 0 {
		t.Fatalf("the rule cache must not be scanned even when named directly: %+v", out)
	}
}

// The legacy engine (no rule sets, or a YARA fallback) walks the same targets
// and must skip the cache too.
func TestLegacyScanSkipsOwnRuleCache(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "yara", "cache")
	inCache := filepath.Join(cacheDir, "how_to_decrypt.byrc") // legacy filename signature
	outside := filepath.Join(root, "how_to_decrypt.txt")
	writeFile(t, inCache)
	writeFile(t, outside)
	s := &SecurityScanner{QuarantineDir: filepath.Join(root, "q"), RuleCacheDir: cacheDir}

	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Threats) != 1 || out.Threats[0].Path != outside {
		t.Fatalf("want only the hit outside the rule cache: %+v", out.Threats)
	}
}

// A policy's exclusions are additive: delivering some cannot drop the
// built-in rule-cache exclusion.
func TestPolicyExclusionsDoNotReplaceRuleCacheExclusion(t *testing.T) {
	root := t.TempDir()
	cacheDir := filepath.Join(root, "cache")
	entry := filepath.Join(cacheDir, cacheKey+".byrc")
	writeFile(t, entry)
	m := &stubMatcher{hits: map[string]bool{filepath.Base(entry): true}}
	s := &SecurityScanner{
		QuarantineDir: filepath.Join(root, "q"),
		RuleCacheDir:  cacheDir,
		Matcher:       m,
		Exclusions:    []string{filepath.Join(root, "elsewhere")},
	}
	out, err := s.ScanWithContext(context.Background(), "custom", []string{root})
	if err != nil {
		t.Fatal(err)
	}
	if len(out.Threats) != 0 {
		t.Fatalf("policy exclusions must not replace the rule-cache exclusion: %+v", out.Threats)
	}
}

// Production scanners leave RuleCacheDir empty: the exclusion must then name
// the same default directory the scan handler builds its yarascan.Cache in.
func TestAgentOwnedExcludePathsCoverDefaultRuleCache(t *testing.T) {
	s := &SecurityScanner{}
	want := filepath.Join(config.GetDataDir(), "yara", "cache")
	if got := s.RuleCacheDirOrDefault(); got != want {
		t.Fatalf("RuleCacheDirOrDefault() = %q, want %q", got, want)
	}
	excludes := s.agentOwnedExcludePaths()
	if !isExcludedPath(filepath.Join(want, cacheKey+".byrc"), excludes) {
		t.Fatalf("default rule cache %q not in the built-in exclusions %v", want, excludes)
	}
	if !isExcludedPath(filepath.Join(DefaultQuarantineDir(), "x.bqz"), excludes) {
		t.Fatalf("default quarantine dir dropped from the built-in exclusions %v", excludes)
	}
}
