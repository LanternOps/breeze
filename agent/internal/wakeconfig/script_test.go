package wakeconfig

import (
	"regexp"
	"strings"
	"testing"
)

func TestReadScriptIsReadOnlyAndKeywordMatched(t *testing.T) {
	s := strings.ToLower(readScript)
	if !strings.Contains(readScript, "-RegistryKeyword '*EEE'") {
		t.Fatal("script must match EEE by -RegistryKeyword '*EEE'")
	}
	for _, bad := range []string{"displayname", "displayvalue"} {
		if strings.Contains(s, bad) {
			t.Fatalf("script must not look up localised %s", bad)
		}
	}
	for _, bad := range []string{"set-", "enable-", "disable-", "new-", "remove-", "restart-", "rename-",
		"reg add", "reg delete", "invoke-wmimethod", "invoke-cimmethod"} {
		if strings.Contains(s, bad) {
			t.Fatalf("script must be read-only but contains %q", bad)
		}
	}
	// Registry access: the only cmdlet touching a registry path is Get-ItemProperty.
	for _, m := range regexp.MustCompile(`(?i)[a-z]+-itemproperty\w*|hklm:|hkcu:|\bregistry::`).FindAllString(readScript, -1) {
		lm := strings.ToLower(m)
		if lm != "get-itemproperty" && lm != "hklm:" {
			t.Fatalf("unexpected registry access %q", m)
		}
	}
	if !strings.Contains(s, "get-itemproperty") {
		t.Fatal("expected Get-ItemProperty for HiberbootEnabled")
	}
}
