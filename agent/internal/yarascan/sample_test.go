package yarascan

import (
	"bytes"
	"os"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/obfuscate"
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
// IOCs are the digests of the standard 68-byte AV test file. Its bytes are
// stored XOR-encoded (internal/obfuscate) and decoded at run time so no
// plaintext AV test signature sits in agent source (#2797).
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
	avTestFile := obfuscate.DecodeBytes([]byte{
		0x02, 0x6f, 0x15, 0x7b, 0x0a, 0x7f, 0x1a, 0x1b, 0x0a, 0x01, 0x6e, 0x06,
		0x0a, 0x00, 0x02, 0x6f, 0x6e, 0x72, 0x0a, 0x04, 0x73, 0x6d, 0x19, 0x19,
		0x73, 0x6d, 0x27, 0x7e, 0x1f, 0x13, 0x19, 0x1b, 0x08, 0x77, 0x09, 0x0e,
		0x1b, 0x14, 0x1e, 0x1b, 0x08, 0x1e, 0x77, 0x1b, 0x14, 0x0e, 0x13, 0x0c,
		0x13, 0x08, 0x0f, 0x09, 0x77, 0x0e, 0x1f, 0x09, 0x0e, 0x77, 0x1c, 0x13,
		0x16, 0x1f, 0x7b, 0x7e, 0x12, 0x71, 0x12, 0x70,
	})
	got, err := ScanSample(e, "av-test.com", "", avTestFile, 15*time.Second)
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
