package bmr

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/securefs"
)

func privateTestLocalProvider(t *testing.T, path string) *providers.LocalProvider {
	t.Helper()
	if err := securefs.EnsurePrivateDir(path); err != nil {
		t.Fatal(err)
	}
	return providers.NewLocalProvider(path)
}
