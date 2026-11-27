package procoutput

import (
	"reflect"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/psscript"
)

// PowerShell is started with -Command so the UTF-8 bootstrap runs first.
// Under -Command the process exit code is only 0 or 1 ($? of the last
// statement), so the line ends by passing on the code the script gave to
// `exit` (#12798). The whole line is pinned, quoting included.
func TestWindowsScriptCommandPowerShellQuotesPath(t *testing.T) {
	path := "C:\\Users\\Se\u00e1n O\u2019Brien\\AppData\\Local\\Temp\\breeze-scripts-1\\breeze_2.ps1"
	for _, shell := range []string{"powershell.exe", "PWSH.EXE"} {
		got := windowsScriptCommand(shell, []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, path)
		want := ScriptCommand{Name: shell, Args: []string{
			"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
			"[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; " +
				"& " + psscript.Quote(path) + "; " +
				"if (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }",
		}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("%s:\ngot  %#v\nwant %#v", shell, got, want)
		}
	}
}

// A single quote in the path is doubled inside the PowerShell literal, so
// the path cannot end the literal early and run the rest as code.
func TestWindowsScriptCommandPowerShellPathWithSingleQuote(t *testing.T) {
	path := `C:\Users\it's me\AppData\Local\Temp\breeze-scripts-1\breeze_2.ps1`
	got := windowsScriptCommand("powershell.exe", []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, path)
	if len(got.Args) != 5 {
		t.Fatalf("args = %#v", got.Args)
	}
	if want := `& 'C:\Users\it''s me\AppData\Local\Temp\breeze-scripts-1\breeze_2.ps1'; `; !strings.Contains(got.Args[4], want) {
		t.Fatalf("command %q does not contain %q", got.Args[4], want)
	}
	if got.CmdLine != "" || got.Env != nil {
		t.Fatalf("PowerShell launch must not set CmdLine or Env: %#v", got)
	}
}

// cmd.exe reads the script path from the environment, quoted, so a path with
// spaces or cmd.exe metacharacters (& ^ % ( )) is run as one file name.
func TestWindowsScriptCommandCmdReadsPathFromEnvironment(t *testing.T) {
	path := `C:\Users\Ann & Bob (100%)\AppData\Local\Temp\breeze-scripts-1\breeze_2.bat`
	got := windowsScriptCommand("cmd.exe", []string{"/C"}, path)
	want := ScriptCommand{
		Name:    "cmd.exe",
		CmdLine: `cmd.exe /D /S /C "chcp 65001 >nul & "%BREEZE_SCRIPT_FILE%""`,
		Env:     []string{"BREEZE_SCRIPT_FILE=" + path},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}

// With delayed expansion on (rendered parameters), the path is read with
// !NAME!, which is not re-scanned, so a ! in the path is kept.
func TestWindowsScriptCommandCmdDelayedExpansion(t *testing.T) {
	path := `C:\Users\Hi!\AppData\Local\Temp\breeze-scripts-1\breeze_2.bat`
	got := windowsScriptCommand("cmd.exe", []string{"/V:ON", "/C"}, path)
	want := ScriptCommand{
		Name:    "cmd.exe",
		CmdLine: `cmd.exe /D /V:ON /S /C "chcp 65001 >nul & "!BREEZE_SCRIPT_FILE!""`,
		Env:     []string{"BREEZE_SCRIPT_FILE=" + path},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}

// Without rendered parameters, the host's delayed-expansion default is left
// alone, except that a path containing ! is read with delayed expansion off
// so the ! is kept.
func TestWindowsScriptCommandCmdPathWithExclamation(t *testing.T) {
	path := `C:\Users\Hi!\AppData\Local\Temp\breeze-scripts-1\breeze_2.bat`
	got := windowsScriptCommand("cmd.exe", []string{"/C"}, path)
	want := ScriptCommand{
		Name:    "cmd.exe",
		CmdLine: `cmd.exe /D /V:OFF /S /C "chcp 65001 >nul & "%BREEZE_SCRIPT_FILE%""`,
		Env:     []string{"BREEZE_SCRIPT_FILE=" + path},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}

func TestWindowsScriptCommandOtherShells(t *testing.T) {
	got := windowsScriptCommand("python", nil, `C:\Temp\x.py`)
	want := ScriptCommand{Name: "python", Args: []string{`C:\Temp\x.py`}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}
