package patching

import (
	"strings"
	"testing"
)

func TestParseAppInstallerVersion(t *testing.T) {
	cases := []struct {
		dir, want string
		ok        bool
	}{
		{`Microsoft.DesktopAppInstaller_1.22.10661.0_x64__8wekyb3d8bbwe`, "1.22.10661.0", true},
		{`Microsoft.DesktopAppInstaller_1.16.12653.0_x64__8wekyb3d8bbwe`, "1.16.12653.0", true},
		{`Microsoft.SomethingElse_1.0.0.0_x64__abc`, "", false},
		{`garbage`, "", false},
	}
	for _, c := range cases {
		got, ok := parseAppInstallerVersion(c.dir)
		if ok != c.ok || got != c.want {
			t.Fatalf("parseAppInstallerVersion(%q)=%q,%v want %q,%v", c.dir, got, ok, c.want, c.ok)
		}
	}
}

func TestCompareVersions(t *testing.T) {
	if compareVersions("1.22.10661.0", "1.16.12653.0") != 1 {
		t.Fatal("1.22 should be > 1.16")
	}
	if compareVersions("1.16.0.0", "1.16.0.0") != 0 {
		t.Fatal("equal versions")
	}
	if compareVersions("1.5.0.0", "1.16.0.0") != -1 {
		t.Fatal("1.5 < 1.16 numerically")
	}
}

func TestLocateHighestVersion(t *testing.T) {
	l := &wingetLocator{
		root: `C:\Program Files\WindowsApps`,
		glob: func(pattern string) ([]string, error) {
			return []string{
				`C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_1.16.12653.0_x64__8wekyb3d8bbwe\winget.exe`,
				`C:\Program Files\WindowsApps\Microsoft.DesktopAppInstaller_1.22.10661.0_x64__8wekyb3d8bbwe\winget.exe`,
			}, nil
		},
	}
	path, ver, err := l.Locate()
	if err != nil {
		t.Fatal(err)
	}
	if ver != "1.22.10661.0" || !strings.Contains(path, "1.22.10661.0") {
		t.Fatalf("got %q %q", path, ver)
	}
}

func TestLocateNotFound(t *testing.T) {
	l := &wingetLocator{root: `x`, glob: func(string) ([]string, error) { return nil, nil }}
	if _, _, err := l.Locate(); err != errWingetNotFound {
		t.Fatalf("want errWingetNotFound, got %v", err)
	}
}
