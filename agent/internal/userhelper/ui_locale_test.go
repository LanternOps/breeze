package userhelper

import (
	"strings"
	"testing"
)

func TestLocaleFromEnvPrecedence(t *testing.T) {
	cases := []struct {
		name string
		env  map[string]string
		want string
	}{
		{"LC_ALL wins", map[string]string{"LC_ALL": "de_DE.UTF-8", "LC_MESSAGES": "fr_FR.UTF-8", "LANG": "it_IT.UTF-8"}, "de_DE.UTF-8"},
		{"LC_MESSAGES before LANG", map[string]string{"LC_MESSAGES": "fr_CA.UTF-8", "LANG": "it_IT.UTF-8"}, "fr_CA.UTF-8"},
		{"LANG last", map[string]string{"LANG": "pt_BR.UTF-8"}, "pt_BR.UTF-8"},
		{"blank LC_ALL skipped", map[string]string{"LC_ALL": "  ", "LANG": "tr_TR"}, "tr_TR"},
		{"C means none", map[string]string{"LC_ALL": "C", "LANG": "de_DE.UTF-8"}, ""},
		{"C.UTF-8 means none", map[string]string{"LANG": "C.UTF-8"}, ""},
		{"POSIX means none", map[string]string{"LANG": "POSIX"}, ""},
		{"modifier kept", map[string]string{"LANG": "sr_RS@latin"}, "sr_RS@latin"},
		{"nothing set", map[string]string{}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := localeFromEnv(func(k string) string { return tc.env[k] })
			if got != tc.want {
				t.Fatalf("localeFromEnv = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseAppleLanguages(t *testing.T) {
	cases := []struct {
		name, out, want string
	}{
		{"quoted list", "(\n    \"de-DE\",\n    \"en-DE\"\n)\n", "de-DE"},
		{"unquoted first", "(\n    en,\n    \"fr-CA\"\n)\n", "en"},
		{"script subtag", "(\n    \"zh-Hans-CN\"\n)", "zh-Hans-CN"},
		{"single line", `("pt-BR", "en")`, "pt-BR"},
		{"empty array", "(\n)\n", ""},
		{"not an array", "The domain/default pair of (kCFPreferencesAnyApplication, AppleLanguages) does not exist\n", ""},
		{"empty output", "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseAppleLanguages(tc.out); got != tc.want {
				t.Fatalf("parseAppleLanguages = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCleanLocaleTag(t *testing.T) {
	cases := map[string]string{
		"de-DE":                 "de-DE",
		" fr_CA.UTF-8\n":        "fr_CA.UTF-8",
		"":                      "",
		"de DE":                 "",
		"ja-JP\u202e":           "",
		strings.Repeat("a", 36): "",
	}
	for in, want := range cases {
		if got := cleanLocaleTag(in); got != want {
			t.Errorf("cleanLocaleTag(%q) = %q, want %q", in, got, want)
		}
	}
}
