package watchdog

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// TestStandbyGraceDefaultMatchesConfigDefault pins the duplicated default.
//
// internal/config cannot import this package (watchdog already imports config
// for the net cache — that would be an import cycle), so DefaultStandbyGrace
// is spelled out again in config.Default(). This test is what keeps the
// two in step. A drift is not cosmetic: the watchdog would tolerate a stopped
// agent for a different length of time than the shipped config documents,
// which is the class of gap #5252 was.
func TestStandbyGraceDefaultMatchesConfigDefault(t *testing.T) {
	if got := config.Default().Watchdog.StandbyGrace; got != DefaultStandbyGrace {
		t.Errorf("config.Default().Watchdog.StandbyGrace = %s, want DefaultStandbyGrace (%s)",
			got, DefaultStandbyGrace)
	}
}

// TestStandbyGraceIsWellBelowStandbyTimeout — the point of #5252 is that an
// ordinary graceful stop no longer waits out the 30-minute ceiling. If the
// grace period ever grew to meet the ceiling the stranding window would be
// back, with nothing else failing.
func TestStandbyGraceIsWellBelowStandbyTimeout(t *testing.T) {
	wd := config.Default().Watchdog
	if wd.StandbyGrace <= 0 {
		t.Fatalf("StandbyGrace must be positive, got %s", wd.StandbyGrace)
	}
	if wd.StandbyGrace >= wd.StandbyTimeout {
		t.Errorf("StandbyGrace (%s) must be shorter than StandbyTimeout (%s)", wd.StandbyGrace, wd.StandbyTimeout)
	}
}
