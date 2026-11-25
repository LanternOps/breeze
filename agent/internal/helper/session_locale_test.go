package helper

import (
	"os"
	"testing"

	"gopkg.in/yaml.v3"
)

func readConfigLocale(t *testing.T, path string) (string, bool) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var cfg struct {
		Locale *string `yaml:"locale"`
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if cfg.Locale == nil {
		return "", false
	}
	return *cfg.Locale, true
}

func TestResolveSessionLocale(t *testing.T) {
	si := SessionInfo{Key: "1", Username: "u1"}
	cases := []struct {
		name string
		tag  string
		want string
	}{
		{"unknown tag omitted", "", ""},
		{"pt-BR kept", "pt-BR", "pt-BR"},
		{"posix form negotiated", "de_DE.UTF-8", "de-DE"},
		{"unsupported language is English", "xx-YY", "en"},
		{"hostile tag is English", "<script>", "en"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			probe := func(SessionInfo) string { return tc.tag }
			if got := resolveSessionLocale(si, probe); got != tc.want {
				t.Fatalf("resolveSessionLocale(%q) = %q, want %q", tc.tag, got, tc.want)
			}
		})
	}
}

func TestResolveSessionLocaleNilProbeAndPanicOmit(t *testing.T) {
	si := SessionInfo{Key: "1"}
	if got := resolveSessionLocale(si, nil); got != "" {
		t.Fatalf("nil probe = %q, want empty", got)
	}
	boom := func(SessionInfo) string { panic("resolver failure") }
	if got := resolveSessionLocale(si, boom); got != "" {
		t.Fatalf("panicking probe = %q, want empty (does not block startup)", got)
	}
}

func TestApplyWritesLocalePerSession(t *testing.T) {
	mgr, dir := brandingHarness(t, "1", "2")
	mgr.sessionLocale = func(si SessionInfo) string {
		if si.Key == "1" {
			return "pt-BR"
		}
		return "de-DE"
	}
	apply(mgr, nil)

	got1, ok1 := readConfigLocale(t, sessionPath(dir, "1"))
	got2, ok2 := readConfigLocale(t, sessionPath(dir, "2"))
	if !ok1 || got1 != "pt-BR" {
		t.Fatalf("session 1 locale = %q (present=%v), want pt-BR", got1, ok1)
	}
	if !ok2 || got2 != "de-DE" {
		t.Fatalf("session 2 locale = %q (present=%v), want de-DE", got2, ok2)
	}
}

func TestApplyOmitsLocaleWhenUnknown(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	mgr.sessionLocale = func(SessionInfo) string { return "" }
	apply(mgr, nil)
	if _, ok := readConfigLocale(t, sessionPath(dir, "1")); ok {
		t.Fatal("unknown locale must omit the key so the Helper keeps its own OS language")
	}
}

func TestApplyRewritesWhenLocaleChanges(t *testing.T) {
	mgr, dir := brandingHarness(t, "1")
	tag := "pt-BR"
	mgr.sessionLocale = func(SessionInfo) string { return tag }
	apply(mgr, nil)
	tag = "de-DE"
	apply(mgr, nil)
	if got, _ := readConfigLocale(t, sessionPath(dir, "1")); got != "de-DE" {
		t.Fatalf("locale after change = %q, want de-DE (config must be rewritten)", got)
	}
}
