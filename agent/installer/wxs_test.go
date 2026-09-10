// Package installer holds the WiX sources for the Windows MSI plus this
// test, which exists so `go test ./...` guards structural invariants of
// breeze.wxs that would otherwise only surface on a real Windows box.
package installer

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func readWxs(t *testing.T) string {
	t.Helper()
	path := os.Getenv("BREEZE_WXS_PATH")
	if path == "" {
		path = "breeze.wxs"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(b)
}

// launchConditions returns the Condition attribute of every <Launch> element.
func launchConditions(wxs string) []string {
	re := regexp.MustCompile(`<Launch\s+Condition="([^"]*)"`)
	var out []string
	for _, m := range re.FindAllStringSubmatch(wxs, -1) {
		out = append(out, m[1])
	}
	return out
}

// Windows Installer reports VersionNT = 603 / WindowsBuild = 9600 (the
// Windows 8.1 values) on every Windows 10+ install by design: msiexec.exe is
// manifested only up to Windows 8.1 (Microsoft KB 3202260). A
// VersionNT/WindowsBuild floor therefore cannot express "Windows 10 or
// later" and refused every fresh install on Windows 10/11 (v0.110.0 to
// v0.111.1). The floor must come from the registry, which the version shim
// does not touch, and the property the RegistrySearch fills must be the one
// the Launch condition reads.
func TestOsFloorDoesNotUseShimmedVersionProperties(t *testing.T) {
	wxs := readWxs(t)
	conds := launchConditions(wxs)
	if len(conds) == 0 {
		t.Fatal("no <Launch> conditions found")
	}
	for _, c := range conds {
		for _, banned := range []string{"VersionNT ", "VersionNT>", "VersionNT<", "VersionNT=", "WindowsBuild"} {
			if strings.Contains(c, banned) {
				t.Errorf("launch condition %q derives the OS floor from a shimmable Windows Installer property", c)
			}
		}
	}
	// The RegistrySearch must sit directly under a <Property>, and that
	// property's Id must be what the Launch condition reads; otherwise the
	// condition evaluates an always-empty property and refuses every install.
	propRe := regexp.MustCompile(`(?s)<Property\s+Id="([A-Z_0-9]+)"[^>]*>\s*<RegistrySearch\s+[^>]*Key="SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"[^>]*Name="CurrentMajorVersionNumber"`)
	pm := propRe.FindStringSubmatch(wxs)
	if pm == nil {
		t.Fatal("expected a <Property> wrapping a RegistrySearch on HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\CurrentMajorVersionNumber to provide the Windows 10 / Server 2016 floor")
	}
	prop := pm[1]
	found := false
	for _, c := range conds {
		if c == "Installed OR "+prop {
			found = true
		}
	}
	if !found {
		t.Errorf("expected a <Launch> condition exactly %q (Installed OR keeps repair/uninstall unblocked)", "Installed OR "+prop)
	}
}

// AppSearch is sequenced after LaunchConditions by default (400 vs 100), so
// a registry-backed launch condition silently sees an empty property unless
// AppSearch is pulled forward in BOTH sequences.
func TestAppSearchRunsBeforeLaunchConditionsInBothSequences(t *testing.T) {
	wxs := readWxs(t)
	for _, seq := range []string{"InstallUISequence", "InstallExecuteSequence"} {
		re := regexp.MustCompile(`(?s)<` + seq + `>(.*?)</` + seq + `>`)
		m := re.FindStringSubmatch(wxs)
		if m == nil {
			t.Fatalf("no <%s> block", seq)
		}
		if !regexp.MustCompile(`<AppSearch\s+Before="LaunchConditions"\s*/>`).MatchString(m[1]) {
			t.Errorf("<%s> must schedule AppSearch before LaunchConditions", seq)
		}
	}
}
