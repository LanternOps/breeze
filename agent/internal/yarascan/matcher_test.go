package yarascan

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
)

type fakeFetcher struct {
	bundles map[string]*Bundle
	calls   atomic.Int64
}

func (f *fakeFetcher) Fetch(_ context.Context, ref RuleSetRef) (*Bundle, *RuleSetError) {
	f.calls.Add(1)
	if b, ok := f.bundles[ref.ID]; ok {
		return b, nil
	}
	return nil, &RuleSetError{ID: ref.ID, Version: ref.Version, Code: CodeHTTP404}
}

func bundle(id string, rules ...BundleRule) *Bundle {
	return &Bundle{Format: BundleFormat, V: 1, RuleSetID: id, Version: 1, Rules: rules}
}

const marker = `rule fixture_marker : fixture { meta: threat_type = "pup" strings: $a = "breeze_yara_fixture_marker_7f3a" condition: $a }`

func ref(id string) RuleSetRef {
	return RuleSetRef{ID: id, Version: 1, SHA256: strings.Repeat("a", 64)}
}

func scanOne(t *testing.T, m Matcher, path string) []Match {
	t.Helper()
	w, err := m.NewWorker()
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	got, err := w.ScanFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func TestLoadMatcherScansFixture(t *testing.T) {
	f := &fakeFetcher{bundles: map[string]*Bundle{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "critical", Source: marker})}}
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, newCache(t, DefaultEntries))
	if m == nil || len(errs) != 0 {
		t.Fatalf("load failed: %+v", errs)
	}
	defer m.Close()
	if m.Engine() != EngineYARA {
		t.Fatalf("engine = %q", m.Engine())
	}
	got := scanOne(t, m, "testdata/files/fixture-a.bin")
	if len(got) != 1 {
		t.Fatalf("want 1 match, got %+v", got)
	}
	g := got[0]
	if g.RuleSetID != "s1" || g.RuleID != "r1" || g.RuleName != "fixture_marker" || g.Severity != "critical" || g.ThreatType != "pup" || len(g.Tags) != 1 || g.Tags[0] != "fixture" {
		t.Fatalf("match metadata wrong: %+v", g)
	}
	if len(g.Strings) != 1 || g.Strings[0].ID != "$a" || g.Strings[0].Offset != 7 || g.Strings[0].Data != "breeze_yara_fixture_marker_7f3a" {
		t.Fatalf("matched string wrong: %+v", g.Strings)
	}
	if none := scanOne(t, m, "testdata/modules.yar"); len(none) != 0 {
		t.Fatalf("clean file matched: %+v", none)
	}
}

func TestLoadMatcherUsesCacheOnSecondLoad(t *testing.T) {
	f := &fakeFetcher{bundles: map[string]*Bundle{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker})}}
	c := newCache(t, DefaultEntries)
	if m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, c); m == nil || len(errs) != 0 {
		t.Fatalf("first load: %+v", errs)
	}
	entries, _ := filepath.Glob(filepath.Join(c.Dir, "*.byrc"))
	if len(entries) != 1 {
		t.Fatalf("want 1 cache entry after a clean compile, got %d", len(entries))
	}
	// Second load: a bundle whose source would no longer compile proves the
	// compile step was skipped (cache hit), while the result still scans.
	f.bundles["s1"] = bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: "rule fixture_marker { condition: "})
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, c)
	if m == nil || len(errs) != 0 {
		t.Fatalf("cache hit expected, got errs %+v", errs)
	}
	if got := scanOne(t, m, "testdata/files/fixture-a.bin"); len(got) != 1 || got[0].RuleID != "r1" {
		t.Fatalf("cached matcher wrong: %+v", got)
	}
}

func TestLoadMatcherIsolatesFailingBundle(t *testing.T) {
	f := &fakeFetcher{bundles: map[string]*Bundle{
		"good": bundle("good", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker}),
		"bad":  bundle("bad", BundleRule{ID: "r2", Name: "broken", Severity: "high", Source: `rule broken { condition: `}),
	}}
	c := newCache(t, DefaultEntries)
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("good"), ref("bad"), ref("gone")}, f, c)
	if m == nil {
		t.Fatal("one usable set must still produce a matcher")
	}
	defer m.Close()
	codes := map[string]string{}
	for _, e := range errs {
		codes[e.ID] = e.Code
	}
	if len(errs) != 2 || codes["bad"] != CodeCompile || codes["gone"] != CodeHTTP404 || codes["good"] != "" {
		t.Fatalf("per-set errors wrong: %+v", errs)
	}
	for _, e := range errs {
		if e.ID == "bad" && !strings.Contains(e.Detail, "broken") {
			t.Errorf("compile detail should name the rule: %q", e.Detail)
		}
	}
	if got := scanOne(t, m, "testdata/files/fixture-a.bin"); len(got) != 1 || got[0].RuleSetID != "good" {
		t.Fatalf("good set must still scan: %+v", got)
	}
	if entries, _ := filepath.Glob(filepath.Join(c.Dir, "*.byrc")); len(entries) != 0 {
		t.Fatal("a partial compile must not be cached")
	}
}

func TestLoadMatcherAllFailReturnsNil(t *testing.T) {
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("gone")}, &fakeFetcher{}, newCache(t, DefaultEntries))
	if m != nil || len(errs) != 1 || errs[0].Code != CodeHTTP404 {
		t.Fatalf("want nil matcher + 1 error, got %v %+v", m, errs)
	}
	f := &fakeFetcher{bundles: map[string]*Bundle{"bad": bundle("bad", BundleRule{ID: "r2", Name: "broken", Severity: "high", Source: `rule broken { condition: `})}}
	m, errs = LoadMatcher(context.Background(), []RuleSetRef{ref("bad")}, f, newCache(t, DefaultEntries))
	if m != nil || len(errs) != 1 || errs[0].Code != CodeCompile {
		t.Fatalf("all-compile-fail: want nil matcher + compile error, got %v %+v", m, errs)
	}
}

func TestLoadMatcherRecompilesAfterTamperedCacheEntry(t *testing.T) {
	f := &fakeFetcher{bundles: map[string]*Bundle{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker})}}
	c := newCache(t, DefaultEntries)
	if m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, c); m == nil || len(errs) != 0 {
		t.Fatalf("first load: %+v", errs)
	}
	entries, _ := filepath.Glob(filepath.Join(c.Dir, "*.byrc"))
	if len(entries) != 1 {
		t.Fatalf("want one cache entry, got %d", len(entries))
	}
	raw, _ := os.ReadFile(entries[0])
	raw[len(raw)-40] ^= 0xFF
	_ = os.WriteFile(entries[0], raw, 0o600)
	before, _ := os.Stat(entries[0])

	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, c)
	if m == nil || len(errs) != 0 {
		t.Fatalf("tampered entry must be recompiled, got %+v", errs)
	}
	if got := scanOne(t, m, "testdata/files/fixture-a.bin"); len(got) != 1 {
		t.Fatalf("recompiled matcher wrong: %+v", got)
	}
	if f.calls.Load() != 2 {
		t.Fatalf("want a fresh fetch per load, got %d", f.calls.Load())
	}
	after, err := os.Stat(entries[0])
	if err != nil || after.ModTime().Before(before.ModTime()) {
		t.Fatal("the recompiled entry must be written back")
	}
	if got, err := c.Load(CacheKey([]string{strings.Repeat("a", 64) + "@s1"})); got == nil || err != nil {
		t.Fatalf("rewritten entry must load cleanly: %v", err)
	}
}

func TestLoadMatcherCompilesWhenCacheDirUnusable(t *testing.T) {
	blocker := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(blocker, []byte("x"), 0o600)
	c := &Cache{Dir: filepath.Join(blocker, "cache"), MaxEntries: DefaultEntries} // parent is a regular file
	f := &fakeFetcher{bundles: map[string]*Bundle{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker})}}
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, c)
	if m == nil || len(errs) != 0 {
		t.Fatalf("an unusable cache must not stop the scan: %+v", errs)
	}
	if got := scanOne(t, m, "testdata/files/fixture-a.bin"); len(got) != 1 {
		t.Fatalf("matcher wrong: %+v", got)
	}
}

func TestLoadMatcherWorksWithoutCache(t *testing.T) {
	f := &fakeFetcher{bundles: map[string]*Bundle{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker})}}
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, nil)
	if m == nil || len(errs) != 0 {
		t.Fatalf("nil cache must still compile: %+v", errs)
	}
}

func TestLoadMatcherSameRuleNameAcrossSets(t *testing.T) {
	f := &fakeFetcher{bundles: map[string]*Bundle{
		"a": {Format: BundleFormat, V: 1, RuleSetID: "a", Version: 1, AutoQuarantine: true, Rules: []BundleRule{{ID: "ra", Name: "fixture_marker", Severity: "low", Source: marker}}},
		"b": bundle("b", BundleRule{ID: "rb", Name: "fixture_marker", Severity: "critical", Source: marker}),
	}}
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("a"), ref("b")}, f, newCache(t, DefaultEntries))
	if m == nil || len(errs) != 0 {
		t.Fatalf("load failed: %+v", errs)
	}
	got := scanOne(t, m, "testdata/files/fixture-a.bin")
	if len(got) != 2 {
		t.Fatalf("want one match per set, got %+v", got)
	}
	by := map[string]Match{}
	for _, g := range got {
		by[g.RuleSetID] = g
	}
	if by["a"].RuleID != "ra" || by["a"].Severity != "low" || !by["a"].AutoQuarantine || by["b"].RuleID != "rb" || by["b"].Severity != "critical" || by["b"].AutoQuarantine {
		t.Fatalf("per-set metadata crossed: %+v", by)
	}
}

func TestFilenameGlobalsAtScanTime(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "Report.EXE")
	if err := os.WriteFile(p, []byte("benign"), 0o600); err != nil {
		t.Fatal(err)
	}
	src := `rule by_name { condition: filename == "Report.EXE" and extension == "exe" and filepath contains "Report" }`
	f := &fakeFetcher{bundles: map[string]*Bundle{"s": bundle("s", BundleRule{ID: "r", Name: "by_name", Severity: "low", Source: src})}}
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s")}, f, nil)
	if m == nil {
		t.Fatalf("load failed: %+v", errs)
	}
	if got := scanOne(t, m, p); len(got) != 1 {
		t.Fatalf("filename/extension/filepath globals not set per file: %+v", got)
	}
}

func TestWorkerRecyclesAfterLargeFile(t *testing.T) {
	f := &fakeFetcher{bundles: map[string]*Bundle{"s1": bundle("s1", BundleRule{ID: "r1", Name: "fixture_marker", Severity: "high", Source: marker})}}
	m, _ := LoadMatcher(context.Background(), []RuleSetRef{ref("s1")}, f, nil)
	w, err := m.NewWorker()
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	big := filepath.Join(t.TempDir(), "big.bin")
	data := make([]byte, recycleAfterBytes+1)
	copy(data[1000:], "breeze_yara_fixture_marker_7f3a")
	if err := os.WriteFile(big, data, 0o600); err != nil {
		t.Fatal(err)
	}
	got, err := w.ScanFile(big)
	if err != nil || len(got) != 1 || got[0].Strings[0].Offset != 1000 {
		t.Fatalf("large file scan wrong: %+v %v", got, err)
	}
	if w.(*yaraWorker).s != nil {
		t.Fatal("scanner not dropped after a file above the recycle threshold")
	}
	// And the worker transparently re-creates its scanner.
	if got, err := w.ScanFile("testdata/files/fixture-a.bin"); err != nil || len(got) != 1 {
		t.Fatalf("scan after recycle failed: %+v %v", got, err)
	}
}

func TestMatchedStringsCapped(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "many.bin")
	content := strings.Repeat("breeze_yara_fixture_marker_7f3a\x00\x01", 30) + strings.Repeat("Z", 300)
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	src := `rule many { strings: $a = "breeze_yara_fixture_marker_7f3a" $z = /Z{200,}/ condition: $a and $z }`
	f := &fakeFetcher{bundles: map[string]*Bundle{"s": bundle("s", BundleRule{ID: "r", Name: "many", Severity: "low", Source: src})}}
	m, errs := LoadMatcher(context.Background(), []RuleSetRef{ref("s")}, f, nil)
	if m == nil {
		t.Fatalf("load failed: %+v", errs)
	}
	got := scanOne(t, m, p)
	if len(got) != 1 || len(got[0].Strings) != MaxMatchedStrings {
		t.Fatalf("want exactly %d matched strings, got %+v", MaxMatchedStrings, got)
	}
	for _, s := range got[0].Strings {
		if len(s.Data) > MaxMatchedBytes*4 {
			t.Fatalf("matched data not capped: %d bytes", len(s.Data))
		}
	}
}

func TestEscapeMatched(t *testing.T) {
	s := escapeMatched([]byte("A\x00\\" + strings.Repeat("B", 200)))
	if !strings.HasPrefix(s, `A\x00\x5c`) {
		t.Fatalf("escape wrong: %q", s)
	}
	if want := 1 + 4 + 4 + (MaxMatchedBytes - 3); len(s) != want {
		t.Fatalf("cap wrong: len %d want %d", len(s), want)
	}
}
