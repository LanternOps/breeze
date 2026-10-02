package config

import "sync/atomic"

// configDirOverride replaces the machine config dir when a test sets it
// through SetConfigDirForTest. It is never set in production.
var configDirOverride atomic.Pointer[string]

// configDir is the dir every default config path (agent.yaml, secrets.yaml,
// agent.state) and, on Windows, the data and log dirs derive from.
//
// In a support session, once its private folder is registered
// (SecureUserWorkspace), that folder is the config dir: a support session
// keeps all of its files there and never creates or writes the machine-wide
// one, which belongs to the installed agent (#7629).
func configDir() string {
	if root := registeredUserWorkspace(); root != "" {
		return root
	}
	return MachineConfigDir()
}

// MachineConfigDir is the machine-wide config dir whether or not a support
// folder is registered: ProgramData\Breeze on Windows,
// /Library/Application Support/Breeze on macOS, /etc/breeze elsewhere. Use it
// only to name the installed agent's location (for example, to check that a
// support folder is not it); everything that reads or writes agent files
// uses ConfigDir.
func MachineConfigDir() string {
	if p := configDirOverride.Load(); p != nil {
		return *p
	}
	return platformConfigDir()
}
