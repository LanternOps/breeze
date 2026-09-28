//go:build darwin

package agentapp

import (
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/macrelocate"
	"github.com/breeze-rmm/agent/internal/securefs"
)

// agentRelocateConfig describes the agent binary for internal/macrelocate.
// breeze-backup rides along as a sibling: the agent resolves it next to its
// own executable. The relocation record goes in the config directory, where
// the heartbeat reads it to report a Full Disk Access grant lost to the move.
func agentRelocateConfig() macrelocate.Config {
	return macrelocate.Config{
		LegacyDir:  securefs.LegacyExecutableDir,
		TrustedDir: securefs.TrustedExecutableDir,
		PlistPath:  darwinPlistDst,
		Siblings:   []string{"breeze-backup"},
		RecordDir:  config.ConfigDir(),
	}
}

// maybeMigrateLegacyInstall is the darwin entry point called from runAgent.
// It relocates the agent out of /usr/local/bin only when that location is
// unsafe for a root daemon, and cleans up after a relocation; see
// internal/macrelocate for the full rationale (#7211). It never blocks or
// fails startup.
func maybeMigrateLegacyInstall() {
	macrelocate.Run(agentRelocateConfig(), macrelocate.DefaultDeps(log))
}
