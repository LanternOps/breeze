//go:build darwin

package macrelocate

import "github.com/breeze-rmm/agent/internal/securefs"

func migrateToTrustedDir(legacyPath, trustedDir string) (string, error) {
	return securefs.MigrateExecutableToTrustedDir(nil, legacyPath, trustedDir)
}
