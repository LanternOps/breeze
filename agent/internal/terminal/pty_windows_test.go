//go:build windows

package terminal

import (
	"strings"
	"testing"
)

func TestBuildCommandLinePowerShellSetsUTF8(t *testing.T) {
	got := buildCommandLine(`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`)
	if got == `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` {
		t.Fatalf("expected UTF-8 bootstrap command, got bare shell: %q", got)
	}
	for _, part := range []string{"InputEncoding", "OutputEncoding", "UTF8"} {
		if !strings.Contains(got, part) {
			t.Fatalf("expected %q in command line, got %q", part, got)
		}
	}
}

func TestBuildCommandLineCmdSetsUTF8CodePage(t *testing.T) {
	got := buildCommandLine(`C:\Windows\System32\cmd.exe`)
	want := `C:\Windows\System32\cmd.exe /K chcp 65001 >nul`
	if got != want {
		t.Fatalf("buildCommandLine(cmd.exe) = %q, want %q", got, want)
	}
}
