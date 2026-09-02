package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

func TestMigrationSignal(t *testing.T) {
	// Self-host build: reports its edition explicitly (#4072 — the server
	// withholds hosted-edition update offers from agents that never report an
	// edition, because a silent self-host build ≥0.105.0 would hard-refuse
	// them; reporting "self-host" marks this build as transition-capable),
	// never migration-needed.
	if e, m := migrationSignal("https://anything.example", ""); e != "self-host" || m {
		t.Fatalf("self-host: want (\"self-host\",false), got (%s,%v)", e, m)
	}

	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	// Hosted build on an allowlisted server, no backup: edition hosted, no migration.
	if e, m := migrationSignal("https://hosted-a.example", ""); e != "hosted" || m {
		t.Fatalf("hosted allowlisted, no backup: want (hosted,false), got (%s,%v)", e, m)
	}
	// Hosted build on an allowlisted primary AND an allowlisted backup: no migration.
	if e, m := migrationSignal("https://hosted-a.example", "https://hosted-a.example"); e != "hosted" || m {
		t.Fatalf("hosted allowlisted primary+backup: want (hosted,false), got (%s,%v)", e, m)
	}
	// Hosted build on a non-allowlisted (self-hosted) server: migration needed.
	if e, m := migrationSignal("https://selfhosted.example", ""); e != "hosted" || !m {
		t.Fatalf("hosted non-allowlisted: want (hosted,true), got (%s,%v)", e, m)
	}
}

// TestMigrationSignal_DivergentBackup is the regression guard for the gap
// migrationSignal used to have: a hosted build with an allowlisted primary
// but a non-allowlisted persisted backup emitted no migration signal at all,
// because the function only ever inspected the primary. A hosted-gap build
// running against such a fleet would never surface the dashboard migration
// banner.
func TestMigrationSignal_DivergentBackup(t *testing.T) {
	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	// Primary allowlisted, backup NOT allowlisted: migration needed.
	if e, m := migrationSignal("https://hosted-a.example", "https://selfhosted.example"); e != "hosted" || !m {
		t.Fatalf("allowlisted primary + non-allowlisted backup: want (hosted,true), got (%s,%v)", e, m)
	}
	// Both non-allowlisted: still migration needed (primary alone already
	// triggers it — this just confirms the backup check doesn't mask that).
	if e, m := migrationSignal("https://selfhosted.example", "https://also-selfhosted.example"); e != "hosted" || !m {
		t.Fatalf("non-allowlisted primary + backup: want (hosted,true), got (%s,%v)", e, m)
	}
	// Empty backup must never itself trigger a signal (nothing persisted to violate).
	if e, m := migrationSignal("https://hosted-a.example", ""); e != "hosted" || m {
		t.Fatalf("allowlisted primary + empty backup: want (hosted,false), got (%s,%v)", e, m)
	}
}
