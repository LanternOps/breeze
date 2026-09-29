//go:build linux

package macrelocate

import "errors"

// migrateToTrustedDir exists on linux only so DefaultDeps compiles (and is
// tested) there; Linux installs are never relocated.
func migrateToTrustedDir(string, string) (string, error) {
	return "", errors.New("executable relocation is macOS-only")
}
