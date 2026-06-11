package sessionbroker

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBinaryPathMatchesAllowedRequiresResolvablePeerPath(t *testing.T) {
	allowed := filepath.Join(t.TempDir(), "breeze-agent")
	if err := os.WriteFile(allowed, []byte("agent"), 0o755); err != nil {
		t.Fatalf("write allowed binary: %v", err)
	}

	if binaryPathMatchesAllowed(filepath.Join(t.TempDir(), "missing-helper"), []string{allowed}) {
		t.Fatal("unresolvable peer path matched allowed helper path")
	}
}

func TestBinaryPathMatchesAllowedResolvesSymlinks(t *testing.T) {
	dir := t.TempDir()
	allowed := filepath.Join(dir, "breeze-desktop-helper")
	if err := os.WriteFile(allowed, []byte("helper"), 0o755); err != nil {
		t.Fatalf("write allowed binary: %v", err)
	}
	link := filepath.Join(dir, "helper-link")
	if err := os.Symlink(allowed, link); err != nil {
		t.Fatalf("symlink helper: %v", err)
	}

	if !binaryPathMatchesAllowed(link, []string{allowed}) {
		t.Fatal("symlinked peer path did not match resolved allowed helper path")
	}
}
