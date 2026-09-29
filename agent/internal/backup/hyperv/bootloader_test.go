package hyperv

import (
	"reflect"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/hosttool"
)

// Instant boot regenerates the boot files with the HOST's bcdboot.exe, by
// absolute path from the host's own System32 — the same rule the rebuild
// engine follows — never a bare name resolved through PATH and never a
// binary from the restored volume. bcdboot still copies the restored
// system's boot files from <letter>:\Windows.
func TestBcdbootCommand_RunsHostSystem32Binary(t *testing.T) {
	exe, args, err := bcdbootCommand("E")
	if err != nil {
		t.Fatalf("bcdbootCommand: %v", err)
	}
	if want := hosttool.SystemTool("bcdboot.exe"); exe != want {
		t.Errorf("exe = %q, want the host's %q", exe, want)
	}
	if !strings.HasSuffix(strings.ToLower(exe), `\system32\bcdboot.exe`) || len(exe) < 3 || exe[1] != ':' {
		t.Errorf("exe = %q, want an absolute System32 path", exe)
	}
	if strings.HasPrefix(strings.ToUpper(exe), "E:") {
		t.Errorf("exe = %q resolves on the restored volume E:", exe)
	}
	if want := []string{`E:\Windows`, "/s", "E:", "/f", "UEFI"}; !reflect.DeepEqual(args, want) {
		t.Errorf("args = %q, want %q", args, want)
	}
}

// The drive letter comes from PowerShell output; anything but one ASCII
// letter is refused rather than passed on to bcdboot.
func TestBcdbootCommand_RefusesMalformedDriveLetter(t *testing.T) {
	for _, bad := range []string{"", "EF", "1", ":", `E:\`, "É"} {
		if exe, args, err := bcdbootCommand(bad); err == nil {
			t.Errorf("bcdbootCommand(%q) = %q %q, want an error", bad, exe, args)
		}
	}
}

// Every PowerShell script in this package runs under the host's own
// powershell.exe by absolute path, never resolved through PATH — the restored
// volume has a drive letter while most of these scripts run.
func TestPowerShellExe_IsHostSystem32Binary(t *testing.T) {
	if got, want := powerShellExe(), hosttool.SystemTool(`WindowsPowerShell\v1.0\powershell.exe`); got != want {
		t.Errorf("powerShellExe() = %q, want %q", got, want)
	}
}
