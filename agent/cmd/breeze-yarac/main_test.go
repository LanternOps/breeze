package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	yx "github.com/niallnsec/yaraxwasm"
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

func TestScanRejectsBundleWithRuleErrors(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "bad.json")
	_ = os.WriteFile(bad, []byte(`{"format":"breeze-yara-bundle","v":1,"ruleSetId":"s","version":1,"autoQuarantine":false,"rules":[{"id":"r1","name":"broken","severity":"high","source":"rule broken { condition: "}]}`), 0o600)
	code, out, _ := runCLI([]string{"scan", "--bundle", bad, t.TempDir()}, nil)
	if code != exitRules || !strings.Contains(out, `"ruleId":"r1"`) {
		t.Fatalf("want exit 1 with the rule error, got %d %s", code, out)
	}
}
