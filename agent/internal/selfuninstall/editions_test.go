package selfuninstall

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
)

// The self-uninstall finds the agent's MSI product by UpgradeCode. A code
// changed in the installer but not here would silently fall back to the manual
// removal and leave the Programs and Features entry behind.
func TestAgentUpgradeCodesMatchTheInstaller(t *testing.T) {
	read := func(name string) string {
		data, err := os.ReadFile(filepath.Join("..", "..", "installer", name))
		if err != nil {
			t.Fatalf("read installer/%s: %v", name, err)
		}
		return string(data)
	}
	ps := read("build-msi.ps1")
	var fromBuild []string
	for _, v := range []string{"hostedUpgradeCode", "selfHostUpgradeCode"} {
		m := regexp.MustCompile(`\$` + v + `\s*=\s*"(\{[0-9A-Fa-f-]{36}\})"`).FindStringSubmatch(ps)
		if m == nil {
			t.Fatalf("build-msi.ps1 no longer defines $%s", v)
		}
		fromBuild = append(fromBuild, m[1])
	}

	wxs := read("breeze.wxs")
	var fromWxs []string
	for _, v := range []string{"UpgradeCode", "OtherUpgradeCode"} {
		m := regexp.MustCompile(`<\?define ` + v + `=(\{[0-9A-Fa-f-]{36}\})\?>`).FindStringSubmatch(wxs)
		if m == nil {
			t.Fatalf("breeze.wxs no longer defines %s", v)
		}
		fromWxs = append(fromWxs, m[1])
	}

	want := append([]string(nil), AgentUpgradeCodes...)
	sort.Strings(want)
	for name, got := range map[string][]string{"build-msi.ps1": fromBuild, "breeze.wxs": fromWxs} {
		sort.Strings(got)
		if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("%s UpgradeCodes %v != AgentUpgradeCodes %v", name, got, want)
		}
	}
}
