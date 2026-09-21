package tools

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// Cross-language contract for the disk-cleanup rule table (spec §6.1).
//
// packages/shared/src/utils/cleanupRules.json is the source of truth. go:embed
// cannot leave this module, so cleanup_rules.json here is a COPY and the test
// below compares the two byte-for-byte. Do not "fix" a drift failure by editing
// the copy alone — edit the shared file and re-copy, so the API, the web UI and
// the agent keep agreeing about what may be deleted.
//
// The classification fixtures are the same file the TypeScript matcher replays
// (packages/shared/src/utils/cleanupRules.test.ts). If the two matchers drift,
// one of the two suites goes red.

const (
	sharedCleanupRulesPath   = "../../../../packages/shared/src/utils/cleanupRules.json"
	sharedCleanupFixturePath = "../../../../packages/shared/src/fixtures/cleanupRules.fixtures.json"
)

type cleanupFixtureCase struct {
	OS          string  `json:"os"`
	Path        string  `json:"path"`
	AgeHours    float64 `json:"ageHours"`
	Category    *string `json:"category"`
	Granularity *string `json:"granularity"`
	Note        string  `json:"note"`
}

type cleanupDeniedFixtureCase struct {
	OS     string `json:"os"`
	Path   string `json:"path"`
	Denied bool   `json:"denied"`
}

type cleanupFixtureFile struct {
	Cases       []cleanupFixtureCase       `json:"cases"`
	DeniedRoots []cleanupDeniedFixtureCase `json:"deniedRoots"`
}

func loadCleanupFixtures(t *testing.T) cleanupFixtureFile {
	t.Helper()
	raw, err := os.ReadFile(filepath.FromSlash(sharedCleanupFixturePath))
	if err != nil {
		t.Fatalf("read shared cleanup fixtures: %v\n"+
			"This test is the agent half of a cross-language contract; the fixtures live in packages/shared.", err)
	}
	var fx cleanupFixtureFile
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatalf("parse shared cleanup fixtures: %v", err)
	}
	if len(fx.Cases) < 40 || len(fx.DeniedRoots) < 10 {
		t.Fatalf("cleanup fixture table is too small (cases=%d deniedRoots=%d) — a vacuous contract test is worse than none",
			len(fx.Cases), len(fx.DeniedRoots))
	}
	return fx
}

func TestEmbeddedCleanupRulesMatchSharedSource(t *testing.T) {
	shared, err := os.ReadFile(filepath.FromSlash(sharedCleanupRulesPath))
	if err != nil {
		t.Fatalf("read shared cleanup rules: %v", err)
	}
	if !bytes.Equal(shared, cleanupRulesJSON) {
		t.Fatalf("embedded cleanup_rules.json has drifted from packages/shared/src/utils/cleanupRules.json\n" +
			"fix: cp packages/shared/src/utils/cleanupRules.json agent/internal/remote/tools/cleanup_rules.json")
	}
}

func TestCleanupComponentGlobGrammar(t *testing.T) {
	cases := []struct {
		pattern string
		name    string
		want    bool
	}{
		{"*", "anything", true},
		{"systemd-private-*", "systemd-private-abc", true},
		{"systemd-private-*", "systemd-public-abc", false},
		{"*.nupkg", "foo.1.0.nupkg", true},
		{"*.nupkg", "foo.dll", false},
		{"cache", "cache", true},
		{"cache", "cache2", false},
		{"com.apple.icloud*", "com.apple.iclouddrive", true},
	}
	for _, c := range cases {
		if got := matchCleanupComponentGlob(c.pattern, c.name); got != c.want {
			t.Errorf("matchCleanupComponentGlob(%q, %q) = %v, want %v", c.pattern, c.name, got, c.want)
		}
	}
}

func TestCleanupComponentsDoubleStarConsumesAtLeastOne(t *testing.T) {
	if !matchCleanupComponents([]string{"tmp", "**"}, []string{"tmp", "a"}) {
		t.Error("/tmp/** should match /tmp/a")
	}
	if !matchCleanupComponents([]string{"tmp", "**"}, []string{"tmp", "a", "b", "c"}) {
		t.Error("/tmp/** should match a deep descendant")
	}
	if matchCleanupComponents([]string{"tmp", "**"}, []string{"tmp"}) {
		t.Error("/tmp/** must NOT match /tmp itself — a scanned directory is not a file candidate")
	}
	if !matchCleanupComponents([]string{"a", "**", "*.nupkg"}, []string{"a", "b", "c", "x.nupkg"}) {
		t.Error("** in the middle followed by a suffix glob should match")
	}
	if matchCleanupComponents([]string{"a", "**", "*.nupkg"}, []string{"a", "b", "c", "x.dll"}) {
		t.Error("suffix glob should not match a different extension")
	}
}

func TestNormalizeCleanupPathAnchorsWindowsVolume(t *testing.T) {
	cases := []struct{ goos, in, want string }{
		{"windows", `C:\Windows\Temp\A.TMP`, "<vol>/windows/temp/a.tmp"},
		{"windows", `d:/Users//bob/`, "<vol>/users/bob"},
		{"windows", `C:\`, "<vol>"},
		{"darwin", "/", "/"},
		// Per-OS normalisation (spec §13 row 10).
		{"linux", "/TMP//a/", "/TMP/a"},
		{"linux", "/tmp//a/", "/tmp/a"},
		{"darwin", "/Users/Alice/Library/Caches", "/users/alice/library/caches"},
		{"darwin", `/Users/alice/.cache\v`, `/users/alice/.cache\v`},
	}
	for _, c := range cases {
		if got := normalizeCleanupPathFor(c.goos, c.in); got != c.want {
			t.Errorf("normalizeCleanupPathFor(%q, %q) = %q, want %q", c.goos, c.in, got, c.want)
		}
	}
}

func TestClassifyCleanupPathMatchesSharedFixtures(t *testing.T) {
	fx := loadCleanupFixtures(t)
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	for _, c := range fx.Cases {
		modTime := now.Add(-time.Duration(c.AgeHours * float64(time.Hour)))
		category, granularity, safe := classifyCleanupPathFor(c.OS, c.Path, modTime, now)
		wantCategory, wantGranularity := "", ""
		if c.Category != nil {
			wantCategory = *c.Category
		}
		if c.Granularity != nil {
			wantGranularity = *c.Granularity
		}
		if category != wantCategory || granularity != wantGranularity {
			t.Errorf("%s %s: got %q/%q, want %q/%q (%s)",
				c.OS, c.Path, category, granularity, wantCategory, wantGranularity, c.Note)
		}
		if safe != (wantCategory != "") {
			t.Errorf("%s %s: safe = %v, want %v", c.OS, c.Path, safe, wantCategory != "")
		}
	}
}

func TestIsCleanupDeniedRootMatchesSharedFixtures(t *testing.T) {
	fx := loadCleanupFixtures(t)
	for _, c := range fx.DeniedRoots {
		if got := isCleanupDeniedRootFor(c.OS, c.Path); got != c.Denied {
			t.Errorf("isCleanupDeniedRootFor(%q, %q) = %v, want %v", c.OS, c.Path, got, c.Denied)
		}
	}
}

func TestDeniedRootVetoesAMatchingRule(t *testing.T) {
	if matchCleanupRuleFor("linux", "/tmp/build.tmp") == nil {
		t.Fatal("precondition: /tmp/build.tmp must match a rule")
	}
	if category, _, _ := classifyCleanupPathFor("linux", "/etc/passwd", time.Time{}, time.Now()); category != "" {
		t.Errorf("/etc/passwd classified as %q; denied roots must veto", category)
	}
	if category, _, _ := classifyCleanupPathFor("windows", `C:\Windows\System32\config\x`, time.Time{}, time.Now()); category != "" {
		t.Errorf("System32 classified as %q; denied roots must veto", category)
	}
}

func TestCleanupRuleAnchorIsTheLiteralPrefix(t *testing.T) {
	// The anchor is what os.OpenRoot is called on, so it must be the part of
	// the path the RULE AUTHOR fixed, never a component an attacker can create.
	cases := []struct {
		goos, path, want string
		ok               bool
	}{
		{"linux", "/home/bob/.cache/sub/x", "/home", true},
		{"linux", "/var/cache/apt/archives/nginx.deb", "/var/cache/apt/archives", true},
		{"darwin", "/Users/alice/Library/Caches/com.example/x", "/Users", true},
		{"windows", `C:\Users\alice\AppData\Local\Temp\x`, `C:\Users`, true},
		{"windows", `D:\$Recycle.Bin\S-1-5-21-1`, `D:\$Recycle.Bin`, true},
		{"linux", "/root/.local/share/Trash", "/root/.local/share", true}, // fully literal: anchor steps up (#6375)
		{"linux", "/home/bob/Documents/taxes.pdf", "", false},
	}
	for _, c := range cases {
		got, ok := cleanupRuleAnchorFor(c.goos, c.path)
		if ok != c.ok || (c.ok && got != c.want) {
			t.Errorf("cleanupRuleAnchorFor(%q, %q) = %q,%v; want %q,%v", c.goos, c.path, got, ok, c.want, c.ok)
		}
	}
}

func TestCleanupGuardRejectedPrefixIsPinned(t *testing.T) {
	// The API string-matches this prefix to map a failed command onto the
	// `rejected` per-path status (spec §5.2). Changing it here without changing
	// packages/shared/src/utils/cleanupRules.ts turns every guard rejection into
	// an opaque `failed`.
	if CleanupGuardRejectedPrefix != "cleanup guard rejected:" {
		t.Fatalf("guard prefix drifted: %q", CleanupGuardRejectedPrefix)
	}
}

func TestCleanupBraceExpansion(t *testing.T) {
	got, err := compileCleanupPatterns([]string{"a/{b/c,d}/{e,f}"})
	if err != nil {
		t.Fatal(err)
	}
	want := [][]string{{"a", "b", "c", "e"}, {"a", "b", "c", "f"}, {"a", "d", "e"}, {"a", "d", "f"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("expanded patterns = %v, want %v", got, want)
	}
	for _, pattern := range []string{"a/{b,{c,d}}", "a/{b,c"} {
		if _, err := compileCleanupPatterns([]string{pattern}); err == nil {
			t.Errorf("compileCleanupPatterns(%q) accepted malformed braces", pattern)
		}
	}
}

// TestFullyLiteralPatternsAnchorAboveTheTarget pins the fix for #6375. A
// pattern with no wildcard at all (`/root/.local/share/Trash`) has a literal
// prefix as long as the pattern itself, so anchoring ON the literal prefix
// made the anchor the target — and openCleanupTarget rejects `rel == "."`,
// meaning preview offered the path forever and execute could never touch it.
// The anchor must stay a rule-author-fixed directory, but a STRICT ancestor.
func TestFullyLiteralPatternsAnchorAboveTheTarget(t *testing.T) {
	table, err := loadCleanupRules()
	if err != nil || table == nil {
		t.Fatalf("loadCleanupRules: %v", err)
	}
	checked := 0
	for goos, rules := range table.byOS {
		separator := "/"
		if goos == "windows" {
			separator = "\\"
		}
		for _, rule := range rules {
			for _, pattern := range rule.patterns {
				if literalPrefixLen(pattern) != len(pattern) {
					continue // has a wildcard; anchor is already a strict ancestor
				}
				concrete := pattern
				prefix := "/"
				if goos == "windows" {
					if concrete[0] != "<vol>" {
						t.Fatalf("%s: windows pattern %v does not start with <vol>", goos, pattern)
					}
					concrete = concrete[1:]
					prefix = "C:" + separator
				}
				path := prefix + strings.Join(concrete, separator)
				checked++
				anchor, ok := cleanupRuleAnchorFor(goos, path)
				if !ok {
					t.Errorf("cleanupRuleAnchorFor(%q, %q) = !ok; a literal rule path must still anchor", goos, path)
					continue
				}
				if anchor == path {
					t.Errorf("cleanupRuleAnchorFor(%q, %q) anchored on the target itself; the execute guard rejects rel == \".\"", goos, path)
				}
				if !strings.HasPrefix(path, strings.TrimSuffix(anchor, separator)+separator) {
					t.Errorf("cleanupRuleAnchorFor(%q, %q) = %q; anchor must be an ancestor of the target", goos, path, anchor)
				}
			}
		}
	}
	if checked == 0 {
		t.Skip("no fully-literal patterns in the rule table")
	}
}
