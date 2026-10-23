package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	yx "github.com/niallnsec/yaraxwasm"

	"github.com/breeze-rmm/agent/internal/yarascan/yarac"
)

const goldenPath = "../../internal/yarascan/testdata/bundle-v1.golden.json"

func runCLI(args []string, stdin []byte) (int, string, string) {
	var out, errb bytes.Buffer
	code := run(args, bytes.NewReader(stdin), &out, &errb)
	return code, out.String(), errb.String()
}

func TestValidateGoldenOK(t *testing.T) {
	in, err := os.ReadFile(goldenPath)
	if err != nil {
		t.Fatal(err)
	}
	code, out, _ := runCLI([]string{"validate"}, in)
	var res struct {
		OK     bool              `json:"ok"`
		Errors []json.RawMessage `json:"errors"`
	}
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("output is not JSON: %q", out)
	}
	if code != exitOK || !res.OK || res.Errors == nil || len(res.Errors) != 0 {
		t.Fatalf("golden bundle must validate with errors=[]: code=%d out=%s", code, out)
	}
}

func TestValidateReportsRuleError(t *testing.T) {
	in := []byte(`{"format":"breeze-yara-bundle","v":1,"ruleSetId":"s","version":1,"autoQuarantine":false,"rules":[{"id":"r1","name":"broken","severity":"high","source":"rule broken { condition: "}]}`)
	code, out, _ := runCLI([]string{"validate"}, in)
	var res struct {
		OK     bool `json:"ok"`
		Errors []struct {
			RuleID, Name, Code, Message string
			Line                        int
		} `json:"errors"`
	}
	_ = json.Unmarshal([]byte(out), &res)
	if code != exitRules || res.OK || len(res.Errors) != 1 || res.Errors[0].RuleID != "r1" || res.Errors[0].Code != "compile" || res.Errors[0].Line != 1 {
		t.Fatalf("want exit 1 with one r1 compile error on line 1, got %d %s", code, out)
	}
}

func TestValidateRejectsMalformedBundle(t *testing.T) {
	code, out, _ := runCLI([]string{"validate"}, []byte(`{"format":"nope"}`))
	if code != exitRules || !strings.Contains(out, `"code":"bundle_invalid"`) {
		t.Fatalf("want exit 1 bundle_invalid, got %d %s", code, out)
	}
	big := bytes.Repeat([]byte("x"), 16<<20+1)
	if code, out, _ := runCLI([]string{"validate"}, big); code != exitRules || !strings.Contains(out, "bundle_invalid") {
		t.Fatalf("oversized stdin: want exit 1 bundle_invalid, got %d %s", code, out)
	}
}

func TestUsageErrors(t *testing.T) {
	for _, args := range [][]string{nil, {"bogus"}, {"validate", "extra"}, {"compile"}, {"compile", "--out", "x"}, {"scan", "/tmp"}, {"scan", "--bundle", goldenPath}} {
		if code, _, _ := runCLI(args, nil); code != exitUsage {
			t.Errorf("%v: want exit 2, got %d", args, code)
		}
	}
}

func TestVersion(t *testing.T) {
	code, out, _ := runCLI([]string{"version"}, nil)
	var v struct {
		Engine string `json:"engine"`
		Policy int    `json:"policy"`
		Format int    `json:"format"`
	}
	if err := json.Unmarshal([]byte(out), &v); err != nil || code != exitOK || v.Policy != 1 || v.Format != 1 || !strings.HasPrefix(v.Engine, "v") {
		t.Fatalf("version output wrong: %d %q", code, out)
	}
}

func TestCompileWritesLoadableRules(t *testing.T) {
	outPath := filepath.Join(t.TempDir(), "rules.bin")
	code, out, errOut := runCLI([]string{"compile", "--out", outPath, goldenPath}, nil)
	if code != exitOK {
		t.Fatalf("compile failed: %d %s %s", code, out, errOut)
	}
	f, err := os.Open(outPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	rules, err := yx.ReadFrom(f)
	if err != nil || rules.Count() != 1 {
		t.Fatalf("compiled output not loadable: %v", err)
	}
}

func TestScanReportsMatchesAndSummary(t *testing.T) {
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "hit.bin"), []byte("xx breeze_yara_fixture_marker_7f3a xx"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "clean.bin"), []byte("nothing"), 0o600)
	code, out, errOut := runCLI([]string{"scan", "--bundle", goldenPath, "--workers", "2", dir}, nil)
	if code != exitOK {
		t.Fatalf("scan failed: %d %s %s", code, out, errOut)
	}
	var lines []map[string]any
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		var m map[string]any
		if err := json.Unmarshal(sc.Bytes(), &m); err != nil {
			t.Fatalf("non-JSON line %q", sc.Text())
		}
		lines = append(lines, m)
	}
	if len(lines) != 2 {
		t.Fatalf("want 1 match line + 1 summary, got %d: %s", len(lines), out)
	}
	if lines[0]["ruleName"] != "fixture_marker" || filepath.Base(lines[0]["path"].(string)) != "hit.bin" {
		t.Fatalf("match line wrong: %+v", lines[0])
	}
	s := lines[1]
	if s["filesScanned"].(float64) != 2 || s["matches"].(float64) != 1 || s["workers"].(float64) != 2 || s["engine"] != "yara" {
		t.Fatalf("summary wrong: %+v", s)
	}
	if _, ok := s["peakRssMb"]; !ok {
		t.Fatal("summary missing peakRssMb")
	}
}

func TestScanOfNothingIsNotSuccess(t *testing.T) {
	code, out, _ := runCLI([]string{"scan", "--bundle", goldenPath, filepath.Join(t.TempDir(), "does-not-exist")}, nil)
	if code != exitUsage || !strings.Contains(out, "no files were scanned") {
		t.Fatalf("a scan of nothing must exit 2, got %d %s", code, out)
	}
}

func TestRulesExitCodeEngineFailureIsNotARuleError(t *testing.T) {
	var errb bytes.Buffer
	if got := rulesExitCode([]yarac.RuleError{{Code: yarac.CodeEngine, Message: "guest failed"}}, &errb); got != exitUsage {
		t.Fatalf("engine failure must exit 2, got %d", got)
	}
	if got := rulesExitCode([]yarac.RuleError{{Code: yarac.CodeCompile}}, &errb); got != exitRules {
		t.Fatalf("rule error must exit 1, got %d", got)
	}
	if got := rulesExitCode(nil, &errb); got != exitOK {
		t.Fatalf("no errors must exit 0, got %d", got)
	}
}

func TestScanRejectsBundleWithRuleErrors(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "bad.json")
	_ = os.WriteFile(bad, []byte(`{"format":"breeze-yara-bundle","v":1,"ruleSetId":"s","version":1,"autoQuarantine":false,"rules":[{"id":"r1","name":"broken","severity":"high","source":"rule broken { condition: "}]}`), 0o600)
	code, out, _ := runCLI([]string{"scan", "--bundle", bad, t.TempDir()}, nil)
	if code != exitRules || !strings.Contains(out, `"ruleId":"r1"`) {
		t.Fatalf("want exit 1 with the rule error, got %d %s", code, out)
	}
}

// --- match (#6267 W04-2) -----------------------------------------------------

const iocGoldenPath = "../../internal/yarascan/testdata/ioc-import.golden.json"

// frame builds match's stdin: 4-byte big-endian bundle length, bundle, sample.
func frame(bundle, sample []byte) []byte {
	out := make([]byte, 4, 4+len(bundle)+len(sample))
	binary.BigEndian.PutUint32(out, uint32(len(bundle)))
	out = append(out, bundle...)
	return append(out, sample...)
}

type matchOut struct {
	OK      bool `json:"ok"`
	Matches []struct {
		RuleSetID      string   `json:"ruleSetId"`
		RuleID         string   `json:"ruleId"`
		RuleName       string   `json:"ruleName"`
		Severity       string   `json:"severity"`
		Tags           []string `json:"tags"`
		MatchedStrings []struct {
			ID     string `json:"id"`
			Offset int64  `json:"offset"`
			Data   string `json:"data"`
		} `json:"matchedStrings"`
	} `json:"matches"`
	DurationMs  *int64            `json:"durationMs"`
	Errors      []json.RawMessage `json:"errors"`
	Unavailable string            `json:"unavailable"`
}

func parseMatch(t *testing.T, out string) matchOut {
	t.Helper()
	var m matchOut
	if err := json.Unmarshal([]byte(out), &m); err != nil {
		t.Fatalf("output is not one JSON object: %q", out)
	}
	return m
}

func TestMatchFramed(t *testing.T) {
	t.Setenv(unsandboxedEnv, "1") // the sandbox itself is proven by sandbox_linux_test.go
	golden, err := os.ReadFile(iocGoldenPath)
	if err != nil {
		t.Fatal(err)
	}
	code, out, errOut := runCLI([]string{"match", "--filename", "sample.bin"}, frame(golden, []byte("xx breeze_ioc_golden_marker xx")))
	if code != exitOK {
		t.Fatalf("want exit 0, got %d: %s %s", code, out, errOut)
	}
	m := parseMatch(t, out)
	if !m.OK || len(m.Matches) != 1 || m.DurationMs == nil {
		t.Fatalf("want ok with one match and durationMs: %s", out)
	}
	got := m.Matches[0]
	if got.RuleSetID != "00000000-0000-4000-8000-0000000010c0" || !strings.HasPrefix(got.RuleName, "ioc_golden_ioc_set_string_") ||
		got.RuleID == "" || got.Severity != "high" || len(got.Tags) != 2 || got.Tags[0] != "ioc" || got.Tags[1] != "string" {
		t.Fatalf("match fields: %+v", got)
	}
	if len(got.MatchedStrings) != 1 || got.MatchedStrings[0].Data != "breeze_ioc_golden_marker" || got.MatchedStrings[0].Offset != 3 {
		t.Fatalf("matched strings: %+v", got.MatchedStrings)
	}
}

func TestMatchFilenameAndFilepathGlobals(t *testing.T) {
	t.Setenv(unsandboxedEnv, "1")
	golden, err := os.ReadFile(iocGoldenPath)
	if err != nil {
		t.Fatal(err)
	}
	code, out, _ := runCLI([]string{"match", "--filename", "evil.exe", "--filepath", `c:\users\public\EVIL.EXE`}, frame(golden, []byte("clean")))
	m := parseMatch(t, out)
	if code != exitOK || len(m.Matches) != 1 || !strings.HasPrefix(m.Matches[0].RuleName, "ioc_golden_ioc_set_filepath_") {
		t.Fatalf("filepath IOC must match the virtual path: %d %s", code, out)
	}
	code, out, _ = runCLI([]string{"match", "--filename", "PAYLOAD.DLL"}, frame(golden, []byte("clean")))
	m = parseMatch(t, out)
	if code != exitOK || len(m.Matches) != 1 || !strings.HasPrefix(m.Matches[0].RuleName, "ioc_golden_ioc_set_filename_") {
		t.Fatalf("filename IOC must match --filename: %d %s", code, out)
	}
}

func TestMatchCompileError(t *testing.T) {
	t.Setenv(unsandboxedEnv, "1")
	bad := []byte(`{"format":"breeze-yara-bundle","v":1,"ruleSetId":"s","version":1,"autoQuarantine":false,"rules":[{"id":"r1","name":"broken","severity":"high","source":"rule broken { condition: "}]}`)
	code, out, _ := runCLI([]string{"match", "--filename", "x"}, frame(bad, []byte("abc")))
	m := parseMatch(t, out)
	if code != exitRules || m.OK || len(m.Errors) != 1 || !strings.Contains(out, `"ruleId":"r1"`) {
		t.Fatalf("want exit 1 with the r1 compile error, got %d %s", code, out)
	}
}

func TestMatchOversize(t *testing.T) {
	t.Setenv(unsandboxedEnv, "1")
	golden, err := os.ReadFile(iocGoldenPath)
	if err != nil {
		t.Fatal(err)
	}
	if code, out, _ := runCLI([]string{"match", "--filename", "x"}, frame(golden, make([]byte, maxSampleBytes+1))); code != exitUsage {
		t.Fatalf("sample over 10 MiB: want exit 2, got %d %s", code, out)
	}
	if code, out, _ := runCLI([]string{"match", "--filename", "x"}, frame(golden, make([]byte, maxSampleBytes))); code != exitOK {
		t.Fatalf("sample of exactly 10 MiB: want exit 0, got %d %s", code, out)
	}
	hdr := make([]byte, 4)
	binary.BigEndian.PutUint32(hdr, uint32(16<<20+1))
	if code, _, _ := runCLI([]string{"match", "--filename", "x"}, hdr); code != exitUsage {
		t.Fatalf("bundle length over the cap: want exit 2, got %d", code)
	}
}

func TestMatchUsageAndFraming(t *testing.T) {
	t.Setenv(unsandboxedEnv, "1")
	cases := map[string]struct {
		args  []string
		stdin []byte
	}{
		"no filename":      {[]string{"match"}, frame([]byte("{}"), nil)},
		"extra args":       {[]string{"match", "--filename", "x", "extra"}, frame([]byte("{}"), nil)},
		"short header":     {[]string{"match", "--filename", "x"}, []byte{0, 0}},
		"truncated bundle": {[]string{"match", "--filename", "x"}, append([]byte{0, 0, 0, 9}, 'x')},
	}
	for name, tc := range cases {
		if code, _, _ := runCLI(tc.args, tc.stdin); code != exitUsage {
			t.Errorf("%s: want exit 2, got %d", name, code)
		}
	}
}

func TestMatchSandboxUnavailableFailsClosed(t *testing.T) {
	if runtime.GOOS == "linux" {
		t.Skip("on linux the sandbox applies (or not) per kernel; sandbox_linux_test.go covers it")
	}
	t.Setenv(unsandboxedEnv, "")
	golden, err := os.ReadFile(iocGoldenPath)
	if err != nil {
		t.Fatal(err)
	}
	code, out, _ := runCLI([]string{"match", "--filename", "x"}, frame(golden, []byte("breeze_ioc_golden_marker")))
	m := parseMatch(t, out)
	if code != exitSandbox || m.OK || m.Unavailable != "sandbox" || len(m.Matches) != 0 {
		t.Fatalf("want exit 3 {ok:false, unavailable:sandbox} and no scan, got %d %s", code, out)
	}
}

// The stage-2 entry point re-checks the sandbox: invoked directly (no
// Landlock domain, no no_new_privs) it must refuse to scan. Safe in-process:
// the check only reads (PR_GET_NO_NEW_PRIVS, open "/").
func TestSandboxedEntryPointRefusesWithoutSandbox(t *testing.T) {
	golden, err := os.ReadFile(iocGoldenPath)
	if err != nil {
		t.Fatal(err)
	}
	code, out, _ := runCLI([]string{sandboxedSubcommand, "--abi", "6", "--oom", "1000", "--", "match", "--filename", "x"},
		frame(golden, []byte("breeze_ioc_golden_marker")))
	m := parseMatch(t, out)
	if code != exitSandbox || m.OK || m.Unavailable != "sandbox" || len(m.Matches) != 0 {
		t.Fatalf("want exit 3 {ok:false, unavailable:sandbox} and no scan, got %d %s", code, out)
	}
}
