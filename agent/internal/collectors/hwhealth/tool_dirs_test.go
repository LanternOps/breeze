package hwhealth

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestToolDirsOverrideAndDocs(t *testing.T) {
	dirs := []string{t.TempDir(), t.TempDir()}
	name := "breeze-hwhealth-fixture-tool"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	local := filepath.Join(dirs[1], name)
	if err := os.WriteFile(local, []byte("fixture; never executed"), 0755); err != nil {
		t.Fatal(err)
	}
	path, ok := lookupTool([]string{name}, dirs)
	if !ok || path != local {
		t.Fatalf("override=%q %t", path, ok)
	}
	// A unique filename avoids installed tools; no global PATH mutation or tool execution.
	docs, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "docs", "guides", "AGENT_INSTALLATION.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{"hardware:", "tool_dirs:", "'D:\\tools'", "fixture-only", "hpssacli", "hpacucli", "agent-local"} {
		if !strings.Contains(string(docs), needle) {
			t.Fatalf("documentation missing %q", needle)
		}
	}
}
