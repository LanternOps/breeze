package helper

import "time"

// Failure accounting shared by the first-install branch of Apply and
// applyPendingUpdate (#6927). Both call downloadAndInstall for the version the
// server offered, and both must stop re-running the download and the
// privileged installer on every heartbeat once that version keeps failing.
//
// A version is abandoned after maxHelperInstallFailures failed attempts.
// CheckUpdate ignores an abandoned version until helperAbandonRetryAfter has
// passed, which bounds a persistently failing install to a few attempts per
// cooldown window, and still lets a transient outage (network, AV holding the
// fresh binary) heal without an agent restart. Offering a different version
// re-arms the install immediately.
const (
	maxHelperInstallFailures = 3
	helperAbandonRetryAfter  = 6 * time.Hour
)

func (m *Manager) nowTime() time.Time {
	if m.now != nil {
		return m.now()
	}
	return time.Now()
}

// isAbandonedLocked reports whether version is inside its abandon cooldown.
// An expired abandonment is cleared here. Must be called with m.mu held.
func (m *Manager) isAbandonedLocked(version string) bool {
	if version == "" || version != m.abandonedVersion {
		return false
	}
	if m.nowTime().Sub(m.abandonedAt) < helperAbandonRetryAfter {
		return true
	}
	log.Info("helper abandon cooldown elapsed, allowing a retry", "targetVersion", version)
	m.abandonedVersion = ""
	m.abandonedAt = time.Time{}
	return false
}

// recordInstallFailureLocked counts one failed attempt at version. The count
// is kept per version (failuresVersion), so an offer that disappears for one
// heartbeat and comes back does not reset it. Must be called with m.mu held.
func (m *Manager) recordInstallFailureLocked(version string) {
	if m.failuresVersion != version {
		m.failuresVersion = version
		m.updateFailures = 0
	}
	m.updateFailures++
}

// abandonIfExhaustedLocked abandons the pending version once it has used up
// its failure budget, and reports whether it did. Called before an attempt, so
// the cap is maxHelperInstallFailures attempts. Must be called with m.mu held.
func (m *Manager) abandonIfExhaustedLocked() bool {
	if m.pendingHelperVersion == "" || m.failuresVersion != m.pendingHelperVersion ||
		m.updateFailures < maxHelperInstallFailures {
		return false
	}
	log.Warn("helper install abandoned after repeated failures, clearing pending version",
		"targetVersion", m.pendingHelperVersion,
		"failures", m.updateFailures,
		"retryAfter", helperAbandonRetryAfter.String(),
	)
	m.abandonedVersion = m.pendingHelperVersion
	m.abandonedAt = m.nowTime()
	m.pendingHelperVersion = ""
	m.clearInstallFailuresLocked()
	return true
}

// clearInstallFailuresLocked resets the failure count. Must be called with m.mu held.
func (m *Manager) clearInstallFailuresLocked() {
	m.updateFailures = 0
	m.failuresVersion = ""
}

// WithdrawOffer is called on a heartbeat that carries no helper version offer.
// The server stops offering when it has no helper build for this device (for
// example the helper row was deleted, which otherwise makes every retry fail
// with a 404 on the download info), or when the helper is already current or
// the update gate is closed. A pending version the server no longer offers must
// not keep driving installs. The failure count is kept, so a re-offer of the
// same version continues against the same budget.
func (m *Manager) WithdrawOffer() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.pendingHelperVersion == "" {
		return
	}
	log.Info("server no longer offers a helper version, clearing pending version",
		"targetVersion", m.pendingHelperVersion)
	m.pendingHelperVersion = ""
}
