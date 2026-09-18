package userhelper

import (
	"fmt"
	"strconv"
	"sync"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// SEC-038 W05 — the helper half of the remote-desktop start fence.
//
// The service already refuses a start that is not strictly newer than
// everything it has seen, and refuses every start after a terminal. The helper
// is where capture actually runs, and it is a separate process with its own
// lifetime: it can restart mid-session and be handed a start the service has
// long since superseded, or one whose stop it processed before crashing. So it
// keeps the same fence, seeded from the service on connect
// (ipc.TypeDesktopFenceSync) and maintained from the starts and stops it sees.
//
// Two different quantities, deliberately separate (they are NOT the same
// number and conflating them refuses legitimate starts):
//
//   - floor — the service's high-water mark, learned from a sync. A LOWER
//     BOUND. The service consumes generation G before the helper that will run
//     it even exists, so a freshly spawned helper is told floor=G and must
//     then admit the start AT G.
//   - consumed — generations this helper has itself admitted. A start strictly
//     below the newest of these is a replay. An EQUAL one is not: the service
//     retries a failed start with the same generation, and the IPC correlation
//     id differs per attempt, so the generation is all the helper has to
//     recognise a retry by.
//
// The tombstone is absolute, as on the service side: it refuses generationless
// starts too, because "this session is over" does not depend on a comparison.
type helperDesktopFence struct {
	mu      sync.Mutex
	entries map[string]helperFenceEntry
}

type helperFenceEntry struct {
	floor        int64
	hasFloor     bool
	consumed     int64
	hasConsumed  bool
	terminal     bool
	tombstonedBy string // the terminal generation, for logs; "" when unknown
}

type helperFenceDecision struct {
	admitted bool
	reason   string
}

// admitStart decides whether a start may run and records its generation in the
// same critical section, so two concurrent IPC deliveries cannot both claim it.
func (f *helperDesktopFence) admitStart(sessionID, generation string) helperFenceDecision {
	f.mu.Lock()
	defer f.mu.Unlock()

	entry := f.entries[sessionID]
	if entry.terminal {
		return helperFenceDecision{reason: "session is terminal"}
	}
	if generation == "" {
		// Older service: nothing to order against. Admitted, and the fence
		// records nothing so a real generation still lands later.
		return helperFenceDecision{admitted: true}
	}

	gen, err := parseHelperGeneration(generation)
	if err != nil {
		// Fail closed: a generation we cannot compare is one we cannot honour.
		return helperFenceDecision{reason: err.Error()}
	}
	if entry.hasFloor && gen < entry.floor {
		return helperFenceDecision{reason: fmt.Sprintf("generation %d is below the service high-water mark %d", gen, entry.floor)}
	}
	if entry.hasConsumed && gen < entry.consumed {
		return helperFenceDecision{reason: fmt.Sprintf("generation %d was superseded by %d", gen, entry.consumed)}
	}

	entry.consumed = gen
	entry.hasConsumed = true
	f.setLocked(sessionID, entry)
	return helperFenceDecision{admitted: true}
}

// noteStop installs the absolute tombstone — including for a session this
// helper never started, which is the reorder case.
func (f *helperDesktopFence) noteStop(sessionID, terminalGeneration string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	entry := f.entries[sessionID]
	entry.terminal = true
	if terminalGeneration != "" {
		entry.tombstonedBy = terminalGeneration
	}
	f.setLocked(sessionID, entry)
}

// applySync merges a fence snapshot from the service. Knowledge only ever
// grows: a floor is never lowered and a tombstone is never cleared, so a stale
// snapshot (a reconnect racing a stop) cannot reopen anything.
func (f *helperDesktopFence) applySync(sync ipc.DesktopFenceSync) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for id, in := range sync.Sessions {
		entry := f.entries[id]
		if in.Terminal {
			entry.terminal = true
		}
		if in.HighWater != "" {
			gen, err := parseHelperGeneration(in.HighWater)
			if err != nil {
				log.Warn("ignoring a malformed generation in a desktop fence sync",
					"sessionId", id, "highWater", in.HighWater)
			} else if !entry.hasFloor || gen > entry.floor {
				entry.floor = gen
				entry.hasFloor = true
			}
		}
		f.setLocked(id, entry)
	}
}

func (f *helperDesktopFence) setLocked(sessionID string, entry helperFenceEntry) {
	if f.entries == nil {
		f.entries = make(map[string]helperFenceEntry)
	}
	f.entries[sessionID] = entry
}

// parseHelperGeneration accepts only what the server emits: a canonical,
// non-negative decimal string. Accepting variants would let two spellings of
// one generation disagree between the service fence and this one.
func parseHelperGeneration(s string) (int64, error) {
	gen, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("startGeneration is not a canonical decimal string: %q", s)
	}
	if gen < 0 || strconv.FormatInt(gen, 10) != s {
		return 0, fmt.Errorf("startGeneration is not canonical decimal: %q", s)
	}
	return gen, nil
}
