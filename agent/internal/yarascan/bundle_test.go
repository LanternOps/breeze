package yarascan

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

func golden(t *testing.T) ([]byte, string) {
	t.Helper()
	body, err := os.ReadFile("testdata/bundle-v1.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	sum, err := os.ReadFile("testdata/bundle-v1.golden.json.sha256")
	if err != nil {
		t.Fatal(err)
	}
	return body, strings.TrimSpace(string(sum))
}

func TestParseBundleGolden(t *testing.T) {
	body, sum := golden(t)
	b, err := ParseBundle(body, sum)
	if err != nil {
		t.Fatal(err)
	}
	if b.RuleSetID != "00000000-0000-4000-8000-000000000001" || b.Version != 3 || len(b.Rules) != 1 || b.Rules[0].Name != "fixture_marker" {
		t.Fatalf("unexpected bundle: %+v", b)
	}
}

// The golden file IS the canonical serialization (C2): re-encoding the parsed
// bundle with Go's encoder (same key order, no whitespace) must reproduce it
// byte for byte, and its sha256 must match the committed pin. W03's builder
// asserts the same bytes from the TypeScript side.
func TestGoldenIsCanonical(t *testing.T) {
	body, sum := golden(t)
	if sha256Hex(body) != sum {
		t.Fatalf("golden sha256 file is stale: file says %s, bytes hash to %s", sum, sha256Hex(body))
	}
	b, err := ParseBundle(body, sum)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	enc := json.NewEncoder(&out)
	enc.SetEscapeHTML(false) // JSON.stringify does not escape <, >, &
	if err := enc.Encode(b); err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSuffix(out.String(), "\n"); got != string(body) {
		t.Fatalf("golden fixture is not canonical:\n got %s\nwant %s", got, body)
	}
}

func TestParseBundleSHA256Mismatch(t *testing.T) {
	body, _ := golden(t)
	_, err := ParseBundle(body, strings.Repeat("0", 64))
	if !errors.Is(err, ErrSHA256Mismatch) {
		t.Fatalf("want ErrSHA256Mismatch, got %v", err)
	}
}

func TestParseBundleAcceptsUppercasePin(t *testing.T) {
	body, sum := golden(t)
	if _, err := ParseBundle(body, strings.ToUpper(sum)); err != nil {
		t.Fatalf("uppercase pin rejected: %v", err)
	}
}

func TestParseBundleRejects(t *testing.T) {
	cases := map[string]string{
		"wrong format":   `{"format":"x","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[]}`,
		"future version": `{"format":"breeze-yara-bundle","v":2,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[]}`,
		"duplicate name": `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[{"id":"1","name":"r","severity":"high","source":"rule r {condition: true}"},{"id":"2","name":"r","severity":"high","source":"rule r {condition: true}"}]}`,
		"bad severity":   `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[{"id":"1","name":"r","severity":"extreme","source":"rule r {condition: true}"}]}`,
		"version zero":   `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":0,"autoQuarantine":false,"rules":[]}`,
		"unknown field":  `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[],"extra":1}`,
		"trailing data":  `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[]}{}`,
		"bad set id":     `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a b","version":1,"autoQuarantine":false,"rules":[]}`,
		"empty source":   `{"format":"breeze-yara-bundle","v":1,"ruleSetId":"a","version":1,"autoQuarantine":false,"rules":[{"id":"1","name":"r","severity":"high","source":""}]}`,
		"not json":       `nope`,
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseBundle([]byte(body), sha256Hex([]byte(body)))
			if !errors.Is(err, ErrBundleInvalid) {
				t.Fatalf("want ErrBundleInvalid, got %v", err)
			}
		})
	}
}

func TestParseBundleRejectsOversized(t *testing.T) {
	big := []byte(strings.Repeat("x", MaxBundleBytes+1))
	if _, err := ParseBundle(big, sha256Hex(big)); !errors.Is(err, ErrBundleInvalid) {
		t.Fatalf("oversized bundle: want ErrBundleInvalid, got %v", err)
	}
}

func validRef() map[string]any {
	return map[string]any{"id": "x", "version": float64(1), "sha256": strings.Repeat("a", 64), "url": "/api/v1/agents/a/yara/rule-sets/x/1"}
}

func TestParseRuleSetRefsAbsent(t *testing.T) {
	refs, err := ParseRuleSetRefs(nil)
	if err != nil || refs != nil {
		t.Fatalf("absent ruleSets must be (nil,nil), got %v %v", refs, err)
	}
}

func TestParseRuleSetRefsValid(t *testing.T) {
	m := validRef()
	m["sha256"] = strings.Repeat("A", 64)
	m["version"] = json.Number("7")
	refs, err := ParseRuleSetRefs([]any{m})
	if err != nil || len(refs) != 1 {
		t.Fatalf("valid ref rejected: %v", err)
	}
	if refs[0].Version != 7 || refs[0].SHA256 != strings.Repeat("a", 64) || refs[0].URL != "/api/v1/agents/a/yara/rule-sets/x/1" {
		t.Fatalf("ref not normalized: %+v", refs[0])
	}
}

func TestParseRuleSetRefsRejectsOffHostURL(t *testing.T) {
	for _, u := range []string{
		"https://evil.example/api/v1/agents/a/yara/rule-sets/x/1",
		"//evil.example/api/v1/agents/a/yara/rule-sets/x/1",
		"/api/v1/agents/../../admin",
		"/api/v1/agents/a/yara/rule-sets/x/1?redirect=1",
		"/api/v1/agents/a/yara/rule-sets/x/1#frag",
		"/other/path",
		`/api/v1/agents/a\yara`,
		"/api/v1/agents//evil.example/x",
		"/api/v1/agents/a/%2e%2e/x",
		"/api/v1/agents/a b",
		"/api/v1/agents/",
		"",
	} {
		raw := validRef()
		raw["url"] = u
		if _, err := ParseRuleSetRefs([]any{raw}); err == nil {
			t.Errorf("url %q accepted", u)
		}
	}
}

func TestParseRuleSetRefsRejectsMalformed(t *testing.T) {
	mutate := map[string]func(m map[string]any){
		"missing key":     func(m map[string]any) { delete(m, "url") },
		"extra key":       func(m map[string]any) { m["extra"] = true },
		"fractional ver":  func(m map[string]any) { m["version"] = 1.5 },
		"zero ver":        func(m map[string]any) { m["version"] = float64(0) },
		"string ver":      func(m map[string]any) { m["version"] = "1" },
		"short sha":       func(m map[string]any) { m["sha256"] = "abc" },
		"non-hex sha":     func(m map[string]any) { m["sha256"] = strings.Repeat("z", 64) },
		"empty id":        func(m map[string]any) { m["id"] = "" },
		"id with slash":   func(m map[string]any) { m["id"] = "a/b" },
		"numeric id":      func(m map[string]any) { m["id"] = float64(3) },
		"url not string":  func(m map[string]any) { m["url"] = float64(3) },
		"sha not string":  func(m map[string]any) { m["sha256"] = nil },
		"version as bool": func(m map[string]any) { m["version"] = true },
	}
	for name, fn := range mutate {
		t.Run(name, func(t *testing.T) {
			m := validRef()
			fn(m)
			if _, err := ParseRuleSetRefs([]any{m}); err == nil {
				t.Fatal("malformed ref accepted")
			}
		})
	}
	if _, err := ParseRuleSetRefs("not-an-array"); err == nil {
		t.Error("non-array accepted")
	}
	if _, err := ParseRuleSetRefs([]any{"str"}); err == nil {
		t.Error("non-object entry accepted")
	}
	if _, err := ParseRuleSetRefs([]any{validRef(), validRef()}); err == nil {
		t.Error("duplicate set id accepted")
	}
}

func TestParseRuleSetRefsCapsCount(t *testing.T) {
	var raw []any
	for i := 0; i < MaxRuleSets+1; i++ {
		m := validRef()
		m["id"] = "x" + strings.Repeat("y", i)
		raw = append(raw, m)
	}
	if _, err := ParseRuleSetRefs(raw); err == nil {
		t.Fatal("more than MaxRuleSets accepted")
	}
	if _, err := ParseRuleSetRefs(raw[:MaxRuleSets]); err != nil {
		t.Fatalf("exactly MaxRuleSets rejected: %v", err)
	}
}

func TestTruncateKeepsUTF8(t *testing.T) {
	s := strings.Repeat("a", 511) + "é" // é is 2 bytes, straddles the cap
	got := truncate(s, 512)
	if len(got) != 511 || !strings.HasPrefix(s, got) {
		t.Fatalf("truncate split a rune: len %d", len(got))
	}
}
