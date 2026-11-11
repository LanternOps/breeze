package agentapp

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/config"
)

// Seams for tests.
var (
	finishConfirmedRebindFn   = config.FinishConfirmedRebind
	reloadConfigAfterRebindFn = config.Load
)

// finishConfirmedRebindAtStartup completes a reattach (#8318 §6.6, "Crash
// during the local swap") that a previous process confirmed but did not
// finish writing, before anything reads the identity or the credentials.
// It returns the config to start with: cfg, or cfg reloaded when the
// identity on disk changed.
//
// A failure to finish is not fatal here: the staged set stays on disk, and
// the heartbeat resumes it (it re-applies the swap and restarts).
func finishConfirmedRebindAtStartup(cfg *config.Config) (*config.Config, error) {
	cfgFile := config.ActiveConfigFile()
	changed, err := finishConfirmedRebindFn(cfgFile)
	if err != nil {
		log.Error("could not finish a confirmed reattach at start; the heartbeat retries it", "error", err.Error())
	}
	if !changed {
		return cfg, nil
	}
	// startAgent computes the runtime-only flags (IsService, IsHeadless,
	// IsInstalledAgent) after this call, on the config returned here.
	reloaded, err := reloadConfigAfterRebindFn(cfgFile)
	if err != nil {
		return nil, fmt.Errorf("reloading the reattached identity: %w", err)
	}
	log.Info("finished a confirmed reattach: this install is now the reattached device",
		"deviceId", reloaded.DeviceID, "agentId", reloaded.AgentID, "orgId", reloaded.OrgID, "siteId", reloaded.SiteID)
	return reloaded, nil
}
