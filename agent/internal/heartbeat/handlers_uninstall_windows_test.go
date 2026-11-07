//go:build windows

package heartbeat

import (
	"os/exec"
	"strings"
	"testing"
)

// Windows CI executes the PowerShell guard with every endpoint mutation
// replaced by a function. No firewall, service or filesystem operation runs.
func TestWindowsUninstallReleaseGuardExecution(t *testing.T) {
	for _, tc := range []struct {
		name, release string
		wantFailure   bool
	}{
		{"release failure", "Write-Output 'release'; $global:LASTEXITCODE = 1", true},
		{"launch failure", "throw 'release unavailable'", true},
		{"confirmed release", "Write-Output 'release'; $global:LASTEXITCODE = 0", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			setup := "function Invoke-FixtureAgent { " + tc.release + " }; " +
				"function Start-Sleep { }; function sc.exe { Write-Output ('sc ' + ($args -join ' ')) }; " +
				"function Stop-Service { Write-Output 'teardown' }; function Get-Process { }; " +
				"function Stop-Process { Write-Output 'teardown' }; function Remove-Item { Write-Output 'teardown' }; "
			script := buildWindowsUninstallScript(windowsUninstallScriptOptions{AgentBinaryPath: "Invoke-FixtureAgent", ServiceName: "Fixture", WatchdogServiceName: "FixtureWatchdog"})
			out, err := exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-InputFormat", "None", "-Command", setup+script).CombinedOutput()
			if (err != nil) != tc.wantFailure {
				t.Fatalf("err=%v output=%s", err, out)
			}
			if strings.Contains(string(out), "teardown") == tc.wantFailure {
				t.Fatalf("unexpected teardown state: %s", out)
			}
			// A failed release re-enables the service phase 1 disabled; a
			// confirmed one goes on to delete the watchdog.
			restored := strings.Contains(string(out), "sc config Fixture start= auto")
			if restored != tc.wantFailure {
				t.Fatalf("service restore = %v, want %v: %s", restored, tc.wantFailure, out)
			}
			if !tc.wantFailure && !strings.Contains(string(out), "sc delete FixtureWatchdog") {
				t.Fatalf("confirmed release must proceed to teardown: %s", out)
			}
		})
	}
}
