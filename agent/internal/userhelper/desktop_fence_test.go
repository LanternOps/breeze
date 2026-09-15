package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// SEC-038 W05: the helper hosts the capture, so the fence has to hold there
// too — a helper that restarts must not replay a start the service has
// already superseded or tombstoned.

func TestHelperFenceAdmitsFirstGenerationAndRefusesOlder(t *testing.T) {
	var f helperDesktopFence
	if d := f.admitStart("s1", "5"); !d.admitted {
		t.Fatalf("first start must be admitted, got %#v", d)
	}
	if d := f.admitStart("s1", "4"); d.admitted {
		t.Fatal("a start below the consumed generation must be refused")
	}
	if d := f.admitStart("s1", "6"); !d.admitted {
		t.Fatalf("a newer start must be admitted, got %#v", d)
	}
}

// The service retries a failed start with the SAME generation (a new helper,
// a respawn). The IPC correlation id differs per attempt, so the generation is
// all the helper has — an equal generation must be admitted, not refused.
func TestHelperFenceAdmitsRetryAtTheSameGeneration(t *testing.T) {
	var f helperDesktopFence
	if d := f.admitStart("s1", "5"); !d.admitted {
		t.Fatalf("setup: %#v", d)
	}
	if d := f.admitStart("s1", "5"); !d.admitted {
		t.Fatalf("a retry of the same start must be admitted, got %#v", d)
	}
}

func TestHelperFenceStopTombstonesAbsolutely(t *testing.T) {
	var f helperDesktopFence
	f.noteStop("s1", "7")
	for _, gen := range []string{"6", "7", "8", ""} {
		if d := f.admitStart("s1", gen); d.admitted {
			t.Fatalf("generation %q after a tombstone must be refused", gen)
		}
	}
}

// A stop for a session the helper never started still tombstones it — the
// reorder case, same as the service side.
func TestHelperFenceStopBeforeStartTombstonesUnknownSession(t *testing.T) {
	var f helperDesktopFence
	f.noteStop("never-started", "")
	if d := f.admitStart("never-started", "1"); d.admitted {
		t.Fatal("a stop that overtook its start must still fence the start")
	}
}

// The floor the service seeds on connect is a LOWER BOUND, not a consumed
// generation: the service consumes G before the helper even exists, so the
// helper must admit the very start that floor came from.
func TestHelperFenceSyncFloorAdmitsTheStartItCameFrom(t *testing.T) {
	var f helperDesktopFence
	f.applySync(ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{
		"s1": {HighWater: "9"},
	}})
	if d := f.admitStart("s1", "8"); d.admitted {
		t.Fatal("a start below the service's high-water mark must be refused")
	}
	if d := f.admitStart("s1", "9"); !d.admitted {
		t.Fatalf("the start the floor came from must be admitted, got %#v", d)
	}
}

func TestHelperFenceSyncCarriesTombstones(t *testing.T) {
	var f helperDesktopFence
	f.applySync(ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{
		"s1": {HighWater: "3", Terminal: true},
	}})
	if d := f.admitStart("s1", "9"); d.admitted {
		t.Fatal("a tombstone from the service sync must refuse every later start")
	}
}

// A second sync merges: knowledge only ever grows, and a stale snapshot can
// never lower a floor or clear a tombstone.
func TestHelperFenceSyncMergesMonotonically(t *testing.T) {
	var f helperDesktopFence
	f.applySync(ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{
		"s1": {HighWater: "9", Terminal: true},
	}})
	f.applySync(ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{
		"s1": {HighWater: "2"},
	}})
	if d := f.admitStart("s1", "9"); d.admitted {
		t.Fatal("a later snapshot must not clear a tombstone")
	}

	var g helperDesktopFence
	g.applySync(ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{"s2": {HighWater: "9"}}})
	g.applySync(ipc.DesktopFenceSync{Sessions: map[string]ipc.DesktopFenceEntry{"s2": {HighWater: "2"}}})
	if d := g.admitStart("s2", "8"); d.admitted {
		t.Fatal("a later snapshot must not lower the floor")
	}
}

// Mixed fleet: an older service sends no generation. The helper admits the
// start (there is nothing to order it against) unless it is tombstoned — the
// same rule the agent-side fence applies, so an old agent with a new helper
// keeps working.
func TestHelperFenceAdmitsGenerationlessStart(t *testing.T) {
	var f helperDesktopFence
	if d := f.admitStart("s1", ""); !d.admitted {
		t.Fatalf("a generationless start must be admitted, got %#v", d)
	}
	// ...and it does not move the floor, so a real generation still lands.
	if d := f.admitStart("s1", "1"); !d.admitted {
		t.Fatalf("a generation after a generationless start must be admitted, got %#v", d)
	}
}

// Fail closed on anything we cannot compare. The service emits
// strconv.FormatInt; a non-canonical spelling means a bug or a tampered peer.
func TestHelperFenceRefusesMalformedGeneration(t *testing.T) {
	for _, gen := range []string{"nine", "-1", "007", "+7", " 7"} {
		var f helperDesktopFence
		if d := f.admitStart("s1", gen); d.admitted {
			t.Fatalf("generation %q must be refused as malformed", gen)
		}
	}
}

func TestValidateDesktopStartRequestRejectsMalformedGeneration(t *testing.T) {
	req := &ipc.DesktopStartRequest{
		SessionID:       "11111111-1111-4111-8111-111111111111",
		Offer:           "v=0",
		StartGeneration: "007",
		RevocationLease: &ipc.RevocationLease{
			Token:              "t",
			ExpiresAtUnixMs:    1,
			HardDeadlineUnixMs: 2,
			RenewEverySec:      25,
			GraceSec:           90,
		},
	}
	if err := validateDesktopStartRequest(req); err == nil {
		t.Fatal("a non-canonical startGeneration must be rejected")
	}
}
