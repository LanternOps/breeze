package config

import "os"

// User-readable agent files (#10190). Some files the root/SYSTEM agent writes
// are meant to be read by helpers running as the signed-in user (the MSP
// identity cache under <data dir>/branding). They get exactly the agent.yaml
// policy: on Windows SYSTEM and Administrators full control plus
// BUILTIN\Users read (windowsConfigFileSDDL, the directory gets
// windowsConfigDirSDDL); on Unix 0644 in a 0755 directory. Only root/SYSTEM
// can write them. Never use these for anything secret.

// EnsureUserReadableDir creates dir (and its parents) and applies the
// config-directory policy to dir itself.
func EnsureUserReadableDir(dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	return enforceConfigDirPermissions(dir)
}

// WriteUserReadableFile replaces path atomically (temp file, fsync, rename)
// and then applies the agent.yaml file policy, so a reader never sees a
// partial file.
func WriteUserReadableFile(path string, data []byte) error {
	if err := atomicWriteFile(path, data, 0o644); err != nil {
		return err
	}
	return enforceConfigFilePermissions(path)
}
