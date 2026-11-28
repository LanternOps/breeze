package procspawn

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// #12835: every winget exec site goes through procspawn (spawn_contract_test
// enforces that), so procspawn is where the VC++ framework lands on winget's
// child PATH. This proves all three entry points apply it, on any host, using
// a real WindowsApps-shaped tree.
func TestEveryEntryPointPutsVCLibsOnWingetPath(t *testing.T) {
	root := filepath.Join(t.TempDir(), "WindowsApps")
	appDir := filepath.Join(root, "Microsoft.DesktopAppInstaller_1.29.380.0_x64__8wekyb3d8bbwe")
	vclibs := filepath.Join(root, "Microsoft.VCLibs.140.00.UWPDesktop_14.0.33728.0_x64__8wekyb3d8bbwe")
	for _, d := range []string{appDir, vclibs} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	winget := filepath.Join(appDir, "winget.exe")
	if err := os.WriteFile(winget, nil, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "/usr/bin")
	want := vclibs + string(os.PathListSeparator) + "/usr/bin"

	ctx := t.Context()
	for name, cmd := range map[string]*exec.Cmd{
		"Command":        Command(winget, "--version"),
		"CommandContext": CommandContext(ctx, winget, "--version"),
		"Prepare":        Prepare(exec.Command(winget, "--version")),
	} {
		got := ""
		for _, kv := range cmd.Env {
			if k, v, ok := strings.Cut(kv, "="); ok && strings.EqualFold(k, "PATH") {
				got = v
			}
		}
		if got != want {
			t.Errorf("%s: child PATH = %q, want %q", name, got, want)
		}
	}
	if os.Getenv("PATH") != "/usr/bin" {
		t.Fatal("the agent's own PATH must not change")
	}
}
