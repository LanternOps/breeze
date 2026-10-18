package userhelper

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// #8390 regression guard. The helper's background permission checks (the TCC
// check loop, the connect-time capability probe, the capture re-probe, the
// startup log) once took a real screen capture, and on macOS 15 every capture
// can put the screen-capture acknowledgement alert in front of the console
// user. Those checks must use desktop.CheckCaptureAccess, which never
// captures. This scans the source of the packages that run them for the
// capturing entry points, so a reintroduced capture fails here on any OS
// rather than in a lab.
//
// The one legitimate caller is the operator-run CLI probe
// (cmd/breeze-desktop-helper/probe.go, behind opts.capture). Capture sessions
// open their capturer inside internal/remote/desktop, which is not scanned.
var captureEntryPoint = regexp.MustCompile(`\b(ProbeCapture|NewScreenCapturer|CGWindowListCreateImage)\b`)

var captureGuardScans = []struct {
	dir       string
	allowlist map[string]bool
}{
	{dir: ".", allowlist: map[string]bool{}},
	{dir: filepath.Join("..", "..", "cmd", "breeze-desktop-helper"), allowlist: map[string]bool{"probe.go": true}},
}

func TestBackgroundPermissionChecksNeverReferenceCapture(t *testing.T) {
	for _, scan := range captureGuardScans {
		matches, err := filepath.Glob(filepath.Join(scan.dir, "*.go"))
		if err != nil {
			t.Fatal(err)
		}
		scanned := 0
		for _, path := range matches {
			name := filepath.Base(path)
			if strings.HasSuffix(name, "_test.go") {
				continue
			}
			scanned++
			if scan.allowlist[name] {
				continue
			}
			src, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			for i, line := range strings.Split(string(src), "\n") {
				if m := captureEntryPoint.FindString(line); m != "" {
					t.Errorf("%s:%d references %s: background permission checks must not capture (#8390); "+
						"use desktop.CheckCaptureAccess, or add the file to the allowlist here if it is an operator-run probe",
						path, i+1, m)
				}
			}
		}
		if scanned == 0 {
			t.Fatalf("no non-test .go files found in %s; the guard is scanning the wrong directory", scan.dir)
		}
	}
}
