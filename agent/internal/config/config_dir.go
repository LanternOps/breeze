package config

import "sync/atomic"

// configDirOverride replaces the platform config dir when a test sets it
// through SetConfigDirForTest. It is never set in production.
var configDirOverride atomic.Pointer[string]

// configDir is the machine-wide config dir: ProgramData\Breeze on Windows,
// /Library/Application Support/Breeze on macOS, /etc/breeze elsewhere.
func configDir() string {
	if p := configDirOverride.Load(); p != nil {
		return *p
	}
	return platformConfigDir()
}
