//go:build !windows

package config

import "os"

func enforceConfigDirPermissions(path string) error {
	return os.Chmod(path, 0750)
}

func enforceConfigFilePermissions(path string) error {
	return os.Chmod(path, 0640)
}

func enforceSecretFilePermissions(path string) error {
	return os.Chmod(path, 0600)
}
