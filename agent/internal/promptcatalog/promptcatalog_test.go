package promptcatalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

var (
	sharedCatalogDir = filepath.Join("..", "..", "..", "packages", "shared", "src", "promptCatalog", "catalog")
	sharedFixtureDir = filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "prompt-catalog")
)

func jsonFiles(t *testing.T, dir string) []string {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}
	var out []string
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".json") {
			out = append(out, e.Name())
		}
	}
	sort.Strings(out)
	return out
}

func TestEmbeddedCatalogMatchesSharedSource(t *testing.T) {
	shared := jsonFiles(t, sharedCatalogDir)
	embedded, err := catalogFS.ReadDir("catalog")
	if err != nil {
		t.Fatalf("read embedded catalog: %v", err)
	}
	var names []string
	for _, e := range embedded {
		names = append(names, e.Name())
	}
	sort.Strings(names)
	if strings.Join(names, ",") != strings.Join(shared, ",") {
		t.Fatalf("embedded catalog files %v != shared %v\nfix: cp packages/shared/src/promptCatalog/catalog/*.json agent/internal/promptcatalog/catalog/", names, shared)
	}
	if len(shared) == 0 {
		t.Fatal("no catalog files found; a vacuous parity test is worse than none")
	}
	for _, name := range shared {
		want, err := os.ReadFile(filepath.Join(sharedCatalogDir, name))
		if err != nil {
			t.Fatal(err)
		}
		got, err := catalogFS.ReadFile("catalog/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(want, got) {
			t.Errorf("embedded catalog/%s has drifted from packages/shared\nfix: cp packages/shared/src/promptCatalog/catalog/*.json agent/internal/promptcatalog/catalog/", name)
		}
	}
}

func TestCatalogLoadsAndHasEveryLocale(t *testing.T) {
	cat, err := load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	n := 0
	for ns, msgs := range cat {
		for key, byLocale := range msgs {
			n++
			for _, loc := range Locales {
				if strings.TrimSpace(byLocale[string(loc)]) == "" {
					t.Errorf("%s/%s missing %s", ns, key, loc)
				}
			}
			if len(byLocale) != len(Locales) {
				t.Errorf("%s/%s has %d locales, want %d", ns, key, len(byLocale), len(Locales))
			}
		}
	}
	if n < 10 {
		t.Fatalf("only %d messages loaded", n)
	}
}

// The notice namespace (W04) ships embedded: the agent renders every
// notice.info string from it (agent/internal/promptkinds).
func TestEmbeddedCatalogCarriesTheNoticeNamespace(t *testing.T) {
	cat, err := load()
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	for _, ns := range []string{"common", "notice"} {
		if len(cat[ns]) == 0 {
			t.Fatalf("namespace %q is not embedded", ns)
		}
	}
	got, err := Render(Locale("tr-TR"), "notice", "action.ok", nil)
	if err != nil || got != "Tamam" {
		t.Fatalf("notice/action.ok in tr-TR = %q, %v", got, err)
	}
	if _, err := Render(LocaleEN, "notice", "sessionEnded.body", nil); !errors.Is(err, ErrMissingParam) {
		t.Fatalf("sessionEnded.body without technician: err = %v, want ErrMissingParam", err)
	}
}

func TestValidateRejectsMissingLocale(t *testing.T) {
	raw := []byte(`{"namespace":"x","messages":{"k":{"en":"Hide","de-DE":"Ausblenden"}}}`)
	if _, _, err := parseFile(raw); err == nil {
		t.Fatal("a catalog file missing six locales must not load")
	}
}

func TestNegotiateFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(sharedFixtureDir, "locale-negotiation.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Input    string `json:"input"`
			Expected string `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 30 {
		t.Fatalf("fixture too small: %d", len(fx.Cases))
	}
	for _, c := range fx.Cases {
		if got := Negotiate(c.Input); string(got) != c.Expected {
			t.Errorf("Negotiate(%q) = %q, want %q", c.Input, got, c.Expected)
		}
	}
}

func TestSanitizeFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join(sharedFixtureDir, "identity-name-sanitize.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fx struct {
		Cases []struct {
			Name     string  `json:"name"`
			Input    string  `json:"input"`
			Expected *string `json:"expected"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}
	if len(fx.Cases) < 40 {
		t.Fatalf("fixture too small: %d", len(fx.Cases))
	}
	for _, c := range fx.Cases {
		want := ""
		if c.Expected != nil {
			want = *c.Expected
		}
		if got := SanitizeIdentityName(c.Input); got != want {
			t.Errorf("%s: SanitizeIdentityName(%q) = %q, want %q", c.Name, c.Input, got, want)
		}
	}
}

func TestSanitizeInvalidUTF8(t *testing.T) {
	if got := SanitizeIdentityName("North\xffwind"); got != "Northwind" {
		t.Fatalf("got %q", got)
	}
}

func TestRender(t *testing.T) {
	got, err := Render(Locale("de-DE"), "common", "chrome.hide", nil)
	if err != nil || got != "Ausblenden" {
		t.Fatalf("got %q, %v", got, err)
	}
	got, err = Render(LocaleEN, "common", "chrome.notificationsCount", map[string]string{"count": "3"})
	if err != nil || got != "Notifications (3)" {
		t.Fatalf("got %q, %v", got, err)
	}
	// A value is never re-read as a placeholder; renderer-owned ones pass through.
	got, err = Render(LocaleEN, "common", "native.windowTitle", map[string]string{"partner": "{partner} {remaining}"})
	if err != nil || got != "{partner} {remaining} · Message" {
		t.Fatalf("got %q, %v", got, err)
	}
	// A locale outside the eight renders en.
	got, err = Render(Locale("xx"), "common", "chrome.hide", nil)
	if err != nil || got != "Hide" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func TestRenderMissingParamErrors(t *testing.T) {
	_, err := Render(LocaleEN, "common", "native.windowTitle", map[string]string{})
	if !errors.Is(err, ErrMissingParam) {
		t.Fatalf("want ErrMissingParam, got %v", err)
	}
}

func TestRenderUnknownKeyErrors(t *testing.T) {
	if _, err := Render(LocaleEN, "common", "nope", nil); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("want ErrUnknownKey, got %v", err)
	}
	if _, err := Render(LocaleEN, "nope", "chrome.hide", nil); !errors.Is(err, ErrUnknownKey) {
		t.Fatalf("want ErrUnknownKey, got %v", err)
	}
}

func TestPlaceholdersMatchAcrossLocales(t *testing.T) {
	cat, err := load()
	if err != nil {
		t.Fatal(err)
	}
	for ns, msgs := range cat {
		for key, byLocale := range msgs {
			want := strings.Join(placeholders(byLocale[string(LocaleEN)]), ",")
			for _, loc := range Locales {
				if got := strings.Join(placeholders(byLocale[string(loc)]), ","); got != want {
					t.Errorf("%s/%s %s placeholders %q != en %q", ns, key, loc, got, want)
				}
			}
		}
	}
}

func TestSubstituteRendererOwnedPassThrough(t *testing.T) {
	got, err := substitute("Restart at {time:1767225600000} in {remaining} for {partner}", map[string]string{"partner": "Northwind"})
	if err != nil || got != "Restart at {time:1767225600000} in {remaining} for Northwind" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := substitute("{time:1} {count}", nil); !errors.Is(err, ErrMissingParam) {
		t.Fatalf("want ErrMissingParam, got %v", err)
	}
}

func TestRenderFrCAIsNotFrFR(t *testing.T) {
	ca, err := Render(Locale("fr-CA"), "common", "identity.generic", nil)
	if err != nil || ca != "Votre équipe de soutien informatique" {
		t.Fatalf("fr-CA got %q, %v", ca, err)
	}
	fr, _ := Render(Locale("fr-FR"), "common", "identity.generic", nil)
	if fr == ca {
		t.Fatal("fr-CA rendered the fr-FR text")
	}
}

func TestCatalogTextIsPlainAndTrimmed(t *testing.T) {
	cat, err := load()
	if err != nil {
		t.Fatal(err)
	}
	for ns, msgs := range cat {
		for key, byLocale := range msgs {
			for loc, text := range byLocale {
				if strings.ContainsAny(text, "<>") || strings.TrimSpace(text) != text {
					t.Errorf("%s/%s %s: %q has markup or untrimmed whitespace", ns, key, loc, text)
				}
			}
		}
	}
}
