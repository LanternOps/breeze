package heartbeat

import (
	"errors"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/health"
	"github.com/breeze-rmm/agent/internal/macrelocate"
)

type fakeRelocationProbe struct {
	rec      *macrelocate.Record
	readErr  error
	fda      bool
	cleared  int
	fdaCalls int
}

func (f *fakeRelocationProbe) probe() relocationFDAProbe {
	return relocationFDAProbe{
		read: func() (*macrelocate.Record, error) { return f.rec, f.readErr },
		fda: func() bool {
			f.fdaCalls++
			return f.fda
		},
		clear: func() error {
			f.cleared++
			f.rec = nil
			return nil
		},
	}
}

var testRecord = &macrelocate.Record{
	From: "/usr/local/bin/breeze-agent",
	To:   "/Library/Breeze/bin/breeze-agent",
}

func TestRelocationFDAHealthAbsentWithoutRecord(t *testing.T) {
	mon := health.NewMonitor()
	f := &fakeRelocationProbe{}
	updateRelocationFDAHealth(mon, f.probe())
	if _, ok := mon.Get(macrelocate.HealthComponent); ok {
		t.Fatal("no relocation record: the component must not be reported at all")
	}
	if f.fdaCalls != 0 {
		t.Fatal("FDA must not be probed without a relocation record")
	}
}

// TestRelocationFDAHealthWarnsUntilRegranted is the device-visible half of
// #7211: after a relocation the agent reports a warning that names the new
// path until Full Disk Access is granted to it.
func TestRelocationFDAHealthWarnsUntilRegranted(t *testing.T) {
	mon := health.NewMonitor()
	f := &fakeRelocationProbe{rec: testRecord}
	updateRelocationFDAHealth(mon, f.probe())

	c, ok := mon.Get(macrelocate.HealthComponent)
	if !ok {
		t.Fatal("want the relocation component reported")
	}
	if c.Status != health.Degraded {
		t.Fatalf("status = %q, want degraded", c.Status)
	}
	if !strings.Contains(c.Message, "/Library/Breeze/bin/breeze-agent") || !strings.Contains(c.Message, "Full Disk Access") {
		t.Fatalf("message = %q", c.Message)
	}
	if f.cleared != 0 {
		t.Fatal("record must be kept while FDA is still missing")
	}
	snap := mon.Snapshot(health.SnapshotMetadata{AgentVersion: "test"})
	if snap.Components[macrelocate.HealthComponent].State != health.AgentHealthWarning {
		t.Fatalf("wire state = %q, want warning", snap.Components[macrelocate.HealthComponent].State)
	}

	// Operator re-grants FDA: the next beat reports healthy and drops the record.
	f.fda = true
	updateRelocationFDAHealth(mon, f.probe())
	c, _ = mon.Get(macrelocate.HealthComponent)
	if c.Status != health.Healthy || c.Message != "" {
		t.Fatalf("after re-grant: %+v, want healthy with no message", c)
	}
	if f.cleared != 1 {
		t.Fatalf("cleared = %d, want 1", f.cleared)
	}
}

func TestRelocationFDAHealthUnreadableRecordIsCleared(t *testing.T) {
	mon := health.NewMonitor()
	f := &fakeRelocationProbe{readErr: errors.New("parse executable-relocation.json: bad json")}
	updateRelocationFDAHealth(mon, f.probe())
	if _, ok := mon.Get(macrelocate.HealthComponent); ok {
		t.Fatal("an unreadable record must not produce a component")
	}
	if f.cleared != 1 {
		t.Fatalf("cleared = %d, want the corrupt record removed", f.cleared)
	}
}
