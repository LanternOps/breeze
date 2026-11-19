package oemupdates

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/oemupdates/observe"
)

// TestObserveHPIAPathMatchesLane: oem_observe reports HPIA only where the HP
// lane installs and detects it, the agent-owned directory. observe may not
// import this package, so the shared location is pinned here: a change to the
// lane's directory that observe does not follow fails this test.
func TestObserveHPIAPathMatchesLane(t *testing.T) {
	if observe.HPIAStoreDir != storeDirName {
		t.Errorf("observe store dir %q, lane %q", observe.HPIAStoreDir, storeDirName)
	}
	if observe.HPIAToolDir != hpToolDirName {
		t.Errorf("observe tool dir %q, lane %q", observe.HPIAToolDir, hpToolDirName)
	}
	if observe.HPIAExe != hpToolExe {
		t.Errorf("observe exe %q, lane %q", observe.HPIAExe, hpToolExe)
	}
}
