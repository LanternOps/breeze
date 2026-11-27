//go:build windows

package executor

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/procoutput"
	"github.com/breeze-rmm/agent/internal/psscript"
)

// windowsPowerShellTimeout gives a cold powershell.exe room to start on a
// loaded runner. It is the per-run ScriptExecution.Timeout this test asks
// for, not the production default.
const windowsPowerShellTimeout = 120

// TestExecuteWindowsPowerShellReportsScriptExitCode runs real scripts
// through Execute under Windows PowerShell and checks the exit code the
// agent reports is the one the script gave (#12798): `exit N` is N, 3010 and
// 1641 included; a thrown error is 1; a script that ends without `exit` is 0,
// as with powershell -File, even when its last native command failed. Each
// expected code is also checked against powershell -File on the same host.
//
// TMP points at a directory whose name has a space and a single quote, so
// the staged script path the command line quotes has both.
func TestExecuteWindowsPowerShellReportsScriptExitCode(t *testing.T) {
	if _, err := exec.LookPath("powershell.exe"); err != nil {
		t.Fatalf("powershell.exe not found: %v", err)
	}
	tmp := filepath.Join(t.TempDir(), "it's a dir")
	if err := os.Mkdir(tmp, 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("TMP", tmp)
	t.Setenv("TEMP", tmp)
	if got := os.TempDir(); got != tmp {
		t.Fatalf("os.TempDir() = %q, want %q", got, tmp)
	}
	oracleDir := t.TempDir()

	const native = "$native = (Get-Process -Id $PID).Path\n"
	cases := []struct {
		name   string
		script string
		want   int
	}{
		{"succeeds", "Write-Output 'out-succeeds'", 0},
		{"exit 0", "Write-Output 'out-exit0'\nexit 0", 0},
		{"exit 1", "Write-Output 'out-exit1'\nexit 1", 1},
		{"exit 3", "Write-Output 'out-exit3'\nexit 3", 3},
		{"exit 3010", "Write-Output 'out-exit3010'\nexit 3010", 3010},
		{"exit 1641", "Write-Output 'out-exit1641'\nexit 1641", 1641},
		{"param block then exit 4", "param([string]$a = 'd')\nWrite-Output \"out-param-$a\"\nexit 4", 4},
		{"throw", "Write-Output 'out-throw'\nthrow 'boom'", 1},
		{"terminating cmdlet error", "$ErrorActionPreference = 'Stop'\nWrite-Output 'out-stop'\nGet-Item -LiteralPath 'breeze-12798-no-such-path'", 1},
		{"native exit code passed to exit", native + "Write-Output 'out-native-exit'\n& $native -NoProfile -Command 'exit 7'\nexit $LASTEXITCODE", 7},
		{"native fails last, no exit", native + "Write-Output 'out-native-last'\n& $native -NoProfile -Command 'exit 7'", 0},
		{"native fails, script goes on", native + "& $native -NoProfile -Command 'exit 7'\nWrite-Output 'out-native-mid'", 0},
		{"non-terminating cmdlet error last", "Write-Output 'out-cmdlet-last'\nGet-Item -LiteralPath 'breeze-12798-no-such-path'", 0},
	}

	e := newTestExecutor()
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result, err := e.Execute(ScriptExecution{
				ID:         "exitcode-" + t.Name(),
				ScriptType: ScriptTypePowerShell,
				Script:     tc.script,
				Timeout:    windowsPowerShellTimeout,
			})
			if err != nil {
				t.Fatalf("execute: %v (stderr %q)", err, result.Stderr)
			}
			if result.Error != "" {
				t.Fatalf("result error %q (stderr %q)", result.Error, result.Stderr)
			}
			if result.ExitCode != tc.want {
				t.Errorf("exit code %d, want %d (stdout %q, stderr %q)", result.ExitCode, tc.want, result.Stdout, result.Stderr)
			}
			if !strings.Contains(result.Stdout, "out-") {
				t.Errorf("script output not captured: stdout %q, stderr %q", result.Stdout, result.Stderr)
			}

			path := filepath.Join(oracleDir, "case"+string(rune('a'+i))+".ps1")
			if err := os.WriteFile(path, []byte(psscript.WithBOM(tc.script+"\n")), 0o600); err != nil {
				t.Fatal(err)
			}
			if oracle := windowsExitCode(t, "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path); oracle != tc.want {
				t.Errorf("powershell -File gives %d on this host, want %d", oracle, tc.want)
			}
		})
	}
}

// TestWindowsScriptCommandPwshReportsScriptExitCode runs the pwsh.exe form
// of the command line, which PowerShell 7 hosts get, when pwsh is installed.
func TestWindowsScriptCommandPwshReportsScriptExitCode(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh.exe")
	if err != nil {
		t.Skip("pwsh.exe not installed")
	}
	dir := filepath.Join(t.TempDir(), "it's a dir")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		script string
		want   int
	}{
		{"Write-Output 'ok'", 0},
		{"exit 3010", 3010},
		{"throw 'boom'", 1},
	} {
		path := filepath.Join(dir, "my script.ps1")
		if err := os.WriteFile(path, []byte(psscript.WithBOM(tc.script+"\n")), 0o600); err != nil {
			t.Fatal(err)
		}
		launch := procoutput.WindowsScriptCommand(pwsh, []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, path)
		if launch.CmdLine != "" {
			t.Fatalf("PowerShell launch set CmdLine %q", launch.CmdLine)
		}
		if got := windowsExitCode(t, launch.Name, launch.Args...); got != tc.want {
			t.Errorf("%q: exit code %d, want %d", tc.script, got, tc.want)
		}
	}
}

func windowsExitCode(t *testing.T, name string, args ...string) int {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), windowsPowerShellTimeout*time.Second)
	defer cancel()
	err := exec.CommandContext(ctx, name, args...).Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &exitErr) && ctx.Err() == nil:
		return exitErr.ExitCode()
	default:
		t.Fatalf("run %s: %v", name, err)
		return 0
	}
}
