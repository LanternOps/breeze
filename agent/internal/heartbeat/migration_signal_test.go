package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/hostpolicy"
)

func TestMigrationSignal(t *testing.T) {
	// Self-host build: empty edition (omitempty drops it from the wire
	// payload, keeping byte-identity with pre-Task-8 agents), never
	// migration-needed.
	if e, m := migrationSignal("https://anything.example"); e != "" || m {
		t.Fatalf("self-host: want (\"\",false), got (%s,%v)", e, m)
	}

	restore := hostpolicy.SetAllowedHostsForTest("hosted-a.example")
	defer restore()

	// Hosted build on an allowlisted server: edition hosted, no migration.
	if e, m := migrationSignal("https://hosted-a.example"); e != "hosted" || m {
		t.Fatalf("hosted allowlisted: want (hosted,false), got (%s,%v)", e, m)
	}
	// Hosted build on a non-allowlisted (self-hosted) server: migration needed.
	if e, m := migrationSignal("https://selfhosted.example"); e != "hosted" || !m {
		t.Fatalf("hosted non-allowlisted: want (hosted,true), got (%s,%v)", e, m)
	}
}
