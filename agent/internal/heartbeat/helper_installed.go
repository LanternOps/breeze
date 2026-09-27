package heartbeat

import "fmt"

// refreshBrokerAfterHelperInstall re-hashes the session broker's helper
// allowlist after the Breeze Helper package installed a new binary at
// binaryPath, then checks that binary made it into the refreshed set.
//
// The broker snapshots the allowlist when the agent starts. On a fresh
// enrollment the Breeze Helper is installed after that, and every helper
// update replaces the file, so without this refresh the new helper is rejected
// with "binary hash mismatch" until the agent restarts (#7043). The broker's
// own on-miss refresh is a backstop; this is the primary path, and it runs
// before the helper manager spawns the new build.
//
// Returns nil when there is no broker (no IPC, so nothing to refresh).
func (h *Heartbeat) refreshBrokerAfterHelperInstall(binaryPath string) error {
	if h.sessionBroker == nil {
		return nil
	}
	if _, err := h.sessionBroker.RefreshAllowedHashes(); err != nil {
		return fmt.Errorf("refresh helper hash allowlist: %w", err)
	}
	hash, allowed, err := h.sessionBroker.HashAndVerifyAllowed(binaryPath)
	if err != nil {
		return fmt.Errorf("verify installed helper against refreshed allowlist: %w", err)
	}
	if !allowed {
		return fmt.Errorf("installed helper %s (sha256 %s) is not in the refreshed allowlist; its IPC connections will be rejected", binaryPath, hash)
	}
	return nil
}

// onHelperInstalled is the helper.WithOnInstalled callback. A failure is
// logged, not returned: the install itself succeeded, and the broker's on-miss
// refresh may still admit the helper when it connects.
func (h *Heartbeat) onHelperInstalled(binaryPath string) {
	if err := h.refreshBrokerAfterHelperInstall(binaryPath); err != nil {
		log.Warn("breeze helper installed but the session broker may reject it",
			"path", binaryPath,
			"error", err.Error(),
		)
		return
	}
	if h.sessionBroker != nil {
		log.Info("session broker allowlist refreshed after breeze helper install", "path", binaryPath)
	}
}
