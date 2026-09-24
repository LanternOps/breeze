package hwhealth

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestToolDirsOverride(t *testing.T) {
	dirs := []string{t.TempDir(), t.TempDir()}
	name := "breeze-hwhealth-fixture-tool"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	local := filepath.Join(dirs[1], name)
	if err := os.WriteFile(local, []byte("fixture; never executed"), 0755); err != nil {
		t.Fatal(err)
	}
	// A unique filename avoids installed tools; no global PATH mutation or tool execution.
	path, ok := lookupTool([]string{name}, dirs)
	if !ok || path != local {
		t.Fatalf("override=%q %t", path, ok)
	}
}

func TestToolDirsDocs(t *testing.T) {
	repoDocs := filepath.Join("..", "..", "..", "..", "docs")
	// A copied test binary (native Windows lab run) or an agent-only mount has no repository
	// docs tree at all; in a full checkout a missing guide is a failure, never a skip.
	if _, err := os.Stat(repoDocs); os.IsNotExist(err) {
		t.Skip("repository docs tree not present next to the agent module")
	}
	docs, err := os.ReadFile(filepath.Join(repoDocs, "guides", "AGENT_INSTALLATION.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, needle := range []string{"hardware:", "tool_dirs:", "'D:\\tools'", "fixture-only", "hpssacli", "hpacucli", "agent-local"} {
		if !strings.Contains(string(docs), needle) {
			t.Fatalf("documentation missing %q", needle)
		}
	}
}
