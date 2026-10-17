package yarac

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"

	yx "github.com/niallnsec/yaraxwasm"
)

func set(id string, rules ...Rule) Set { return Set{ID: id, Rules: rules} }
func r(name, src string) Rule {
	return Rule{ID: "id-" + name, Name: name, Severity: "high", Source: src}
}

func TestValidateAcceptsMarkerRule(t *testing.T) {
	if errs := ValidateSet(set("s1", r("fixture_marker", markerRule)), DefaultPolicy); len(errs) != 0 {
		t.Fatalf("unexpected errors: %+v", errs)
	}
}

func TestValidateRejectsPolicyViolations(t *testing.T) {
	cases := map[string]struct {
		rule Rule
		code string
	}{
		"console":         {r("c", `import "console" rule c { condition: console.log("x") }`), CodeCompile},
		"include":         {r("i", `include "other.yar" rule i { condition: true }`), CodeCompile},
		"include nospace": {r("j", "include\"other.yar\"\nrule j { condition: true }"), CodeCompile},
		"unknown ident":   {r("u", `rule u { condition: some_external_var == 1 }`), CodeCompile},
		"syntax":          {r("s", `rule s { condition: `), CodeCompile},
		"slow pattern":    {r("p", `rule p { strings: $a = /a.*/ condition: $a }`), CodeCompile},
		"name mismatch":   {r("expected_name", `rule other_name { condition: true }`), CodeOneRule},
		"two rules":       {r("a", `rule a { condition: true } rule b { condition: true }`), CodeOneRule},
		"private helper":  {r("h", `private rule helper { condition: true } rule h { condition: helper }`), CodeOneRule},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			errs := ValidateSet(set("s", tc.rule), DefaultPolicy)
			if len(errs) == 0 || errs[0].RuleID != tc.rule.ID || errs[0].Code != tc.code || errs[0].Message == "" {
				t.Fatalf("want a %s error attributed to %s, got %+v", tc.code, tc.rule.ID, errs)
			}
		})
	}
}

// A failing rule does not poison the compiler: every failing rule in a set is
// reported, each attributed to its own id, and good rules produce no error.
func TestValidateAttributesEachFailingRule(t *testing.T) {
	errs := ValidateSet(set("s",
		r("good_one", `rule good_one { condition: true }`),
		r("bad_one", `rule bad_one { condition: `),
		r("bad_two", `rule bad_two { condition: nope_ident }`),
	), DefaultPolicy)
	if len(errs) != 2 || errs[0].RuleID != "id-bad_one" || errs[1].RuleID != "id-bad_two" {
		t.Fatalf("want errors for bad_one and bad_two only, got %+v", errs)
	}
	if errs[0].Line == 0 {
		t.Errorf("compile error should carry a line number: %+v", errs[0])
	}
}

func TestValidateCaps(t *testing.T) {
	p := Policy{MaxRulesPerSet: 1, MaxRuleSourceBytes: 64, MaxStringsPerSet: 10000}
	if errs := ValidateSet(set("s", r("a", `rule a { condition: true }`), r("b", `rule b { condition: true }`)), p); len(errs) == 0 || errs[0].Code != CodeCapRules {
		t.Errorf("rule count cap not enforced: %+v", errs)
	}
	long := `rule a { condition: true } // ` + strings.Repeat("x", 80)
	if errs := ValidateSet(set("s", r("a", long)), p); len(errs) == 0 || errs[0].Code != CodeCapSource {
		t.Errorf("source size cap not enforced: %+v", errs)
	}
	strs := Policy{MaxRulesPerSet: 10, MaxRuleSourceBytes: 4096, MaxStringsPerSet: 2}
	src := `rule a { strings: $a = "aaaa" $b = "bbbb" $c = "cccc" condition: any of them }`
	if errs := ValidateSet(set("s", r("a", src)), strs); len(errs) != 1 || errs[0].Code != CodeCapStrings {
		t.Errorf("strings cap not enforced: %+v", errs)
	}
	strs.MaxStringsPerSet = 3
	if errs := ValidateSet(set("s", r("a", src)), strs); len(errs) != 0 {
		t.Errorf("strings exactly at cap rejected: %+v", errs)
	}
}

func TestFilenameGlobalsAllowed(t *testing.T) {
	src := `rule g { condition: filename == "x" or filepath contains "y" or extension == "exe" }`
	if errs := ValidateSet(set("s", r("g", src)), DefaultPolicy); len(errs) != 0 {
		t.Fatalf("filename/filepath/extension must be defined: %+v", errs)
	}
}

func TestCompileSetsIsolatesFailingSet(t *testing.T) {
	good := set("good", r("fixture_marker", markerRule))
	bad := set("bad", r("s", `rule s { condition: `))
	rules, errs, err := CompileSets([]Set{good, bad}, DefaultPolicy)
	if err != nil || rules == nil {
		t.Fatalf("compile failed: %v", err)
	}
	if len(errs["bad"]) == 0 || len(errs["good"]) != 0 {
		t.Fatalf("errors not isolated per set: %+v", errs)
	}
	if rules.Count() != 1 || rules.Slice()[0].Namespace() != "good" {
		t.Fatalf("combined rules must hold only the good set, namespaced by id: %d rules", rules.Count())
	}
}

func TestCompileSetsAllFailReturnsNil(t *testing.T) {
	rules, errs, err := CompileSets([]Set{set("bad", r("s", `rule s { condition: `))}, DefaultPolicy)
	if rules != nil || err != nil || len(errs["bad"]) == 0 {
		t.Fatalf("want (nil, errs, nil), got %v %+v %v", rules, errs, err)
	}
}

func TestCompileSetsSameRuleNameDifferentNamespaces(t *testing.T) {
	a := set("a", r("fixture_marker", markerRule))
	b := set("b", r("fixture_marker", markerRule))
	rules, errs, err := CompileSets([]Set{a, b}, DefaultPolicy)
	if err != nil || len(errs["a"])+len(errs["b"]) != 0 || rules.Count() != 2 {
		t.Fatalf("namespaces must keep same-named rules apart: %v %+v", err, errs)
	}
}

func TestEngineVersionPinned(t *testing.T) {
	// Test binaries carry module build info, so this must be the pinned
	// version from go.mod, never "unknown" — the cache key depends on it.
	if v := EngineVersion(); v == "unknown" || !strings.HasPrefix(v, "v") {
		t.Fatalf("EngineVersion() = %q", v)
	}
}

// The engine loads once per process, so the override check runs in a fresh
// child process where EnsureEngine is the very first engine call.
func TestEnsureEngineIgnoresGuestOverride(t *testing.T) {
	if os.Getenv("BREEZE_YARAC_OVERRIDE_CHILD") == "1" {
		if err := EnsureEngine(); err != nil {
			fmt.Println("ENGINE_ERR", err)
			os.Exit(3)
		}
		if os.Getenv(guestOverrideEnv) != "" {
			fmt.Println("OVERRIDE_STILL_SET")
			os.Exit(4)
		}
		if errs := ValidateSet(set("s", r("fixture_marker", markerRule)), DefaultPolicy); len(errs) != 0 {
			fmt.Println("COMPILE_ERR", errs)
			os.Exit(5)
		}
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestEnsureEngineIgnoresGuestOverride$")
	cmd.Env = append(os.Environ(), "BREEZE_YARAC_OVERRIDE_CHILD=1", guestOverrideEnv+"=/nonexistent/evil.wasm")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("child with %s set failed (%v): %s", guestOverrideEnv, err, out)
	}

	// Control: the same child WITHOUT EnsureEngine's guard would fail to read
	// the bogus path — proves the env var is live in yaraxwasm, so the pass
	// above is the guard working.
	ctl := exec.Command(os.Args[0], "-test.run=^TestGuestOverrideControlChild$")
	ctl.Env = append(os.Environ(), "BREEZE_YARAC_OVERRIDE_CHILD=1", guestOverrideEnv+"=/nonexistent/evil.wasm")
	if out, err := ctl.CombinedOutput(); err == nil {
		t.Fatalf("control: yaraxwasm ignored %s even without the guard: %s", guestOverrideEnv, out)
	}
}

func TestGuestOverrideControlChild(t *testing.T) {
	if os.Getenv("BREEZE_YARAC_OVERRIDE_CHILD") != "1" {
		t.Skip("control child only")
	}
	if _, err := yx.Compile(markerRule); err != nil {
		fmt.Println("CONTROL_LOAD_FAILED", err)
		os.Exit(6)
	}
	os.Exit(0)
}
