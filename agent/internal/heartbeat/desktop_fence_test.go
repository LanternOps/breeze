package heartbeat

import (
	"sync"
	"testing"
)

// The fence is the endpoint half of SEC-038: the agent refuses any desktop
// start that is not strictly newer than everything it has already seen, and
// refuses every start after a terminal.

func TestDesktopFenceAdmitsFirstGeneration(t *testing.T) {
	var f desktopFence
	d := f.admitStart("s1", desktopStartFenceInput{Generation: 7, HasGeneration: true, CommandID: "c1"})
	if !d.Admitted {
		t.Fatalf("first generation must be admitted, got %#v", d)
	}
}

func TestDesktopFenceRefusesGenerationAtOrBelowHighWater(t *testing.T) {
	var f desktopFence
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 9, HasGeneration: true, CommandID: "c9"}); !d.Admitted {
		t.Fatalf("setup start refused: %#v", d)
	}
	for _, gen := range []int64{1, 8, 9} {
		d := f.admitStart("s1", desktopStartFenceInput{Generation: gen, HasGeneration: true, CommandID: "other"})
		if d.Admitted {
			t.Fatalf("generation %d <= high-water 9 must be refused", gen)
		}
		if d.Reason != desktopFenceReasonSuperseded {
			t.Fatalf("generation %d refused with reason %q, want %q", gen, d.Reason, desktopFenceReasonSuperseded)
		}
	}
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 10, HasGeneration: true, CommandID: "c10"}); !d.Admitted {
		t.Fatalf("generation 10 > high-water 9 must be admitted, got %#v", d)
	}
}

// #3107: one start_desktop delivered over both the WebSocket and the heartbeat
// response arrives twice with the SAME command id and generation. That must
// still reach joinOrRunDesktopStart, not be refused as a replay.
func TestDesktopFenceIdenticalCommandIDAndGenerationRejoins(t *testing.T) {
	var f desktopFence
	in := desktopStartFenceInput{Generation: 4, HasGeneration: true, CommandID: "cmd-a"}
	if d := f.admitStart("s1", in); !d.Admitted {
		t.Fatalf("leader refused: %#v", d)
	}
	if d := f.admitStart("s1", in); !d.Admitted {
		t.Fatalf("duplicate delivery of the same command must rejoin, got %#v", d)
	}
	// A DIFFERENT command reusing the same generation is a replay, not a join.
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 4, HasGeneration: true, CommandID: "cmd-b"}); d.Admitted {
		t.Fatal("a different command id at the same generation must be refused")
	}
}

func TestDesktopFenceAdmitsStartWithoutGeneration(t *testing.T) {
	var f desktopFence
	d := f.admitStart("s1", desktopStartFenceInput{CommandID: "c1"})
	if !d.Admitted {
		t.Fatalf("a start with no generation (old server) must be admitted, got %#v", d)
	}
	// ...and it must not move the high-water mark, so a real generation still lands.
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 1, HasGeneration: true, CommandID: "c2"}); !d.Admitted {
		t.Fatalf("generation 1 after a generationless start must be admitted, got %#v", d)
	}
}

// The actual fix for the reorder case: a stop that arrives for a session the
// agent never started still installs an absolute tombstone.
func TestDesktopFenceStopBeforeStartTombstonesUnknownSession(t *testing.T) {
	var f desktopFence
	f.noteStop("s1", desktopStopFenceInput{Generation: 5, HasGeneration: true})

	for _, gen := range []int64{6, 99} {
		d := f.admitStart("s1", desktopStartFenceInput{Generation: gen, HasGeneration: true, CommandID: "c"})
		if d.Admitted {
			t.Fatalf("start at generation %d after a tombstone must be refused", gen)
		}
		if d.Reason != desktopFenceReasonTerminal {
			t.Fatalf("reason %q, want %q", d.Reason, desktopFenceReasonTerminal)
		}
	}
	// A generationless start (old server) must ALSO be refused once terminal —
	// the tombstone is absolute, it is not a generation comparison.
	if d := f.admitStart("s1", desktopStartFenceInput{CommandID: "c"}); d.Admitted {
		t.Fatal("a generationless start after a tombstone must be refused")
	}
}

// A stop carrying no generation still tombstones (old server, or the W03
// terminal contract not yet deployed).
func TestDesktopFenceStopWithoutGenerationStillTombstones(t *testing.T) {
	var f desktopFence
	f.noteStop("s1", desktopStopFenceInput{})
	if d := f.admitStart("s1", desktopStartFenceInput{Generation: 3, HasGeneration: true, CommandID: "c"}); d.Admitted {
		t.Fatal("a generationless stop must still tombstone the session")
	}
}

func TestDesktopFenceTombstoneIsPerSession(t *testing.T) {
	var f desktopFence
	f.noteStop("s1", desktopStopFenceInput{})
	if d := f.admitStart("s2", desktopStartFenceInput{Generation: 1, HasGeneration: true, CommandID: "c"}); !d.Admitted {
		t.Fatalf("tombstoning s1 must not fence s2, got %#v", d)
	}
}

// Start-then-stop (the ordinary case) and stop-then-start (the reorder case)
// must converge on the same endpoint state: refused.
func TestDesktopFenceReorderConvergesOnRefused(t *testing.T) {
	inOrder := &desktopFence{}
	if d := inOrder.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "start"}); !d.Admitted {
		t.Fatalf("in-order start refused: %#v", d)
	}
	inOrder.noteStop("s1", desktopStopFenceInput{Generation: 3, HasGeneration: true})

	reordered := &desktopFence{}
	reordered.noteStop("s1", desktopStopFenceInput{Generation: 3, HasGeneration: true})
	late := reordered.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "start"})
	if late.Admitted {
		t.Fatal("a start that lost the wire race must be refused when it finally lands")
	}

	replay := inOrder.admitStart("s1", desktopStartFenceInput{Generation: 2, HasGeneration: true, CommandID: "start"})
	if replay.Admitted {
		t.Fatal("a redelivered start after the stop must be refused")
	}
}

// The high-water mark never rolls back, under concurrency.
func TestDesktopFenceHighWaterNeverRollsBackUnderRace(t *testing.T) {
	var f desktopFence
	var wg sync.WaitGroup
	for i := 0; i < 64; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			f.admitStart("s1", desktopStartFenceInput{
				Generation:    int64(i + 1),
				HasGeneration: true,
				CommandID:     "c",
			})
		}(i)
	}
	wg.Wait()

	// Whatever interleaving happened, nothing at or below the final high-water
	// mark may be admitted afterwards.
	for gen := int64(1); gen <= 64; gen++ {
		if d := f.admitStart("s1", desktopStartFenceInput{Generation: gen, HasGeneration: true, CommandID: "late"}); d.Admitted {
			t.Fatalf("generation %d admitted after 64 concurrent starts; high-water rolled back", gen)
		}
	}
}

func TestParseDesktopStartGeneration(t *testing.T) {
	tests := []struct {
		name    string
		payload map[string]any
		want    desktopStartFenceInput
		wantErr bool
	}{
		{
			name:    "absent",
			payload: map[string]any{},
			want:    desktopStartFenceInput{},
		},
		{
			name:    "canonical decimal string",
			payload: map[string]any{"startGeneration": "9007199254740993"},
			want:    desktopStartFenceInput{Generation: 9007199254740993, HasGeneration: true},
		},
		{
			name:    "empty string is absent",
			payload: map[string]any{"startGeneration": ""},
			want:    desktopStartFenceInput{},
		},
		{
			name:    "non-numeric string is malformed",
			payload: map[string]any{"startGeneration": "nine"},
			wantErr: true,
		},
		{
			name:    "number is malformed: generations never pass through a float",
			payload: map[string]any{"startGeneration": float64(9)},
			wantErr: true,
		},
		{
			name:    "negative is malformed",
			payload: map[string]any{"startGeneration": "-1"},
			wantErr: true,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseDesktopStartGeneration(tc.payload)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error, got %#v", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got.Generation != tc.want.Generation || got.HasGeneration != tc.want.HasGeneration {
				t.Fatalf("got %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestParseDesktopTerminalGeneration(t *testing.T) {
	got, err := parseDesktopTerminalGeneration(map[string]any{"terminalGeneration": "12"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !got.HasGeneration || got.Generation != 12 {
		t.Fatalf("got %#v, want generation 12", got)
	}
	// A malformed terminal generation must NOT stop the tombstone from being
	// installed — see handleStopDesktop. It is still reported as malformed.
	if _, err := parseDesktopTerminalGeneration(map[string]any{"terminalGeneration": float64(12)}); err == nil {
		t.Fatal("a numeric terminalGeneration must be reported as malformed")
	}
}
