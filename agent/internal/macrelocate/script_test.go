//go:build darwin || linux

package macrelocate

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// runRelocateScript executes the real rendered script against a temp copy of
// plist content. The trailing launchctl lines fail harmlessly off a real
// system launchd (they are `|| true`), so only the rewrite and its guard are
// observable here.
func runRelocateScript(t *testing.T, plistContent, oldPath, newPath string) (string, int) {
	t.Helper()
	plist := filepath.Join(t.TempDir(), "com.breeze.agent.plist")
	if err := os.WriteFile(plist, []byte(plistContent), 0o644); err != nil {
		t.Fatal(err)
	}
	script := BuildRelocateScript(plist, oldPath, newPath)
	// Drop the startup delay; it only matters against a real, running daemon.
	script = strings.Replace(script, "sleep 2\n", "", 1)
	err := exec.Command("/bin/sh", "-c", script).Run()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
	} else if err != nil {
		t.Fatalf("sh: %v", err)
	}
	got, _ := os.ReadFile(plist)
	return string(got), code
}

// TestRelocateScriptRewritesShippedPlists runs against the plists the .pkg
// actually ships, so a template change the rewrite no longer matches fails
// here instead of silently reloading the daemon from the unchanged plist.
func TestRelocateScriptRewritesShippedPlists(t *testing.T) {
	cases := []struct{ src, name string }{
		{"../../service/launchd/com.breeze.agent.plist", "breeze-agent"},
		{"../../installer/macos/com.breeze.watchdog.plist", "breeze-watchdog"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			orig, err := os.ReadFile(tc.src)
			if err != nil {
				t.Fatal(err)
			}
			got, code := runRelocateScript(t, string(orig), "/usr/local/bin/"+tc.name, "/Library/Breeze/bin/"+tc.name)
			if code != 0 {
				t.Fatalf("script exited %d", code)
			}
			want := strings.Replace(string(orig),
				"<string>/usr/local/bin/"+tc.name+"</string>",
				"<string>/Library/Breeze/bin/"+tc.name+"</string>", 1)
			if want == string(orig) {
				t.Fatalf("%s does not name /usr/local/bin/%s; fixture drifted", tc.src, tc.name)
			}
			if got != want {
				t.Fatalf("rewritten plist:\n%s", got)
			}
		})
	}
}

// If the rewrite matched nothing, the script must stop before unloading:
// reloading from an unchanged plist would just restart the daemon at the
// legacy path.
func TestRelocateScriptStopsWhenRewriteDidNotTake(t *testing.T) {
	const content = "<array><string>/opt/other/breeze-agent</string></array>"
	got, code := runRelocateScript(t, content, "/usr/local/bin/breeze-agent", "/Library/Breeze/bin/breeze-agent")
	if code == 0 {
		t.Fatal("script must exit non-zero when the plist was not repointed")
	}
	if got != content {
		t.Fatalf("plist changed: %s", got)
	}
}
