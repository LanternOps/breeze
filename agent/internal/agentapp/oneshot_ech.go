package agentapp

import (
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ech"
)

// enableOneShotECH prepares the shared ECH dialer for a short-lived command
// (enroll, bootstrap, support): on the first filter signature the dial fetches
// the ECH config synchronously and retries with ECH. cfg may be nil when no
// config exists yet; the dialer's defaults then apply.
func enableOneShotECH(cfg *config.Config) {
	if cfg != nil {
		ech.Configure(cfg.ECH, cfg.ECHServerEnabled)
	}
	ech.Shared().SetOneShot(true)
}
