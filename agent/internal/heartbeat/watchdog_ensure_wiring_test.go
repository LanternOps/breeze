package heartbeat

import (
	"os"
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

// #8672: the production wiring must seed the report from persisted state, or
// the first heartbeat after a restart omits it and the API clears the banner.
func TestEnableWatchdogEnsure_SeedsPersistedReport(t *testing.T) {
	if s := watchdoginstall.Detect(os.Stat); s != watchdoginstall.StatusMissing {
		t.Skipf("host watchdog status is %v, not missing; the production detect seam cannot be faked here", s)
	}
	dir := t.TempDir()
	t.Cleanup(config.SetConfigDirForTest(dir))
	if err := (watchdoginstall.Store{Dir: dir}).Save(watchdoginstall.Record{
		BudgetVersion: "1.2.3",
		Attempts:      3,
		LastClass:     watchdoginstall.ClassNetwork,
	}); err != nil {
		t.Fatal(err)
	}
	h := &Heartbeat{config: &config.Config{AutoUpdate: true}, agentVersion: "1.2.3"}
	h.EnableWatchdogEnsure()
	r := h.watchdogInstallReport()
	if r == nil || r.State != "retrying" || r.Attempts != 3 || r.LastErrorClass != "network" {
		t.Fatalf("first report after EnableWatchdogEnsure = %+v; want the persisted retrying record", r)
	}
}
