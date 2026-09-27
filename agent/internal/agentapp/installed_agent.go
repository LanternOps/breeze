package agentapp

import (
	"path/filepath"
	"runtime"
	"strings"
)

// resolveIsInstalledAgent decides whether this process is the host's installed
// Breeze agent (config.Config.IsInstalledAgent), the only process allowed to
// manage machine-wide artifacts it shares with other Breeze processes on the
// host, such as the Breeze Assist install.
//
// All three must hold:
//   - not a Quick Support client;
//   - started by the OS service manager (underServiceManager, see
//     runningUnderServiceManager): a foreground `run`, a scheduled task or a
//     hand-launched build is not the installed agent;
//   - running from the canonical agent.yaml under config.ConfigDir(): a second
//     build pointed at its own config file (a lab or test agent on a host that
//     also has the real agent) is not the installed agent even when a service
//     manager started it.
//
// An empty activeConfigFile (no agent.yaml was loaded) is never the installed
// agent.
func resolveIsInstalledAgent(supportMode, underServiceManager bool, activeConfigFile, canonicalConfigFile string) bool {
	if supportMode || !underServiceManager {
		return false
	}
	if strings.TrimSpace(activeConfigFile) == "" || strings.TrimSpace(canonicalConfigFile) == "" {
		return false
	}
	return sameConfigPath(activeConfigFile, canonicalConfigFile)
}

func sameConfigPath(a, b string) bool {
	if abs, err := filepath.Abs(a); err == nil {
		a = abs
	}
	if abs, err := filepath.Abs(b); err == nil {
		b = abs
	}
	a, b = filepath.Clean(a), filepath.Clean(b)
	if runtime.GOOS == "windows" {
		return strings.EqualFold(a, b)
	}
	return a == b
}
