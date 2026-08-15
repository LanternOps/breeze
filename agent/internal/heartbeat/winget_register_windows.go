//go:build windows

package heartbeat

import "github.com/breeze-rmm/agent/internal/patching"

// registerSystemWinget resolves winget (locating an existing install or,
// once Task 9b lands, provisioning one via the Appx stack) and registers a
// SystemWingetProvider that runs winget directly from this SYSTEM agent
// process at machine scope. Machine scope alone never requires a logged-in
// user; the additional per-user pass wired in below is best-effort on top.
func (h *Heartbeat) registerSystemWinget() {
	res := patching.EnsureWinget(patching.NewEnsureDeps(h.config))
	// The provider also runs a best-effort second pass inside the interactive
	// user's session, because a machine-scope scan as SYSTEM cannot see per-user
	// installs (Chrome/Zoom/Slack et al) at all (#2727). The bridge is nil when
	// no session broker exists, and each individual scan degrades to
	// machine-scope-only when nobody is logged in.
	userExec := h.makeUserExecFunc()
	if patching.RegisterSystemWingetWithUserScan(h.patchMgr, res, patching.DefaultRunner, userExec) {
		if res.Reason != "" {
			// Registered, but on a degraded fallback: an older winget is in use
			// because provisioning a newer one failed. Log at Warn so a fleet
			// silently stuck on stale winget after repeated failed upgrades
			// stays visible rather than reading as a clean registration.
			log.Warn("winget provider registered on stale install; provisioning failed",
				"version", res.Version, "reason", res.Reason)
		} else {
			log.Info("winget provider registered (SYSTEM, machine scope + best-effort user scope)",
				"version", res.Version, "userScopePass", userExec != nil)
		}
	} else {
		log.Info("winget provider not registered", "reason", res.Reason)
	}
}
