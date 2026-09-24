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

func TestSystemIsInstalledMatch(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		j := strings.Join(args, " ")
		for _, want := range []string{"list", "--exact", "--id", "Google.Chrome", "--scope", "machine", "--source", "winget"} {
			if !strings.Contains(j, want) {
				t.Fatalf("IsInstalled args missing %q: %s", want, j)
			}
		}
		return "Name    Id             Version\nChrome  Google.Chrome  1.0\n", "", 0, nil
	})
	installed, err := p.IsInstalled("Google.Chrome")
	if err != nil {
		t.Fatal(err)
	}
	if !installed {
		t.Fatal("want installed=true when winget list exits 0 with the id present")
	}
}

func TestSystemIsInstalledNoMatchExitNonZero(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(name string, args []string, _ time.Duration) (string, string, int, error) {
		return "No installed package found matching input criteria.\n", "", 1, nil
	})
	installed, err := p.IsInstalled("Google.Chrome")
	if err != nil {
		t.Fatalf("winget exiting non-zero for no-match must not be an error: %v", err)
	}
	if installed {
		t.Fatal("want installed=false on winget no-match exit code")
	}
}

func TestSystemIsInstalledRejectsBadID(t *testing.T) {
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		t.Fatal("must not exec on invalid id")
		return "", "", 0, nil
	})
	if _, err := p.IsInstalled("Bad ID; rm -rf"); err == nil {
		t.Fatal("want validation error")
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

// #6910: winget exits 0x8A15002B (APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE,
// 2316632107 unsigned) when the package is already at the newest available
// version. That is "nothing to do", not an install failure — it must come back
// as a skipped InstallResult (visible, with winget's message), never an error.
func TestSystemInstallExitCodeClassification(t *testing.T) {
	const notApplicableOut = "Found an existing package already installed. Trying to upgrade the installed package...\nNo available upgrade found.\nNo newer package versions are available from the configured sources."
	cases := []struct {
		name        string
		code        int
		stdout      string
		wantErr     bool
		wantSkipped bool
	}{
		{name: "exit 0 installs", code: 0, stdout: "Successfully installed"},
		{name: "0x8A15002B unsigned is already current", code: 2316632107, stdout: notApplicableOut, wantSkipped: true},
		{name: "0x8A15002B as signed int32 is already current", code: -1978335189, stdout: notApplicableOut, wantSkipped: true},
		// 0x8A150014 APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND — a real failure.
		{name: "other non-zero fails", code: 2316632084, stdout: "No package found matching input criteria.", wantErr: true},
		// Exit code wins over text: the "No available upgrade" wording on a
		// different non-zero code is still a failure.
		{name: "not-applicable text on other code fails", code: 1, stdout: notApplicableOut, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
				return tc.stdout, "", tc.code, nil
			})
			res, err := p.Install("Mozilla.Firefox")
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got %+v", res)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if res.Skipped != tc.wantSkipped {
				t.Fatalf("Skipped = %v, want %v (%+v)", res.Skipped, tc.wantSkipped, res)
			}
			if tc.wantSkipped {
				if res.SkipReason != SkipReasonAlreadyCurrent {
					t.Fatalf("SkipReason = %q, want %q", res.SkipReason, SkipReasonAlreadyCurrent)
				}
				if !strings.Contains(res.Message, "No available upgrade found") {
					t.Fatalf("message must carry winget's output, got %q", res.Message)
				}
				if res.RebootRequired {
					t.Fatal("a skipped install cannot require a reboot")
				}
				if res.PatchID != "Mozilla.Firefox" || res.Provider != "winget" {
					t.Fatalf("got %+v", res)
				}
			}
		})
	}
}
