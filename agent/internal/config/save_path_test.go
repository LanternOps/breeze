package config

import (
	"os"
	"path/filepath"
	"testing"
)

// TestResolveSavePath: an empty --config flag must resolve to the agent.yaml
// SaveEnrollment really writes, so enrollment errors can name it (#7394 printed
// "could not save config to  -" with the empty flag value).
func TestResolveSavePath(t *testing.T) {
	if got, want := ResolveSavePath(""), filepath.Join(ConfigDir(), "agent.yaml"); got != want {
		t.Errorf("ResolveSavePath(\"\") = %q, want %q", got, want)
	}
	explicit := filepath.Join(t.TempDir(), "custom.yaml")
	if got := ResolveSavePath(explicit); got != explicit {
		t.Errorf("ResolveSavePath(%q) = %q, want it unchanged", explicit, got)
	}
}

// TestPrepareSaveDir: the enrollment pre-flight creates and secures the
// directory SaveEnrollment will write into, and fails without writing
// anything when it cannot.
func TestPrepareSaveDir(t *testing.T) {
	t.Run("creates the directory", func(t *testing.T) {
		dir := filepath.Join(t.TempDir(), "Breeze")
		if err := PrepareSaveDir(filepath.Join(dir, "agent.yaml")); err != nil {
			t.Fatalf("PrepareSaveDir: %v", err)
		}
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			t.Fatalf("directory not created: %v", err)
		}
		if _, err := os.Stat(filepath.Join(dir, "agent.yaml")); !os.IsNotExist(err) {
			t.Errorf("PrepareSaveDir must not write agent.yaml (stat err %v)", err)
		}
	})
	t.Run("fails when the directory cannot be created", func(t *testing.T) {
		blocker := filepath.Join(t.TempDir(), "blocker")
		if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := PrepareSaveDir(filepath.Join(blocker, "agent.yaml")); err == nil {
			t.Fatal("PrepareSaveDir must fail when a file sits where the directory should be")
		}
	})
}
