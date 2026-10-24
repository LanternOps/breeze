package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/expected-bundle.json")

// The test binary doubles as a fake `breeze-yarac validate` (FAKE_YARAC=1) so
// the drop/retry loop is exercised without the real engine. CI's yara-pack-fp
// job runs the filter against the real breeze-yarac.
func TestMain(m *testing.M) {
	if os.Getenv("FAKE_YARAC") == "1" {
		os.Exit(fakeYarac(os.Args[1:], os.Stdin, os.Stdout))
	}
	os.Exit(m.Run())
}

type fakeRule struct {
	ID, Name, Severity, Source string
}

func fakeYarac(args []string, stdin io.Reader, stdout io.Writer) int {
	if len(args) != 1 || args[0] != "validate" {
		return 2
	}
	if os.Getenv("FAKE_YARAC_ENGINE_FAIL") == "1" {
		fmt.Fprintln(os.Stderr, "engine down")
		return 2
	}
	var b struct {
		Rules []fakeRule `json:"rules"`
	}
	body, _ := io.ReadAll(stdin)
	if err := json.Unmarshal(body, &b); err != nil {
		return 2
	}
	type ruleErr struct {
		RuleID  string `json:"ruleId"`
		Name    string `json:"name"`
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	var errs []ruleErr
	strs := 0
	for _, r := range b.Rules {
		if strings.Contains(r.Source, "FAKE_COMPILE_ERROR") {
			errs = append(errs, ruleErr{RuleID: r.ID, Name: r.Name, Code: "compile", Message: "fake compile error"})
		}
		strs += strings.Count(r.Source, "$")
	}
	if len(errs) == 0 {
		if lim := os.Getenv("FAKE_YARAC_MAX_DOLLARS"); lim != "" {
			var n int
			fmt.Sscan(lim, &n)
			if strs > n {
				errs = append(errs, ruleErr{Code: "cap_strings", Message: fmt.Sprintf("%d strings exceeds the cap of %d", strs, n)})
			}
		}
	}
	out, _ := json.Marshal(map[string]any{"ok": len(errs) == 0, "errors": errs})
	stdout.Write(out)
	stdout.Write([]byte("\n"))
	if len(errs) > 0 {
		return 1
	}
	return 0
}

func fixtureConfig(t *testing.T) Config {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("FAKE_YARAC", "1")
	allow, err := ParseLicenseAllowlist(strings.NewReader("Apache-2.0\nMIT\nBSD-2-Clause\nBSD-3-Clause\nCC0-1.0\n"))
	if err != nil {
		t.Fatal(err)
	}
	deny, err := ParseDenylist(strings.NewReader("# comment\nALLOWAPACHE_Denied  known false positive on fixture corpus\n"))
	if err != nil {
		t.Fatal(err)
	}
	return Config{
		ForgeTag:     "20990101",
		ForgeSHA256:  strings.Repeat("ab", 32),
		PackVersion:  7,
		Allowed:      allow,
		Denylist:     deny,
		YaracPath:    exe,
		MaxRules:     500,
		StringsCap:   10000,
		MinScore:     50,
		MinKeptRules: 1,
	}
}

func buildFixture(t *testing.T, cfg Config) *Result {
	t.Helper()
	src, err := os.ReadFile("testdata/forge-fixture.yar")
	if err != nil {
		t.Fatal(err)
	}
	res, err := Build(src, cfg)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return res
}

func keptNames(r *Result) []string {
	var out []string
	for _, k := range r.Report.Kept {
		out = append(out, k.Name)
	}
	sort.Strings(out)
	return out
}

func TestLicenseFilterKeepsPermissiveAndDropsTheRest(t *testing.T) {
	res := buildFixture(t, fixtureConfig(t))

	wantKept := []string{
		"ALLOWAPACHE_Ok", "ALLOWAPACHE_Pe", "ALLOWAPACHE_Tricky",
		"BSDTHREE_Ok", "BSDTWO_Ok", "CC0REPO_Ok", "MITREPO_Ok", "NOLICENSE_MetaMit",
	}
	if got := keptNames(res); strings.Join(got, ",") != strings.Join(wantKept, ",") {
		t.Fatalf("kept:\n got %v\nwant %v", got, wantKept)
	}

	wantDropped := map[string]string{
		"ALLOWAPACHE_Cuckoo":        "module_unsupported",
		"ALLOWAPACHE_Private":       "private_or_global",
		"ALLOWAPACHE_Denied":        "denylist",
		"ALLOWAPACHE_CompileError":  "validate",
		"ALLOWAPACHE_LowScore":      "score_below_min",
		"ALLOWAPACHE_LineSeparator": "source_encoding",
		"BSDTWO_MetaDrl":            "license_not_allowed",
		"ELASTICREPO_X":             "license_not_allowed",
		"DRLREPO_X":                 "license_not_allowed",
		"GPLREPO_X":                 "license_not_allowed",
		"NOLICENSE_X":               "license_missing",
		"NOLICENSE_MetaCcBy":        "license_not_allowed",
	}
	got := map[string]string{}
	for _, d := range res.Report.Dropped {
		got[d.Name] = d.Reason
	}
	for name, reason := range wantDropped {
		if got[name] != reason {
			t.Errorf("%s: dropped reason %q, want %q (detail in report)", name, got[name], reason)
		}
	}
	if len(got) != len(wantDropped) {
		t.Errorf("dropped %d rules, want %d: %v", len(got), len(wantDropped), got)
	}
	// Every parsed rule is accounted for exactly once.
	if res.Report.Counts.Parsed != len(wantKept)+len(wantDropped) {
		t.Errorf("parsed %d, want %d", res.Report.Counts.Parsed, len(wantKept)+len(wantDropped))
	}
}

func TestDroppedLicenseDetailNamesTheLicense(t *testing.T) {
	res := buildFixture(t, fixtureConfig(t))
	want := map[string]string{
		"ELASTICREPO_X":      "Elastic-2.0",
		"DRLREPO_X":          "DRL-1.1",
		"GPLREPO_X":          "GPL",
		"BSDTWO_MetaDrl":     "DRL-1.1",
		"NOLICENSE_MetaCcBy": "CC-BY-4.0",
	}
	for _, d := range res.Report.Dropped {
		if w, ok := want[d.Name]; ok && !strings.Contains(d.Detail, w) {
			t.Errorf("%s: detail %q does not name %s", d.Name, d.Detail, w)
		}
	}
}

func TestBundleIsCanonicalAndMatchesGolden(t *testing.T) {
	res := buildFixture(t, fixtureConfig(t))
	if *update {
		if err := os.WriteFile("testdata/expected-bundle.json", res.Bundle, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile("testdata/expected-bundle.json")
	if err != nil {
		t.Fatalf("%v (run go test -run TestBundleIsCanonicalAndMatchesGolden -update)", err)
	}
	if !bytes.Equal(res.Bundle, want) {
		t.Fatalf("bundle differs from golden:\n got %s\nwant %s", res.Bundle, want)
	}
	if bytes.HasSuffix(res.Bundle, []byte("\n")) {
		t.Fatal("bundle must not end with a newline")
	}
	var b struct {
		Format         string `json:"format"`
		V              int    `json:"v"`
		RuleSetID      string `json:"ruleSetId"`
		Version        int    `json:"version"`
		AutoQuarantine bool   `json:"autoQuarantine"`
		Rules          []fakeRule
	}
	if err := json.Unmarshal(res.Bundle, &b); err != nil {
		t.Fatal(err)
	}
	if b.Format != "breeze-yara-bundle" || b.V != 1 || b.RuleSetID != BuiltinRuleSetID || b.Version != 7 || !b.AutoQuarantine {
		t.Fatalf("bundle header wrong: %+v", b)
	}
	for i := 1; i < len(b.Rules); i++ {
		if b.Rules[i-1].ID >= b.Rules[i].ID {
			t.Fatalf("rules not sorted by id: %s >= %s", b.Rules[i-1].ID, b.Rules[i].ID)
		}
	}
	if res.SHA256 != sha256Hex(res.Bundle) {
		t.Fatal("SHA256 does not hash the bundle bytes")
	}
}

func TestBuildIsDeterministic(t *testing.T) {
	a := buildFixture(t, fixtureConfig(t))
	b := buildFixture(t, fixtureConfig(t))
	if !bytes.Equal(a.Bundle, b.Bundle) {
		t.Fatal("bundle differs between runs")
	}
	ra, _ := json.Marshal(a.Report)
	rb, _ := json.Marshal(b.Report)
	if !bytes.Equal(ra, rb) {
		t.Fatal("report differs between runs")
	}
}

// Our encoder must reproduce the agent's canonical golden bundle byte for
// byte — the same contract the TypeScript builder is held to.
func TestEncoderReproducesAgentGolden(t *testing.T) {
	golden, err := os.ReadFile(filepath.Join("..", "..", "..", "agent", "internal", "yarascan", "testdata", "bundle-v1.golden.json"))
	if err != nil {
		t.Fatal(err)
	}
	var b Bundle
	if err := json.Unmarshal(golden, &b); err != nil {
		t.Fatal(err)
	}
	out, err := encodeBundle(b)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(out, golden) {
		t.Fatalf("encoder is not canonical:\n got %s\nwant %s", out, golden)
	}
}

func TestRuleIDsAreUUIDv5OfName(t *testing.T) {
	// RFC 4122 appendix vector (DNS namespace, "python.org").
	if got := uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org"); got != "886313e1-3b8a-5372-9b90-0c9aee199e5d" {
		t.Fatalf("uuidV5 vector: %s", got)
	}
	res := buildFixture(t, fixtureConfig(t))
	for _, k := range res.Report.Kept {
		if k.ID != uuidV5(BuiltinRuleSetID, k.Name) {
			t.Errorf("%s: id %s is not UUIDv5(builtin, name)", k.Name, k.ID)
		}
	}
}

func TestModuleImportsArePrependedPerRule(t *testing.T) {
	res := buildFixture(t, fixtureConfig(t))
	var b struct{ Rules []fakeRule }
	if err := json.Unmarshal(res.Bundle, &b); err != nil {
		t.Fatal(err)
	}
	for _, r := range b.Rules {
		hasPe := strings.Contains(r.Source, `import "pe"`)
		if (r.Name == "ALLOWAPACHE_Pe") != hasPe {
			t.Errorf("%s: import \"pe\" present=%v", r.Name, hasPe)
		}
		if strings.Count(r.Source, "rule "+r.Name) != 1 {
			t.Errorf("%s: source must declare the rule exactly once", r.Name)
		}
		if !strings.Contains(r.Source, "license ") {
			t.Errorf("%s: source lacks the attribution comment", r.Name)
		}
	}
}

func TestSeverityFromScore(t *testing.T) {
	cases := map[int]string{95: "critical", 90: "critical", 80: "high", 75: "high", 60: "medium", 59: "low", 0: "low"}
	for score, want := range cases {
		if got := severityForScore(score, true); got != want {
			t.Errorf("score %d: %s, want %s", score, got, want)
		}
	}
	if got := severityForScore(0, false); got != "high" {
		t.Errorf("missing score: %s, want high", got)
	}
}

func TestStringsCapShrinksSelectionUntilValid(t *testing.T) {
	cfg := fixtureConfig(t)
	// Each kept fixture source carries one or two "$"; cap at 6 forces drops.
	t.Setenv("FAKE_YARAC_MAX_DOLLARS", "6")
	res := buildFixture(t, cfg)
	if len(res.Report.Kept) == 0 || len(res.Report.Kept) >= 8 {
		t.Fatalf("kept %d rules, want a shrunken non-empty pack", len(res.Report.Kept))
	}
	notSelected := 0
	for _, d := range res.Report.Dropped {
		if d.Reason == "not_selected" {
			notSelected++
		}
	}
	if notSelected == 0 {
		t.Fatal("want rules recorded as not_selected after the strings cap")
	}
}

func TestMaxRulesCapsAndRecordsTheRest(t *testing.T) {
	cfg := fixtureConfig(t)
	cfg.MaxRules = 3
	res := buildFixture(t, cfg)
	if len(res.Report.Kept) != 3 {
		t.Fatalf("kept %d, want 3", len(res.Report.Kept))
	}
	// Highest quality first: ALLOWAPACHE_Ok (90) leads.
	found := false
	for _, k := range res.Report.Kept {
		if k.Name == "ALLOWAPACHE_Ok" {
			found = true
		}
	}
	if !found {
		t.Fatal("selection must prefer the highest-quality rule")
	}
}

func TestEngineFailureIsFatalNotADrop(t *testing.T) {
	cfg := fixtureConfig(t)
	t.Setenv("FAKE_YARAC_ENGINE_FAIL", "1")
	src, _ := os.ReadFile("testdata/forge-fixture.yar")
	if _, err := Build(src, cfg); err == nil || !strings.Contains(err.Error(), "breeze-yarac") {
		t.Fatalf("want a fatal breeze-yarac error, got %v", err)
	}
}

func TestMinKeptRulesFloor(t *testing.T) {
	cfg := fixtureConfig(t)
	cfg.MinKeptRules = 100
	src, _ := os.ReadFile("testdata/forge-fixture.yar")
	_, err := Build(src, cfg)
	if !errors.Is(err, ErrTooFewRules) {
		t.Fatalf("want ErrTooFewRules, got %v", err)
	}
}

func TestDenylistRequiresAReason(t *testing.T) {
	if _, err := ParseDenylist(strings.NewReader("SOME_RULE\n")); err == nil {
		t.Fatal("a denylist entry without a reason must be rejected")
	}
	if _, err := ParseDenylist(strings.NewReader("bad-name reason\n")); err == nil {
		t.Fatal("a malformed rule name must be rejected")
	}
}

func TestLicenseAllowlistRejectsCopyleftAndUnknownIDs(t *testing.T) {
	for _, bad := range []string{"GPL-3.0", "DRL-1.1", "Elastic-2.0", "CC-BY-4.0", "Whatever"} {
		if _, err := ParseLicenseAllowlist(strings.NewReader(bad + "\n")); err == nil {
			t.Errorf("allowlist accepted %s", bad)
		}
	}
}

func TestClassifyLicenseText(t *testing.T) {
	cases := map[string]string{
		"NO LICENSE SET":       licenseNone,
		"":                     licenseNone,
		"Apache License\n Version 2.0, January 2004": "Apache-2.0",
		"MIT License\n\nPermission is hereby granted, free of charge, to any person": "MIT",
		"# Detection Rule License (DRL) 1.1\nPermission is hereby granted, free of charge": "DRL-1.1",
		"GNU GENERAL PUBLIC LICENSE Version 3":                                           "GPL",
		"GNU LESSER GENERAL PUBLIC LICENSE":                                              "GPL",
		"Elastic License 2.0":                                                            "Elastic-2.0",
		"The 2-Clause BSD License\nRedistribution and use in source and binary forms":    "BSD-2-Clause",
		"Redistribution and use in source and binary forms\n3. Neither the name of":      "BSD-3-Clause",
		"CC0 1.0 Universal":                                                              "CC0-1.0",
		"Creative Commons Attribution-NonCommercial 4.0":                                 "NonCommercial",
		"All rights reserved. Do not copy.":                                              licenseUnknown,
	}
	for text, want := range cases {
		if got := classifyLicenseText(text); got != want {
			t.Errorf("%q: %s, want %s", text, got, want)
		}
	}
}

func TestClassifyLicenseMeta(t *testing.T) {
	cases := map[string]string{
		"MIT":                    "MIT",
		"BSD 2-Clause":           "BSD-2-Clause",
		"Apache License 2.0":     "Apache-2.0",
		"DRL-1.1":                "DRL-1.1",
		"CC BY 4.0":              "CC-BY-4.0",
		"See license at https://x/LICENSE": licenseDefer,
		"This Yara rule is provided under the Apache License 2.0 (https://www.apache.org/licenses/LICENSE-2.0)": "Apache-2.0",
	}
	for v, want := range cases {
		if got := classifyLicenseMeta(v); got != want {
			t.Errorf("%q: %s, want %s", v, got, want)
		}
	}
}
