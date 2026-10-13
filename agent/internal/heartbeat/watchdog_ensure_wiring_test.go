package heartbeat

import (
	"path/filepath"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// The production wiring must actually turn Ensure on for the installed agent;
// otherwise every Ensure test passes while the feature is dead in the field.
func TestEnableWatchdogEnsure_WiresByDefault(t *testing.T) {
	h := &Heartbeat{config: &config.Config{}}
	h.EnableWatchdogEnsure()
	e := h.watchdogEnsure
	if e == nil {
		t.Fatal("EnableWatchdogEnsure left Ensure unwired on the machine config")
	}
	if e.store.Dir != config.MachineConfigDir() {
		t.Fatalf("store dir %q want the machine config dir %q", e.store.Dir, config.MachineConfigDir())
	}
	if want := filepath.Join(config.GetDataDir(), watchdoginstall.StageRootName); e.stageRoot != want {
		t.Fatalf("stage root %q want %q", e.stageRoot, want)
	}
	if e.detect == nil || e.download == nil || e.verifySig == nil || e.register == nil ||
		e.waitRunning == nil || e.now == nil || e.rnd == nil {
		t.Fatal("a production seam is nil")
	}
	if e.plan != watchdoginstall.DefaultPlan {
		t.Fatal("production must use DefaultPlan")
	}
}
