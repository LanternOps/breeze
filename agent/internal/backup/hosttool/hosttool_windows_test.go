//go:build windows

package hosttool

import (
	"os"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// On Windows the seam is the OS's own answer, and SystemTool names a binary
// that is really there.
func TestSystemTool_RealHostWindowsDirectory(t *testing.T) {
	want, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		t.Fatalf("GetSystemWindowsDirectory: %v", err)
	}
	if got := windowsDir(); got != want {
		t.Fatalf("windowsDir() = %q, want %q", got, want)
	}
	exe := SystemTool("cmd.exe")
	if !strings.EqualFold(exe, strings.TrimRight(want, `\/`)+`\System32\cmd.exe`) {
		t.Fatalf("SystemTool(cmd.exe) = %q, not under %q", exe, want)
	}
	if _, err := os.Stat(exe); err != nil {
		t.Fatalf("SystemTool(cmd.exe) = %q does not exist: %v", exe, err)
	}
}
