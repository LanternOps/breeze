package patching

import (
	"errors"
	"strings"
	"testing"
	"time"
)

const wingetUpgradeTable = "Name    Id               Version  Available Source\n" +
	"-----------------------------------------------------\n" +
	"Firefox Mozilla.Firefox   1.0      2.0       winget\n"

// #12835: a failed SYSTEM machine-scope pass must leave the agent with a short,
// sanitized reason the patch_scan result can carry to the device Patches tab.
func TestSystemScanRecordsSanitizedMachineScanFailure(t *testing.T) {
	const userPath = `C:\Users\bob.smith\AppData\Local\Temp\WinGet\defaultState`
	tests := []struct {
		name      string
		stdout    string
		stderr    string
		code      int
		err       error
		want      []string
		maxLength int
	}{
		{name: "dll not found (DWORD exit)", code: 3221225781, stderr: "error at " + userPath,
			want: []string{"winget exited 0xC0000135", "DLL not found", "Visual C++"}},
		{name: "dll not found (int32-narrowed exit)", code: -1073741515,
			want: []string{"winget exited 0xC0000135", "DLL not found"}},
		{name: "dll init failed", code: -1073741502, want: []string{"winget exited 0xC0000142", "DLL initialization failed"}},
		{name: "unknown exit code", code: 0x8A150001, stderr: userPath, want: []string{"winget exited 0x8A150001"}},
		{name: "could not start", err: errors.New("exec: " + userPath + ": file does not exist"), want: []string{"winget could not be started"}},
		{name: "unreadable output", stdout: "Nombre  Id  Versión\n" + userPath + "\n", want: []string{"winget output could not be read", "exit 0x00000000"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
				return tc.stdout, tc.stderr, tc.code, tc.err
			})
			if _, err := p.Scan(); err == nil {
				t.Fatal("scan must fail")
			}
			got := p.LastMachineScanFailure()
			for _, w := range tc.want {
				if !strings.Contains(got, w) {
					t.Errorf("LastMachineScanFailure = %q, want it to contain %q", got, w)
				}
			}
			if strings.Contains(got, "bob") || strings.Contains(got, `\`) {
				t.Errorf("reason leaks a path: %q", got)
			}
			if len(got) > maxMachineScanFailureLen {
				t.Errorf("reason is %d bytes, cap is %d", len(got), maxMachineScanFailureLen)
			}
		})
	}
}

func TestSystemScanSuccessClearsMachineScanFailure(t *testing.T) {
	fail := true
	p := NewSystemWingetProvider(`C:\wg\winget.exe`, func(string, []string, time.Duration) (string, string, int, error) {
		if fail {
			return "", "", 3221225781, nil
		}
		return wingetUpgradeTable, "", 0, nil
	})
	_, _ = p.Scan()
	if p.LastMachineScanFailure() == "" {
		t.Fatal("failure not recorded")
	}
	fail = false
	if _, err := p.Scan(); err != nil {
		t.Fatal(err)
	}
	if got := p.LastMachineScanFailure(); got != "" {
		t.Fatalf("a successful machine pass must clear the failure, got %q", got)
	}
}

var _ MachineScanReporter = (*SystemWingetProvider)(nil)
