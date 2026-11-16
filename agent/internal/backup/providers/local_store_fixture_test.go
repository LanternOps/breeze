package providers

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/securefs"
)

func privateStoreTempDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := securefs.EnsurePrivateDir(dir); err != nil {
		t.Fatal(err)
	}
	return dir
}

func privateTestLocalProvider(t *testing.T, path string) *LocalProvider {
	t.Helper()
	if err := securefs.EnsurePrivateDir(path); err != nil {
		t.Fatal(err)
	}
	return NewLocalProvider(path)
}
