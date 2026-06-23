package heartbeat

import "fmt"

func (h *Heartbeat) refreshWatchdogHashAllowlist(installPath string) error {
	if h.sessionBroker == nil {
		log.Warn("session broker unavailable - watchdog installed but allowlist not refreshed; restart the agent to guarantee watchdog IPC is accepted")
		return nil
	}
	if _, err := h.sessionBroker.RefreshAllowedHashes(); err != nil {
		return fmt.Errorf("watchdog installed but broker allowlist refresh failed: %w", err)
	}
	installedHash, allowed, err := h.sessionBroker.HashAndVerifyAllowed(installPath)
	if err != nil {
		return fmt.Errorf("watchdog installed but hash verification failed: %w", err)
	}
	if !allowed {
		return fmt.Errorf("watchdog installed but its hash %s is not in the refreshed allowlist; next IPC connection will be rejected", installedHash)
	}
	log.Info("watchdog hash verified in refreshed allowlist", "hash", installedHash)
	return nil
}
