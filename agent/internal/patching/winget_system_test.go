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
// The runner here answers every call the same way, so the 0x8A15002B cases
// also cover #10248's unscoped upgrade retry agreeing that nothing is newer.
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

// scriptedWingetCall is one canned winget invocation for scriptedWingetRunner.
type scriptedWingetCall struct {
	stdout string
	stderr string
	code   int
	err    error
}

// scriptedWingetRunner returns a cmdRunner that answers the i-th invocation
// with calls[i] and records every argv it saw. A call beyond the script fails
// the test so an unexpected extra winget run cannot pass silently.
func scriptedWingetRunner(t *testing.T, calls []scriptedWingetCall, seen *[][]string) cmdRunner {
	t.Helper()
	return func(_ string, args []string, _ time.Duration) (string, string, int, error) {
		i := len(*seen)
		*seen = append(*seen, append([]string(nil), args...))
		if i >= len(calls) {
			t.Fatalf("unexpected winget call #%d: %v", i+1, args)
		}
		c := calls[i]
		return c.stdout, c.stderr, c.code, c.err
	}
}

func argsContain(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

// #10248: `winget install --scope machine` on an already-installed package
// runs winget's upgrade flow with a MACHINE scope filter applied to the
// manifest's installers. Many inherently machine-wide manifests in winget-pkgs
// (.NET runtimes, VC++ redists, burn/MSI bundles) never declare
// `Scope: machine`, so every installer is filtered out and winget exits
// 0x8A15002B even though a newer version exists. That exit must trigger one
// unscoped `winget upgrade --include-unknown` retry, and only a second
// 0x8A15002B means the package is really current.
func TestSystemInstallNotApplicableRetriesUnscopedUpgrade(t *testing.T) {
	const notApplicableOut = "Found an existing package already installed. Trying to upgrade the installed package...\nNo available upgrade found.\nNo newer package versions are available from the configured sources."
	const pkg = "Microsoft.DotNet.Runtime.6"
	notApplicable := scriptedWingetCall{stdout: notApplicableOut, code: 2316632107}

	cases := []struct {
		name        string
		retry       scriptedWingetCall
		wantErr     string // substring; empty means no error
		wantSkipped bool
		wantMessage string
		wantReboot  bool
	}{
		{
			name:        "unscoped upgrade succeeds",
			retry:       scriptedWingetCall{stdout: "Successfully installed"},
			wantMessage: "Successfully installed",
		},
		{
			name:        "unscoped upgrade succeeds and asks for a restart",
			retry:       scriptedWingetCall{stdout: "Successfully installed. Restart your PC to finish installation."},
			wantMessage: "Restart your PC",
			wantReboot:  true,
		},
		{
			name:        "unscoped upgrade also not applicable (unsigned) is already current",
			retry:       scriptedWingetCall{stdout: "No available upgrade found.", code: 2316632107},
			wantSkipped: true,
			wantMessage: "No available upgrade found",
		},
		{
			name:        "unscoped upgrade also not applicable (signed) is already current",
			retry:       scriptedWingetCall{stdout: "No available upgrade found.", code: -1978335189},
			wantSkipped: true,
			wantMessage: "No available upgrade found",
		},
		{
			// 0x8A150014 APPINSTALLER_CLI_ERROR_NO_APPLICATIONS_FOUND.
			name:    "unscoped upgrade fails with another code",
			retry:   scriptedWingetCall{stdout: "No installed package found matching input criteria.", code: 2316632084},
			wantErr: "exit 2316632084",
		},
		{
			name:    "unscoped upgrade cannot be launched",
			retry:   scriptedWingetCall{err: errors.New("context deadline exceeded")},
			wantErr: "context deadline exceeded",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen [][]string
			p := NewSystemWingetProvider(`C:\wg\winget.exe`,
				scriptedWingetRunner(t, []scriptedWingetCall{notApplicable, tc.retry}, &seen))

			res, err := p.Install(pkg)

			if len(seen) != 2 {
				t.Fatalf("winget calls = %d (%v), want the scoped install plus one unscoped upgrade retry", len(seen), seen)
			}
			if !argsContain(seen[0], "install") || !argsContain(seen[0], "--scope") {
				t.Fatalf("first call should be the machine-scope install, got %v", seen[0])
			}
			retry := seen[1]
			if retry[0] != "upgrade" {
				t.Fatalf("retry must be `winget upgrade`, got %v", retry)
			}
			for _, want := range []string{"--exact", "--id", pkg, "--include-unknown", "--silent",
				"--accept-package-agreements", "--accept-source-agreements", "--source", "winget", "--disable-interactivity"} {
				if !argsContain(retry, want) {
					t.Fatalf("retry args missing %q: %v", want, retry)
				}
			}
			if argsContain(retry, "--scope") {
				t.Fatalf("retry must not pass --scope (the scope filter is what rejected every installer): %v", retry)
			}

			if tc.wantErr != "" {
				if err == nil {
					t.Fatalf("want error containing %q, got %+v", tc.wantErr, res)
				}
				if !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("error %q does not contain %q", err, tc.wantErr)
				}
				// The scoped attempt's own output is the evidence a tech
				// needs to see that a retry happened and why.
				if !strings.Contains(err.Error(), "Found an existing package already installed") {
					t.Fatalf("error must carry the machine-scope install's output, got %q", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !strings.Contains(res.Message, "Found an existing package already installed") {
				t.Fatalf("message must carry the machine-scope install's output, got %q", res.Message)
			}
			if res.PatchID != pkg || res.Provider != "winget" {
				t.Fatalf("got %+v", res)
			}
			if res.Skipped != tc.wantSkipped {
				t.Fatalf("Skipped = %v, want %v (%+v)", res.Skipped, tc.wantSkipped, res)
			}
			if tc.wantSkipped && res.SkipReason != SkipReasonAlreadyCurrent {
				t.Fatalf("SkipReason = %q, want %q", res.SkipReason, SkipReasonAlreadyCurrent)
			}
			if !tc.wantSkipped && res.SkipReason != "" {
				t.Fatalf("SkipReason = %q on a real upgrade", res.SkipReason)
			}
			if !strings.Contains(res.Message, tc.wantMessage) {
				t.Fatalf("message %q does not contain %q", res.Message, tc.wantMessage)
			}
			if res.RebootRequired != tc.wantReboot {
				t.Fatalf("RebootRequired = %v, want %v", res.RebootRequired, tc.wantReboot)
			}
		})
	}
}

// The retry is reserved for 0x8A15002B. A successful scoped install and any
// other failure must not spend a second winget run.
func TestSystemInstallNoRetryOutsideNotApplicable(t *testing.T) {
	cases := []struct {
		name    string
		first   scriptedWingetCall
		wantErr bool
	}{
		{name: "scoped install succeeds", first: scriptedWingetCall{stdout: "Successfully installed"}},
		{name: "scoped install fails with another code", first: scriptedWingetCall{stdout: "Installer failed", code: 1}, wantErr: true},
		{name: "scoped install cannot be launched", first: scriptedWingetCall{err: errors.New("boom")}, wantErr: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var seen [][]string
			p := NewSystemWingetProvider(`C:\wg\winget.exe`,
				scriptedWingetRunner(t, []scriptedWingetCall{tc.first}, &seen))
			_, err := p.Install("Mozilla.Firefox")
			if (err != nil) != tc.wantErr {
				t.Fatalf("err = %v, wantErr %v", err, tc.wantErr)
			}
			if len(seen) != 1 {
				t.Fatalf("winget calls = %d (%v), want exactly 1", len(seen), seen)
			}
		})
	}
}
