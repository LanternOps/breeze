package patching

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestSystemScanArgsMachineScopeWingetSource(t *testing.T) {
	j := strings.Join(systemScanArgs(), " ")
	for _, want := range []string{"upgrade", "--scope", "machine", "--source", "winget", "--disable-interactivity"} {
		if !strings.Contains(j, want) {
			t.Fatalf("scan args missing %q: %s", want, j)
		}
	}
	if strings.Contains(j, "msstore") {
		t.Fatal("scan must not use msstore source")
	}
}

func TestSystemInstallRejectsBadID(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		t.Fatal("must not exec on invalid id")
		return "", "", 0, nil
	})
	if _, err := p.Install("Bad ID; rm -rf"); err == nil {
		t.Fatal("want validation error")
	}
}

func TestSystemScanParsesUpgrades(t *testing.T) {
	out := "Name    Id               Version  Available Source\n" +
		"-----------------------------------------------------\n" +
		"Firefox Mozilla.Firefox   1.0      2.0       winget\n"
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		return out, "", 0, nil
	})
	patches, err := p.Scan()
	if err != nil {
		t.Fatal(err)
	}
	if len(patches) != 1 || patches[0].ID != "Mozilla.Firefox" {
		t.Fatalf("got %+v", patches)
	}
}

// TestSystemScanUnreadableOutputIsSkippedNotEmpty is the regression guard for
// #2726: a scan whose output we cannot parse must surface ErrScanSkipped so
// PatchManager drops winget from scan coverage. Returning (nil, nil) here made a
// failed scan indistinguishable from "nothing pending" and tombstoned the
// device's third_party pending rows.
func TestSystemScanUnreadableOutputIsSkippedNotEmpty(t *testing.T) {
	tests := []struct {
		name        string
		stdout      string
		stderr      string
		exitCode    int
		wantSkipped bool
	}{
		{name: "empty stdout on exit 0", stdout: "", wantSkipped: true},
		{name: "garbled output", stdout: "\x1b[2J??? not a table\n", wantSkipped: true},
		{name: "localized header", stdout: "Nombre  Id  Versión  Disponible\n----------------\n", wantSkipped: true},
		{
			name:     "nonzero exit but readable table still scans",
			stdout:   "Name    Id               Version  Available Source\n" + strings.Repeat("-", 50) + "\nFirefox Mozilla.Firefox   1.0      2.0       winget\n",
			exitCode: 1,
		},
		{name: "explicit no-results message is a real empty scan", stdout: "No installed package found matching input criteria.\n"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
				return tc.stdout, tc.stderr, tc.exitCode, nil
			})

			patches, err := p.Scan()
			skipped := errors.Is(err, ErrScanSkipped)

			if skipped != tc.wantSkipped {
				t.Fatalf("errors.Is(err, ErrScanSkipped) = %v (err=%v), want %v", skipped, err, tc.wantSkipped)
			}
			if tc.wantSkipped {
				if patches != nil {
					t.Errorf("patches = %+v, want nil on a skipped scan", patches)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

// A skipped winget must not count toward scan coverage, or the server sweeps the
// third_party bucket anyway and the fix is inert (#2217 + #2726).
func TestSkippedSystemWingetIsNotCovered(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		return "not a winget table at all\n", "", 0, nil
	})

	_, covered, err := NewPatchManager(p).ScanWithCoverage()
	if err != nil {
		t.Fatalf("ScanWithCoverage should not surface a skip as failure: %v", err)
	}
	if len(covered) != 0 {
		t.Fatalf("covered = %v, want empty so third_party is not swept", covered)
	}
}

// The counterpart: a winget that really did enumerate an empty upgrade list must
// stay covered, otherwise installed patches are never tombstoned and linger as
// "pending" forever.
func TestConfirmedEmptySystemWingetScanStaysCovered(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		return "No installed package found matching input criteria.\n", "", 0, nil
	})

	patches, covered, err := NewPatchManager(p).ScanWithCoverage()
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(patches) != 0 {
		t.Fatalf("patches = %+v, want empty", patches)
	}
	if fmt.Sprint(covered) != "[winget]" {
		t.Fatalf("covered = %v, want [winget]", covered)
	}
}

func TestSystemInstallSuccess(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		if !strings.Contains(strings.Join(args, " "), "--scope machine") {
			t.Fatalf("install missing machine scope: %v", args)
		}
		return "Successfully installed", "", 0, nil
	})
	res, err := p.Install("Mozilla.Firefox")
	if err != nil {
		t.Fatal(err)
	}
	if res.PatchID != "Mozilla.Firefox" {
		t.Fatalf("got %+v", res)
	}
}
