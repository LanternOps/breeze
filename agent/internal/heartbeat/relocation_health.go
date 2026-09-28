package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/macrelocate"
	"github.com/breeze-rmm/agent/internal/tcc"
)

// relocationFDAProbe is the I/O updateRelocationFDAHealth needs, injected so
// the reporting logic is testable on every platform.
type relocationFDAProbe struct {
	read  func() (*macrelocate.Record, error)
	fda   func() bool
	clear func() error
}

func defaultRelocationFDAProbe() relocationFDAProbe {
	dir := config.ConfigDir()
	return relocationFDAProbe{
		read:  func() (*macrelocate.Record, error) { return macrelocate.ReadRecord(dir) },
		fda:   tcc.CheckFDA,
		clear: func() error { return macrelocate.ClearRecord(dir) },
	}
}

// updateRelocationFDAHealth reports, through the agent self-health
// components the heartbeat already sends, that the macOS agent binary was
// relocated and has not had Full Disk Access re-granted for its new path
// (#7211). The record is written by internal/macrelocate when it cleans up
// after a relocation; it is dropped once the daemon's own FDA probe passes.
// Called only on darwin.
func updateRelocationFDAHealth(mon *health.Monitor, p relocationFDAProbe) {
	rec, err := p.read()
	if err != nil {
		log.Warn("relocation record unreadable; discarding it", "error", err.Error())
		if clearErr := p.clear(); clearErr != nil {
			log.Warn("could not remove unreadable relocation record", "error", clearErr.Error())
		}
		return
	}
	if rec == nil {
		return
	}
	if p.fda() {
		if err := p.clear(); err != nil {
			log.Warn("could not remove relocation record after Full Disk Access was granted", "error", err.Error())
		}
		log.Info("Full Disk Access is granted for the relocated agent binary", "path", rec.To)
		updateHealthIfChanged(mon, macrelocate.HealthComponent, health.Healthy, "")
		return
	}
	updateHealthIfChanged(mon, macrelocate.HealthComponent, health.Degraded, macrelocate.FDAGuidance(*rec))
}

// updateHealthIfChanged avoids re-logging an unchanged degraded component
// on every heartbeat (Monitor.Update warns on each non-healthy update).
func updateHealthIfChanged(mon *health.Monitor, name string, status health.Status, message string) {
	if c, ok := mon.Get(name); ok && c.Status == status && c.Message == message {
		return
	}
	mon.Update(name, status, message)
}
