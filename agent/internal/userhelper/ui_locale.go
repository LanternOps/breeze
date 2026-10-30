package userhelper

import (
	"strings"
	"sync"
)

// helperUILocale probes once per helper process: a reconnect loop must not
// spawn `defaults` every time, and a UI language change takes a new sign-in.
var helperUILocale = sync.OnceValue(ProbeUILocale)

// UI language probe (#10190 W03). The helper reports the signed-in user's UI
// language in ipc.AuthRequest.UILocale; the agent negotiates it to one of
// the catalog locales (promptcatalog.Negotiate) for every string it renders
// for this session. Per platform:
//   - Windows: GetUserDefaultUILanguage -> LCIDToLocaleName (ui_locale_windows.go);
//   - macOS: the first entry of `defaults read -g AppleLanguages` (ui_locale_darwin.go);
//   - Linux / BSD: LC_ALL, then LC_MESSAGES, then LANG (ui_locale_other.go).
//
// The parsing lives here, untagged, so CI tests it on every platform.

// ProbeUILocale returns this process's user's UI language tag, or "" when it
// cannot be determined (the agent then falls back to the OS language, then en).
func ProbeUILocale() string {
	return cleanLocaleTag(probeUILocaleOS())
}

// localeFromEnv applies the POSIX precedence for message catalogs: the first
// non-empty of LC_ALL, LC_MESSAGES, LANG. "C" / "POSIX" mean "no language".
func localeFromEnv(getenv func(string) string) string {
	for _, k := range []string{"LC_ALL", "LC_MESSAGES", "LANG"} {
		v := strings.TrimSpace(getenv(k))
		if v == "" {
			continue
		}
		return posixLocale(v)
	}
	return ""
}

func posixLocale(v string) string {
	base := v
	if i := strings.IndexAny(base, ".@"); i >= 0 {
		base = base[:i]
	}
	if base == "C" || base == "POSIX" || base == "" {
		return ""
	}
	return v
}

// parseAppleLanguages returns the first entry of `defaults read -g
// AppleLanguages`, which prints an old-style plist array:
//
//	(
//	    "de-DE",
//	    "en-DE"
//	)
//
// Entries may be unquoted (en) or quoted ("zh-Hans-CN").
func parseAppleLanguages(out string) string {
	s := strings.TrimSpace(out)
	if !strings.HasPrefix(s, "(") {
		return ""
	}
	s = strings.TrimPrefix(s, "(")
	if i := strings.IndexByte(s, ')'); i >= 0 {
		s = s[:i]
	}
	for _, item := range strings.Split(s, ",") {
		item = strings.TrimSpace(item)
		item = strings.Trim(item, `"`)
		item = strings.TrimSpace(item)
		if item != "" {
			return item
		}
	}
	return ""
}

// cleanLocaleTag keeps a tag only when it is short ASCII made of tag
// characters; the broker applies the same rule on receipt.
func cleanLocaleTag(v string) string {
	v = strings.TrimSpace(v)
	if v == "" || len(v) > 35 {
		return ""
	}
	for _, r := range v {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_', r == '.', r == '@':
		default:
			return ""
		}
	}
	return v
}
