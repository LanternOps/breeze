package procoutput

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/psscript"
)

func TestWindowsScriptCommandPowerShellQuotesPath(t *testing.T) {
	path := "C:\\Users\\Se\u00e1n O\u2019Brien\\AppData\\Local\\Temp\\breeze-scripts-1\\breeze_2.ps1"
	got := windowsScriptCommand("powershell.exe", []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File"}, path)
	want := ScriptCommand{Name: "powershell.exe", Args: []string{
		"-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
		powershellUTF8Bootstrap + "& " + psscript.Quote(path),
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
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
