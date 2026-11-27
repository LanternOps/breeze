package procoutput

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/psscript"
)

// powershellExitCodeCase is one script whose PowerShell exit code the agent
// must report. want is the code powershell -File gives for the same file,
// which is the contract (#12798); the test also checks it against -File on
// the host, so a PowerShell version that disagrees fails loudly.
type powershellExitCodeCase struct {
	name   string
	script string
	want   int
}

// powershellExitCodeCases mirrors the Windows end-to-end test in the
// executor package, which adds the codes above 255. native runs a second
// copy of the current PowerShell as a native command.
func powershellExitCodeCases() []powershellExitCodeCase {
	const native = "$native = (Get-Process -Id $PID).Path\n"
	return []powershellExitCodeCase{
		{name: "succeeds", script: "Write-Output 'out-succeeds'", want: 0},
		{name: "exit 0", script: "Write-Output 'out-exit0'\nexit 0", want: 0},
		{name: "exit 1", script: "Write-Output 'out-exit1'\nexit 1", want: 1},
		{name: "exit 3", script: "Write-Output 'out-exit3'\nexit 3", want: 3},
		{name: "exit 200", script: "Write-Output 'out-exit200'\nexit 200", want: 200},
		{name: "param block then exit 4", script: "param([string]$a = 'd')\nWrite-Output \"out-param-$a\"\nexit 4", want: 4},
		{name: "throw", script: "Write-Output 'out-throw'\nthrow 'boom'", want: 1},
		{name: "terminating cmdlet error", script: "$ErrorActionPreference = 'Stop'\nWrite-Output 'out-stop'\nGet-Item -LiteralPath 'breeze-12798-no-such-path'", want: 1},
		{name: "native exit code passed to exit", script: native + "Write-Output 'out-native-exit'\n& $native -NoProfile -Command 'exit 7'\nexit $LASTEXITCODE", want: 7},
		// Without `exit`, -File reports 0 even when the last native command
		// failed ("with normal termination, the exit code is always 0").
		{name: "native fails last, no exit", script: native + "Write-Output 'out-native-last'\n& $native -NoProfile -Command 'exit 7'", want: 0},
		{name: "native fails, script goes on", script: native + "& $native -NoProfile -Command 'exit 7'\nWrite-Output 'out-native-mid'", want: 0},
		{name: "non-terminating cmdlet error last", script: "Write-Output 'out-cmdlet-last'\nGet-Item -LiteralPath 'breeze-12798-no-such-path'", want: 0},
	}
}

// The command line windowsScriptCommand builds is plain PowerShell, so it is
// run here through pwsh on whichever host has it. Exit codes above 255 are
// covered by the Windows test in the executor package; a POSIX exit status
// has only 8 bits.
func TestWindowsScriptCommandPowerShellReportsScriptExitCode(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("pwsh not available")
	}
	dir := filepath.Join(t.TempDir(), "it's a dir")
	if err := os.Mkdir(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	for i, tc := range powershellExitCodeCases() {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(dir, "case "+string(rune('a'+i))+".ps1")
			if err := os.WriteFile(path, []byte(psscript.WithBOM(tc.script+"\n")), 0o600); err != nil {
				t.Fatal(err)
			}
			launch := windowsScriptCommand("pwsh.exe", []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, path)
			got, stdout := runForExitCode(t, pwsh, launch.Args...)
			if got != tc.want {
				t.Errorf("exit code %d, want %d (stdout %q)", got, tc.want, stdout)
			}
			if !strings.Contains(stdout, "out-") {
				t.Errorf("script output not captured: %q", stdout)
			}
			oracle, _ := runForExitCode(t, pwsh, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path)
			if oracle != tc.want {
				t.Errorf("pwsh -File gives %d on this host, want %d", oracle, tc.want)
			}
		})
	}
}

func runForExitCode(t *testing.T, name string, args ...string) (int, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).Output()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return 0, string(out)
	case errors.As(err, &exitErr) && ctx.Err() == nil:
		return exitErr.ExitCode(), string(out)
	default:
		t.Fatalf("run %s: %v", name, err)
		return 0, ""
	}
}
