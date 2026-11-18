package isolation

import (
	"os/exec"
	"strings"
	"testing"
)

// The recovery binary links this package and must survive a broken agent, so
// neither package may pull in the agent's heartbeat, config, updater or
// remote/tools (which itself imports updater and config).
func TestIsolationImportsStayMinimal(t *testing.T) {
	forbidden := []string{
		"github.com/breeze-rmm/agent/internal/heartbeat",
		"github.com/breeze-rmm/agent/internal/config",
		"github.com/breeze-rmm/agent/internal/updater",
		"github.com/breeze-rmm/agent/internal/remote/tools",
	}
	for _, goos := range []string{"linux", "darwin", "windows"} {
		for _, pkg := range []string{".", "./journal"} {
			cmd := exec.Command("go", "list", "-deps", pkg)
			cmd.Env = append(cmd.Environ(), "GOOS="+goos, "CGO_ENABLED=0")
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("go list -deps %s (GOOS=%s): %v\n%s", pkg, goos, err, out)
			}
			for _, dep := range strings.Fields(string(out)) {
				for _, bad := range forbidden {
					if dep == bad || strings.HasPrefix(dep, bad+"/") {
						t.Errorf("%s (GOOS=%s) depends on %s", pkg, goos, dep)
					}
				}
				if pkg == "./journal" && dep == "github.com/breeze-rmm/agent/internal/isolation" {
					t.Errorf("journal imports its parent package")
				}
			}
		}
	}
}
