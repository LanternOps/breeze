package helper

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func brandingHarness(t *testing.T, keys ...string) (*Manager, string) {
	t.Helper()
	tmpDir := t.TempDir()
	origRemove, origStopLegacy := removeAutoStartFunc, stopHelperLegacyFunc
	t.Cleanup(func() { removeAutoStartFunc, stopHelperLegacyFunc = origRemove, origStopLegacy })
	removeAutoStartFunc = func() error { return nil }
	stopHelperLegacyFunc = func() {}

	mgr := New(context.Background(), nil, nil, "", WithMachineInstallOwner(true))
	t.Cleanup(mgr.Shutdown)
	mgr.baseDir = tmpDir
	enum := &mockEnumerator{}
	for _, k := range keys {
		enum.sessions = append(enum.sessions, SessionInfo{Key: k, Username: "u" + k})
	}
	mgr.sessionEnumerator = enum
	mgr.isOurProcessFunc = func(pid int, binaryPath string) bool { return false }
	mgr.stopIfOursFunc = func(pid int, binaryPath string) (bool, error) { return true, nil }
	mgr.spawnFunc = func(sessionKey, binaryPath string, args ...string) (int, error) { return 9001, nil }
	bin := filepath.Join(tmpDir, "breeze-helper")
	if err := os.WriteFile(bin, []byte("bin"), 0755); err != nil {
		t.Fatal(err)
	}
	mgr.binaryPath = bin
	return mgr, tmpDir
}

func sessionPath(dir, key string) string {
	return filepath.Join(dir, "sessions", key, "helper_config.yaml")
}

func setDecision(scope, name string) *BrandingDecision {
	return &BrandingDecision{State: "set", ScopeID: scope, Values: BrandingValues{DisplayName: name, PrimaryColor: "#112233"}}
}

func apply(mgr *Manager, d *BrandingDecision) {
	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true, Branding: d})
}

func wantBranding(t *testing.T, path, scope, name string) {
	t.Helper()
	b, _ := readBranding(path)
	if b == nil {
		t.Fatalf("%s: no branding, want scope=%s name=%s", path, scope, name)
	}
	if b.ScopeID != scope || b.DisplayName != name {
		t.Fatalf("%s: branding = %+v, want scope=%s name=%s", path, b, scope, name)
	}
}

func TestBrandingSetPersistsAndReloads(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	apply(mgr, setDecision("s1", "Acme IT"))
	wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")

	// Restart: a fresh Manager with no in-memory state and no decision keeps it.
	mgr2, _ := brandingHarness(t, "1")
	mgr2.baseDir = dir
	apply(mgr2, nil)
	wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")
}

func TestBrandingSetReplaces(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	apply(mgr, setDecision("s1", "Acme IT"))
	apply(mgr, setDecision("s1", "Acme Support"))
	wantBranding(t, sessionPath(dir, "1"), "s1", "Acme Support")
}

func TestBrandingClearedRemovesAndKeepsSettings(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	apply(mgr, setDecision("s1", "Acme IT"))
	apply(mgr, &BrandingDecision{State: "cleared"})
	if b, _ := readBranding(sessionPath(dir, "1")); b != nil {
		t.Fatalf("branding survived cleared: %+v", b)
	}
	data, _ := os.ReadFile(sessionPath(dir, "1"))
	if strings.Contains(string(data), "branding") {
		t.Fatalf("config still mentions branding:\n%s", data)
	}
	if !strings.Contains(string(data), "show_open_portal: true") {
		t.Fatalf("operational settings lost:\n%s", data)
	}
}

func TestBrandingAbsentKeepsLastKnown(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	apply(mgr, setDecision("s1", "Acme IT"))
	apply(mgr, nil)
	apply(mgr, nil)
	wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")
}

func TestBrandingScopeChangeReplacesOldTenant(t *testing.T) {
	// Org or partner change both surface as a new opaque scope id.
	for _, name := range []string{"org change", "partner change"} {
		t.Run(name, func(t *testing.T) {
			mgr, dir := brandingHarness(t, "1")
			apply(mgr, setDecision("scope-A", "Acme IT"))
			apply(mgr, setDecision("scope-B", "Other MSP"))
			wantBranding(t, sessionPath(dir, "1"), "scope-B", "Other MSP")
		})
	}
}

func TestBrandingScopeChangeWithInvalidDecisionDropsOldTenant(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	apply(mgr, setDecision("scope-A", "Acme IT"))
	apply(mgr, &BrandingDecision{State: "set", ScopeID: "scope-B", Values: BrandingValues{PrimaryColor: "red"}})
	if b, _ := readBranding(sessionPath(dir, "1")); b != nil {
		t.Fatalf("old tenant branding survived a scope change: %+v", b)
	}
}

func TestBrandingSiteOnlyChangePreserves(t *testing.T) {
	// A site move keeps the same scope id; the server resends the same set.
	mgr, dir := brandingHarness(t, "1")
	apply(mgr, setDecision("scope-A", "Acme IT"))
	apply(mgr, setDecision("scope-A", "Acme IT"))
	wantBranding(t, sessionPath(dir, "1"), "scope-A", "Acme IT")
	// And a payload without branding (site change on an old server) too.
	apply(mgr, nil)
	wantBranding(t, sessionPath(dir, "1"), "scope-A", "Acme IT")
}

func TestBrandingSessionsAreIsolated(t *testing.T) {
	mgr, dir := brandingHarness(t, "1", "2")
	apply(mgr, setDecision("s1", "Acme IT"))
	// Session 2 starts with its own different persisted branding.
	if err := os.WriteFile(sessionPath(dir, "2"), []byte("branding:\n  scope_id: old\n  display_name: Old\n"), 0600); err != nil {
		t.Fatal(err)
	}
	apply(mgr, nil)
	wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")
	wantBranding(t, sessionPath(dir, "2"), "old", "Old")
	apply(mgr, &BrandingDecision{State: "cleared"})
	b1, _ := readBranding(sessionPath(dir, "1"))
	b2, _ := readBranding(sessionPath(dir, "2"))
	if b1 != nil || b2 != nil {
		t.Fatal("cleared must reach every session")
	}
}

func TestBrandingInvalidKeepsLastValid(t *testing.T) {
	long := strings.Repeat("a", 61)
	cases := map[string]BrandingValues{
		"displayName too long":   {DisplayName: long},
		"bad color name":         {DisplayName: "X", PrimaryColor: "red"},
		"bad color short":        {DisplayName: "X", AccentColor: "#fff"},
		"bad color rgb":          {DisplayName: "X", AccentColor: "rgb(1,2,3)"},
		"control char":           {DisplayName: "a\x07b"},
		"bidi override":          {DisplayName: "a\u202eb"},
		"message too long":       {WelcomeMessage: strings.Repeat("x", 501)},
		"title too long":         {WelcomeTitle: strings.Repeat("x", 121)},
		"support label too long": {SupportLabel: strings.Repeat("x", 41)},
		"portal label too long":  {PortalLabel: strings.Repeat("x", 41)},
		"no fields":              {},
	}
	for name, v := range cases {
		t.Run(name, func(t *testing.T) {
			mgr, dir := brandingHarness(t, "1")
			apply(mgr, setDecision("s1", "Acme IT"))
			apply(mgr, &BrandingDecision{State: "set", ScopeID: "s1", Values: v})
			wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")
		})
	}
	t.Run("missing scope", func(t *testing.T) {
		mgr, dir := brandingHarness(t, "1")
		apply(mgr, setDecision("s1", "Acme IT"))
		apply(mgr, &BrandingDecision{State: "set", Values: BrandingValues{DisplayName: "X"}})
		wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")
	})
	t.Run("unknown state", func(t *testing.T) {
		mgr, dir := brandingHarness(t, "1")
		apply(mgr, setDecision("s1", "Acme IT"))
		apply(mgr, &BrandingDecision{State: "bogus"})
		wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")
	})
}

func TestBrandingLimitsAreCodePoints(t *testing.T) {
	ok := strings.Repeat("\U0001F600", 60) // 60 code points, 240 bytes
	if _, err := resolveBranding(nil, setDecision("s", ok)); err != nil {
		t.Fatalf("60 code points rejected: %v", err)
	}
	if _, err := resolveBranding(nil, setDecision("s", ok+"x")); err == nil {
		t.Fatal("61 code points accepted")
	}
	if _, err := resolveBranding(nil, setDecision("s", "a\u200db")); err != nil {
		t.Fatalf("ZWJ rejected: %v", err)
	}
	if _, err := resolveBranding(nil, &BrandingDecision{State: "set", ScopeID: "s", Values: BrandingValues{PrimaryColor: "#aAbB09"}}); err != nil {
		t.Fatalf("valid color rejected: %v", err)
	}
}

func TestBrandingCorruptSectionIsRejected(t *testing.T) {
	p := filepath.Join(t.TempDir(), "helper_config.yaml")
	for _, body := range []string{
		"branding: nope\n",
		"branding:\n  scope_id: s\n  primary_color: red\n",
		"branding:\n  display_name: NoScope\n",
		"{{{",
	} {
		if err := os.WriteFile(p, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
		if b, err := readBranding(p); b != nil || err == nil {
			t.Fatalf("body %q read as (%+v, %v), want (nil, error)", body, b, err)
		}
	}
}

func TestClearBrandingKeepsOtherKeysAndAllSessions(t *testing.T) {
	dir := t.TempDir()
	body := "show_open_portal: true\nfuture_key: keep\nbranding:\n  scope_id: s\n  display_name: X\n"
	for _, p := range []string{filepath.Join(dir, "helper_config.yaml"), sessionPath(dir, "1"), sessionPath(dir, "2")} {
		if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := ClearBranding(dir); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{filepath.Join(dir, "helper_config.yaml"), sessionPath(dir, "1"), sessionPath(dir, "2")} {
		data, _ := os.ReadFile(p)
		if strings.Contains(string(data), "branding") || !strings.Contains(string(data), "future_key: keep") {
			t.Fatalf("%s after clear:\n%s", p, data)
		}
	}
	if err := ClearBranding(filepath.Join(dir, "missing")); err != nil {
		t.Fatalf("missing dir: %v", err)
	}
}

// Compatibility: no branding => same YAML as before; an older Helper that
// decodes without the field still reads the config; old payload decodes.
func TestBrandingCompatibility(t *testing.T) {
	out, err := yaml.Marshal(&Config{ShowOpenPortal: true})
	if err != nil || strings.Contains(string(out), "branding") {
		t.Fatalf("unbranded config mentions branding (err=%v):\n%s", err, out)
	}

	out, err = yaml.Marshal(&Config{ShowOpenPortal: true, Branding: &Branding{ScopeID: "s", BrandingValues: BrandingValues{DisplayName: "X"}}})
	if err != nil {
		t.Fatal(err)
	}
	var old struct {
		ShowOpenPortal bool `yaml:"show_open_portal"`
	}
	if err := yaml.Unmarshal(out, &old); err != nil || !old.ShowOpenPortal {
		t.Fatalf("old Helper decode failed: %v\n%s", err, out)
	}

	var s Settings
	if err := json.Unmarshal([]byte(`{"enabled":true,"showOpenPortal":true}`), &s); err != nil || s.Branding != nil {
		t.Fatalf("old payload: %+v err=%v", s, err)
	}
	if err := json.Unmarshal([]byte(`{"enabled":true,"branding":{"state":"set","scopeId":"s","values":{"displayName":"X","futureField":1}}}`), &s); err != nil || s.Branding == nil || s.Branding.Values.DisplayName != "X" {
		t.Fatalf("set payload: %+v err=%v", s.Branding, err)
	}
	if err := json.Unmarshal([]byte(`{"branding":{"state":"cleared"}}`), &s); err != nil || s.Branding.State != "cleared" {
		t.Fatalf("cleared payload: %+v err=%v", s.Branding, err)
	}
	// A malformed block must not fail the whole decode and must be rejected.
	var m Settings
	if err := json.Unmarshal([]byte(`{"enabled":true,"branding":"garbage"}`), &m); err != nil || !m.Enabled {
		t.Fatalf("malformed block failed decode: %v", err)
	}
	if next, err := resolveBranding(&Branding{ScopeID: "s"}, m.Branding); err == nil || next == nil {
		t.Fatalf("malformed block not rejected/kept: next=%v err=%v", next, err)
	}
}

func TestBrandingUnreadableStoreKeepsLastKnown(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	apply(mgr, setDecision("s1", "Acme IT"))
	wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")

	// A failed read must not turn an absent decision into a clear.
	if err := os.WriteFile(sessionPath(dir, "1"), []byte("{{{"), 0600); err != nil {
		t.Fatal(err)
	}
	apply(mgr, nil)
	if data, _ := os.ReadFile(sessionPath(dir, "1")); string(data) != "{{{" {
		t.Fatalf("unchanged config rewrote the unreadable file: %q", data)
	}

	// An unrelated setting change forces a rewrite; branding must survive it.
	mgr.Apply(&Settings{Enabled: true, ShowOpenPortal: true, ShowDeviceInfo: true})
	wantBranding(t, sessionPath(dir, "1"), "s1", "Acme IT")
}

func TestReadBrandingDistinguishesMissingFromUnreadable(t *testing.T) {
	dir := t.TempDir()
	if b, err := readBranding(filepath.Join(dir, "absent.yaml")); b != nil || err != nil {
		t.Fatalf("missing file = (%+v, %v), want (nil, nil)", b, err)
	}
	p := filepath.Join(dir, "helper_config.yaml")
	if err := os.WriteFile(p, []byte("show_open_portal: true\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if b, err := readBranding(p); b != nil || err != nil {
		t.Fatalf("no section = (%+v, %v), want (nil, nil)", b, err)
	}
	if err := os.WriteFile(p, []byte("{{{"), 0600); err != nil {
		t.Fatal(err)
	}
	if b, err := readBranding(p); b != nil || err == nil {
		t.Fatalf("bad yaml = (%+v, %v), want (nil, error)", b, err)
	}
}

func TestClearBrandingLeavesNoTempFiles(t *testing.T) {
	dir := t.TempDir()
	p := sessionPath(dir, "1")
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte("show_open_portal: true\nbranding:\n  scope_id: s\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := ClearBranding(dir); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(p))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
	info, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("mode = %v, want 0600", info.Mode().Perm())
	}
}
