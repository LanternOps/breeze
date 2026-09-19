//go:build !windows

package executor

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteScriptFileIgnoresAttackerControlledFixedTempTree(t *testing.T) {
	tempRoot := t.TempDir()
	t.Setenv("TMPDIR", tempRoot)
	outside := filepath.Join(tempRoot, "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	legacyRoot := filepath.Join(tempRoot, "breeze-scripts")
	if err := os.Symlink(outside, legacyRoot); err != nil {
		t.Fatal(err)
	}

	scriptPath, err := WriteScriptFile("echo safe", ScriptTypeBash)
	if err != nil {
		t.Fatalf("WriteScriptFile: %v", err)
	}
	defer CleanupScript(scriptPath)
	if filepath.Dir(scriptPath) == legacyRoot || !strings.HasPrefix(filepath.Base(filepath.Dir(scriptPath)), "breeze-scripts-") {
		t.Fatalf("script path %q reused attacker-controlled fixed tree", scriptPath)
	}
	entries, err := os.ReadDir(outside)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("attacker-controlled outside directory received files: %v", entries)
	}
}

func TestWriteScriptFileUsesPrivateUniqueDirectoryAndCleanup(t *testing.T) {
	t.Setenv("TMPDIR", t.TempDir())
	first, err := WriteScriptFile("echo first", ScriptTypeBash)
	if err != nil {
		t.Fatal(err)
	}
	second, err := WriteScriptFile("echo second", ScriptTypeBash)
	if err != nil {
		CleanupScript(first)
		t.Fatal(err)
	}
	if filepath.Dir(first) == filepath.Dir(second) {
		t.Fatal("separate scripts shared a writable staging directory")
	}
	for _, scriptPath := range []string{first, second} {
		dir := filepath.Dir(scriptPath)
		info, err := os.Lstat(dir)
		if err != nil {
			t.Fatal(err)
		}
		if !info.IsDir() || info.Mode().Perm() != 0o700 {
			t.Fatalf("script directory mode = %v, want private 0700 directory", info.Mode())
		}
		CleanupScript(scriptPath)
		if _, err := os.Lstat(dir); !os.IsNotExist(err) {
			t.Fatalf("private script directory survived cleanup: %v", err)
		}
	}
}
