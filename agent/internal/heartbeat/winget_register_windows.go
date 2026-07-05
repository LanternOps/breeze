//go:build windows

package heartbeat

import "github.com/breeze-rmm/agent/internal/patching"

// registerSystemWinget resolves winget (locating an existing install or,
// once Task 9b lands, provisioning one via the Appx stack) and registers a
// SystemWingetProvider that runs winget directly from this SYSTEM agent
// process at machine scope — no logged-in user or user-helper IPC required.
func (h *Heartbeat) registerSystemWinget() {
	res := patching.EnsureWinget(patching.NewEnsureDeps(h.config))
	if patching.RegisterSystemWinget(h.patchMgr, res, patching.DefaultRunner) {
		if res.Reason != "" {
			// Registered, but on a degraded fallback: an older winget is in use
			// because provisioning a newer one failed. Log at Warn so a fleet
			// silently stuck on stale winget after repeated failed upgrades
			// stays visible rather than reading as a clean registration.
			log.Warn("winget provider registered on stale install; provisioning failed",
				"version", res.Version, "reason", res.Reason)
		} else {
			log.Info("winget provider registered (SYSTEM, machine scope)", "version", res.Version)
		}
	} else {
		log.Info("winget provider not registered", "reason", res.Reason)
	}
}
