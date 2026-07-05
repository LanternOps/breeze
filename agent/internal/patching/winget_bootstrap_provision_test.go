package patching

import (
	"strings"
	"testing"
	"time"
)

func TestBuildProvisionArgs(t *testing.T) {
	args := buildProvisionArgs(`C:\a\app.msixbundle`, `C:\a\app.xml`, []string{`C:\a\vclibs.appx`, `C:\a\uixaml.appx`})
	joined := strings.Join(args, " ")
	for _, want := range []string{
		"Add-AppxProvisionedPackage", "-Online",
		`-PackagePath`, `app.msixbundle`,
		`-LicensePath`, `app.xml`,
		`-DependencyPackagePath`, `vclibs.appx`, `uixaml.appx`,
	} {
		if !strings.Contains(joined, want) {
			t.Fatalf("provision args missing %q in: %s", want, joined)
		}
	}
}

func TestAppxStackAvailable(t *testing.T) {
	present := func(string, []string, time.Duration) (string, string, int, error) {
		return "Add-AppxProvisionedPackage", "", 0, nil
	}
	absent := func(string, []string, time.Duration) (string, string, int, error) {
		return "", "not recognized", 1, nil
	}
	if !appxStackAvailable(present) {
		t.Fatal("want available")
	}
	if appxStackAvailable(absent) {
		t.Fatal("want unavailable")
	}
}
