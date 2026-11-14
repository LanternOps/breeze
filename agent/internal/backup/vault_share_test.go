package backup

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// A vault on a network share does not start; the error names the share
// refusal and nothing is created for it.
func TestNewVaultManagerRefusesNetworkShare(t *testing.T) {
	for _, vaultPath := range []string{`\\nas\vault`, `\\?\UNC\nas\vault\breeze`} {
		t.Run(vaultPath, func(t *testing.T) {
			t.Chdir(t.TempDir())
			_, err := NewVaultManager(VaultConfig{VaultPath: vaultPath, Enabled: true}, providers.NewLocalProvider(t.TempDir()))
			if !errors.Is(err, providers.ErrNetworkShareStore) {
				t.Fatalf("NewVaultManager(%q): got %v, want a network share refusal", vaultPath, err)
			}
			if !strings.Contains(err.Error(), "network share") {
				t.Fatalf("vault error %q does not explain the refusal", err.Error())
			}
			entries, readErr := os.ReadDir(".")
			if readErr != nil {
				t.Fatal(readErr)
			}
			if len(entries) != 0 {
				t.Fatalf("refused vault path left entries in the working directory: %v", entries)
			}
		})
	}
}
