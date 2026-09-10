// Package installer holds the WiX sources for the Windows MSI. There is no
// Go code here; this file exists so `go test ./...` guards structural
// invariants of breeze.wxs that only surface on a real Windows box.
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

// Windows reports a fake 6.3/9600 version (VersionNT = 603) to any msiexec
// client process lacking a Windows 10 supportedOS manifest — NinjaRMM and
// Action1 script hosts among them — so a VersionNT/WindowsBuild floor
// refuses to install on real Windows 11 boxes when pushed by another RMM.
// The floor must come from the registry, which the version shim does not
// touch.
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
	if !strings.Contains(wxs, `Name="CurrentMajorVersionNumber"`) {
		t.Error("expected a RegistrySearch on CurrentMajorVersionNumber to provide the Windows 10 / Server 2016 floor")
	}
	found := false
	for _, c := range conds {
		if strings.Contains(c, "WINDOWS_CURRENT_MAJOR_VERSION") {
			found = true
		}
	}
	if !found {
		t.Error("expected a <Launch> condition on WINDOWS_CURRENT_MAJOR_VERSION")
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
		if !strings.Contains(m[1], `<AppSearch Before="LaunchConditions" />`) {
			t.Errorf("<%s> must schedule AppSearch before LaunchConditions", seq)
		}
	}
}
