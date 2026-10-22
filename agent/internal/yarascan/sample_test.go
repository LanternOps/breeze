package yarascan

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

// compileEntry builds a CacheEntry for one in-test bundle (the breeze-yarac
// compileBundles shape).
func compileEntry(t testing.TB, b *Bundle) *CacheEntry {
	t.Helper()
	rules, setErrs, err := yarac.CompileSets([]yarac.Set{ToYaracSet(b)}, yarac.DefaultPolicy)
	if err != nil || len(setErrs) > 0 || rules == nil {
		t.Fatalf("compile: err=%v setErrs=%+v", err, setErrs)
	}
	e := &CacheEntry{Rules: rules, Index: map[string]RuleMeta{}, AutoQuarantine: map[string]bool{b.RuleSetID: b.AutoQuarantine}}
	for _, r := range b.Rules {
		e.Index[b.RuleSetID+":"+r.Name] = RuleMeta{RuleID: r.ID, Severity: r.Severity}
	}
	return e
}

func TestScanSampleMatchesAndCaps(t *testing.T) {
	e := compileEntry(t, bundle("s1", BundleRule{ID: "r1", Name: "evil_mark", Severity: "critical",
		Source: `rule evil_mark : ioc { strings: $a = "EVILMARK" condition: $a }`}))
	var data bytes.Buffer
	for i := 0; i < 12; i++ {
		data.WriteString("....padding....EVILMARK")
	}
	got, err := ScanSample(e, "sample.bin", "", data.Bytes(), 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("want 1 match, got %d: %+v", len(got), got)
	}
	m := got[0]
	if m.RuleSetID != "s1" || m.RuleID != "r1" || m.RuleName != "evil_mark" || m.Severity != "critical" {
		t.Fatalf("match metadata: %+v", m)
	}
	if len(m.Tags) != 1 || m.Tags[0] != "ioc" {
		t.Fatalf("tags: %+v", m.Tags)
	}
	if len(m.Strings) != MaxMatchedStrings {
		t.Fatalf("want %d matched strings (capped), got %d", MaxMatchedStrings, len(m.Strings))
	}
	for i, s := range m.Strings {
		if s.Data != "EVILMARK" || s.ID != "$a" {
			t.Fatalf("string %d: %+v", i, s)
		}
		if i > 0 && s.Offset <= m.Strings[i-1].Offset {
			t.Fatalf("offsets not ascending: %+v", m.Strings)
		}
	}
}

func TestScanSampleGlobals(t *testing.T) {
	e := compileEntry(t, bundle("s1",
		BundleRule{ID: "r1", Name: "by_name", Severity: "high", Source: `rule by_name { condition: filename iequals "invoice.pdf" and extension == "pdf" }`},
		BundleRule{ID: "r2", Name: "by_path", Severity: "high", Source: `rule by_path { condition: filepath iequals "C:\\Users\\Public\\x.exe" }`},
	))
	names := func(ms []Match) map[string]bool {
		out := map[string]bool{}
		for _, m := range ms {
			out[m.RuleName] = true
		}
		return out
	}

	got, err := ScanSample(e, "INVOICE.PDF", "", []byte("hello"), 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if n := names(got); !n["by_name"] || n["by_path"] {
		t.Fatalf("filename global (filepath defaults to the filename): %+v", n)
	}

	got, err = ScanSample(e, "x.exe", `c:\users\public\X.EXE`, []byte("hello"), 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if n := names(got); !n["by_path"] || n["by_name"] {
		t.Fatalf("filepath global: %+v", n)
	}
}

func TestScanSampleNoMatch(t *testing.T) {
	e := compileEntry(t, bundle("s1", BundleRule{ID: "r1", Name: "evil_mark", Severity: "high",
		Source: `rule evil_mark { strings: $a = "EVILMARK" condition: $a }`}))
	got, err := ScanSample(e, "clean.txt", "", []byte("nothing to see"), 15*time.Second)
	if err != nil || len(got) != 0 {
		t.Fatalf("want no matches, got %+v err=%v", got, err)
	}
}

func TestScanSampleEscapesMatchedBytes(t *testing.T) {
	e := compileEntry(t, bundle("s1", BundleRule{ID: "r1", Name: "bin_mark", Severity: "high",
		Source: `rule bin_mark { strings: $a = { 41 00 5C 42 } condition: $a }`}))
	got, err := ScanSample(e, "b.bin", "", []byte("zzA\x00\\Bzz"), 15*time.Second)
	if err != nil || len(got) != 1 || len(got[0].Strings) != 1 {
		t.Fatalf("want one match with one string, got %+v err=%v", got, err)
	}
	if s := got[0].Strings[0]; s.Data != `A\x00\x5cB` || s.Offset != 2 {
		t.Fatalf("matched string must be escaped like on-device scans: %+v", s)
	}
}

// The IOC importer's hash rules bind the digest once (`with digest = …`);
// prove that form MATCHES, not just compiles. The golden's md5/sha1/sha256
// IOCs are the EICAR test file's digests; the bytes are assembled at run time
// so no EICAR string sits in the repo.
func TestScanSampleIocGoldenHashRulesMatch(t *testing.T) {
	raw, err := os.ReadFile("testdata/ioc-import.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	b, err := DecodeBundle(raw)
	if err != nil {
		t.Fatal(err)
	}
	e := compileEntry(t, b)
	eicar := []byte(`X5O!P%@AP[4\PZX54(P^)7CC)7}$` + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")
	got, err := ScanSample(e, "eicar.com", "", eicar, 15*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	kinds := map[string]bool{}
	for _, m := range got {
		if len(m.Tags) == 2 {
			kinds[m.Tags[1]] = true
		}
	}
	if !kinds["md5"] || !kinds["sha1"] || !kinds["sha256"] || len(got) != 3 {
		t.Fatalf("want exactly the md5, sha1 and sha256 IOC rules to match, got %+v", got)
	}
}
