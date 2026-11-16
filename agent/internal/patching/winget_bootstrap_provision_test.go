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

func TestBuildProvisionArgsQuotesPaths(t *testing.T) {
	args := buildProvisionArgs("C:\\Users\\O\u2019Brien\\app.msixbundle", `C:\it's\app.xml`, []string{"C:\\\u2018a\u2019\\vclibs.appx"})
	want := "Add-AppxProvisionedPackage -Online -PackagePath 'C:\\Users\\O\u2019\u2019Brien\\app.msixbundle' " +
		"-LicensePath 'C:\\it''s\\app.xml' -DependencyPackagePath 'C:\\\u2018\u2018a\u2019\u2019\\vclibs.appx'"
	if got := args[len(args)-1]; got != want {
		t.Fatalf("command = %q, want %q", got, want)
	}
}
