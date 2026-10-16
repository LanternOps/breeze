package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestInstalledAgentPath(t *testing.T) {
	setup := func(t *testing.T) (string, string) {
		root := t.TempDir()
		trusted, legacy := filepath.Join(root, "Library-Breeze-bin"), filepath.Join(root, "usr-local-bin")
		for _, d := range []string{trusted, legacy} {
			if err := os.Mkdir(d, 0o755); err != nil {
				t.Fatal(err)
			}
		}
		return trusted, legacy
	}
	agent := func(t *testing.T, dir string) {
		if err := os.WriteFile(filepath.Join(dir, "breeze-agent"), []byte("x"), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("trusted install (#8778)", func(t *testing.T) {
		trusted, legacy := setup(t)
		agent(t, trusted)
		if got := installedAgentPath(trusted, legacy); got != filepath.Join(trusted, "breeze-agent") {
			t.Fatalf("got %s", got)
		}
	})
	t.Run("legacy install", func(t *testing.T) {
		trusted, legacy := setup(t)
		agent(t, legacy)
		if got := installedAgentPath(trusted, legacy); got != filepath.Join(legacy, "breeze-agent") {
			t.Fatalf("got %s", got)
		}
	})
	t.Run("trusted wins over a leftover legacy copy", func(t *testing.T) {
		trusted, legacy := setup(t)
		agent(t, trusted)
		agent(t, legacy)
		if got := installedAgentPath(trusted, legacy); got != filepath.Join(trusted, "breeze-agent") {
			t.Fatalf("got %s", got)
		}
	})
	t.Run("a symlink in the trusted dir is not trusted", func(t *testing.T) {
		trusted, legacy := setup(t)
		agent(t, legacy)
		if err := os.Symlink(filepath.Join(legacy, "breeze-agent"), filepath.Join(trusted, "breeze-agent")); err != nil {
			t.Fatal(err)
		}
		if got := installedAgentPath(trusted, legacy); got != filepath.Join(legacy, "breeze-agent") {
			t.Fatalf("got %s", got)
		}
	})
}
