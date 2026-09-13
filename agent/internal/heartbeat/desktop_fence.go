package heartbeat

import (
	"fmt"
	"strconv"
	"sync"
)

// SEC-038 — the endpoint half of the remote-desktop start fence.
//
// The server bumps one monotonic generation on the remote_sessions row for
// BOTH the start-intent commit and the terminal-intent commit, and carries it
// in the start_desktop / stop_desktop payloads. That narrows the window in
// which a start already superseded by an End can still reach the wire, but it
// cannot close it: the two commands can be reordered in flight, so a
// stop_desktop can arrive at the agent BEFORE the start it was meant to
// cancel. Closing it is the endpoint's job, and this is that endpoint:
//
//	the agent refuses any start not strictly newer than everything it has
//	already seen, and refuses ALL starts after a terminal.
//
// Two properties carry the fix:
//
//   - The high-water mark makes a redelivered or superseded start inert.
//   - The tombstone is installed by a stop EVEN WHEN NO SESSION IS RUNNING.
//     Before this, an unknown-session stop was a no-op, so a start that lost
//     the wire race simply ran when it finally landed. That one line is the
//     actual fix for the reorder case.
//
// Compatibility: a start carrying NO generation is admitted, so agents can
// roll ahead of the API in a mixed fleet (global constraint: API first, agents
// second, gate last). Such a start does not move the high-water mark. A
// tombstone, however, is absolute — it refuses generationless starts too,
// because "this session is over" does not depend on a generation comparison.
//
// W04 keeps this fence in memory only. W05 makes it durable across an agent
// restart and extends it to the user helper over IPC.

// desktopFenceReason identifies why the fence refused a start. It is surfaced
// in the command result so the server-side audit can tell a superseded start
// apart from one that landed after a terminal.
type desktopFenceReason string

const (
	// desktopFenceReasonSuperseded — a newer start generation (or a terminal)
	// was already seen for this session.
	desktopFenceReasonSuperseded desktopFenceReason = "superseded"
	// desktopFenceReasonTerminal — this session has been declared terminal;
	// no start will ever be admitted for it again.
	desktopFenceReasonTerminal desktopFenceReason = "terminal"
	// desktopFenceReasonMalformed — the payload carried a generation field
	// that is not a canonical decimal string. Fail closed: a generation we
	// cannot compare is a generation we cannot honour.
	desktopFenceReasonMalformed desktopFenceReason = "malformed"
)

// desktopStartFenceInput is the fence-relevant part of a start_desktop payload.
type desktopStartFenceInput struct {
	// Generation is the server's monotonic desktop_start_generation for this
	// start. Only meaningful when HasGeneration is true.
	Generation int64
	// HasGeneration is false for an old server that sends no generation.
	HasGeneration bool
	// CommandID is the device command id. A repeat delivery of the SAME
	// command at the SAME generation is the #3107 dual-delivery case and must
	// be allowed through to joinOrRunDesktopStart, which collapses it.
	CommandID string
}

// desktopStopFenceInput is the fence-relevant part of a stop_desktop payload.
type desktopStopFenceInput struct {
	// Generation is the server's terminal_generation. Absent on an old server
	// (or before the W03 terminal contract ships); the tombstone is installed
	// either way.
	Generation    int64
	HasGeneration bool
}

// desktopFenceDecision is the fence's verdict on one start.
type desktopFenceDecision struct {
	Admitted bool
	Reason   desktopFenceReason
	// HighWater is the high-water generation in force when the decision was
	// taken, for logging.
	HighWater int64
}

type desktopFenceEntry struct {
	highWater int64
	// highWaterCommandID is the command that claimed highWater, so a duplicate
	// delivery of that exact command rejoins rather than being refused.
	highWaterCommandID string
	// hasHighWater distinguishes "generation 0 seen" from "nothing seen".
	hasHighWater bool
	terminal     bool
}

// desktopFence is the per-session fence. Its zero value is ready to use, so a
// Heartbeat built as a bare composite literal (as many tests do) is fenced
// without any construction step.
//
// Entries are deliberately never pruned in W04. A tombstone that can be
// forgotten is not a tombstone, and there is no safe local signal for "this
// session will never be started again" — only the server has it
// (termination_phase = 'confirmed'). Growth is bounded by legitimate connect
// attempts between agent restarts (~100 bytes per session id), so the cost is
// small and the failure mode of being wrong is a revived session. Eviction
// belongs with W05, where the durable store lands and the confirmed-teardown
// phase becomes visible to the agent.
type desktopFence struct {
	mu      sync.Mutex
	entries map[string]desktopFenceEntry
}

// admitStart decides whether a start_desktop may run, and — when it may —
// records its generation as the new high-water mark in the same critical
// section, so two concurrent deliveries cannot both claim it.
func (f *desktopFence) admitStart(sessionID string, in desktopStartFenceInput) desktopFenceDecision {
	f.mu.Lock()
	defer f.mu.Unlock()

	entry := f.entries[sessionID]

	// The tombstone is absolute and is checked first: once a session is
	// terminal, no start is admitted for it again, generation or not.
	if entry.terminal {
		return desktopFenceDecision{Reason: desktopFenceReasonTerminal, HighWater: entry.highWater}
	}

	// Old server: no generation to compare. Admit, and leave the high-water
	// mark untouched so a later real generation still lands.
	if !in.HasGeneration {
		return desktopFenceDecision{Admitted: true, HighWater: entry.highWater}
	}

	if !entry.hasHighWater || in.Generation > entry.highWater {
		f.setEntryLocked(sessionID, desktopFenceEntry{
			highWater:          in.Generation,
			highWaterCommandID: in.CommandID,
			hasHighWater:       true,
			terminal:           entry.terminal,
		})
		return desktopFenceDecision{Admitted: true, HighWater: in.Generation}
	}

	// Same generation, same command: the one start that reached us over both
	// the WebSocket and the heartbeat response (#3107). Let it through to
	// joinOrRunDesktopStart, which collapses the two onto one helper
	// round-trip. The high-water mark is already at this generation, so
	// nothing to record.
	if in.Generation == entry.highWater && in.CommandID != "" && in.CommandID == entry.highWaterCommandID {
		return desktopFenceDecision{Admitted: true, HighWater: entry.highWater}
	}

	return desktopFenceDecision{Reason: desktopFenceReasonSuperseded, HighWater: entry.highWater}
}

// noteStop installs the absolute terminal tombstone for a session — even when
// no session is running under that id. That is the reorder fix: a stop that
// overtakes its start must still fence the start.
func (f *desktopFence) noteStop(sessionID string, in desktopStopFenceInput) {
	f.mu.Lock()
	defer f.mu.Unlock()

	entry := f.entries[sessionID]
	entry.terminal = true
	// Carry the terminal generation into the high-water mark when it is newer.
	// The mark only ever moves forward.
	if in.HasGeneration && (!entry.hasHighWater || in.Generation > entry.highWater) {
		entry.highWater = in.Generation
		entry.hasHighWater = true
		entry.highWaterCommandID = ""
	}
	f.setEntryLocked(sessionID, entry)
}

// desktopStartFenceError builds the failure the agent reports for a refused
// start. The reason is named in the text so the server-side audit can tell a
// superseded start apart from one that landed after a terminal without parsing
// free-form prose.
func desktopStartFenceError(reason desktopFenceReason, detail string) error {
	if detail != "" {
		return fmt.Errorf("start_desktop refused by the desktop start fence (%s): %s", reason, detail)
	}
	return fmt.Errorf("start_desktop refused by the desktop start fence (%s)", reason)
}

func (f *desktopFence) setEntryLocked(sessionID string, entry desktopFenceEntry) {
	if f.entries == nil {
		f.entries = make(map[string]desktopFenceEntry)
	}
	f.entries[sessionID] = entry
}

// parseDesktopStartGeneration decodes `startGeneration` from a start_desktop
// payload.
//
// Generations are bigint on the server and MUST NOT pass through a JavaScript
// Number or a Go float64 — above 2^53 that silently rounds — so the wire
// encoding is a canonical decimal string on every hop and anything else
// (including a JSON number) is rejected as malformed rather than coerced.
func parseDesktopStartGeneration(payload map[string]any) (desktopStartFenceInput, error) {
	gen, has, err := parseDesktopGenerationField(payload, "startGeneration")
	if err != nil {
		return desktopStartFenceInput{}, err
	}
	return desktopStartFenceInput{Generation: gen, HasGeneration: has}, nil
}

// parseDesktopTerminalGeneration decodes `terminalGeneration` from a
// stop_desktop payload. Same encoding rule as the start generation.
func parseDesktopTerminalGeneration(payload map[string]any) (desktopStopFenceInput, error) {
	gen, has, err := parseDesktopGenerationField(payload, "terminalGeneration")
	if err != nil {
		return desktopStopFenceInput{}, err
	}
	return desktopStopFenceInput{Generation: gen, HasGeneration: has}, nil
}

func parseDesktopGenerationField(payload map[string]any, field string) (int64, bool, error) {
	raw, present := payload[field]
	if !present || raw == nil {
		return 0, false, nil
	}
	s, ok := raw.(string)
	if !ok {
		return 0, false, fmt.Errorf("%s must be a canonical decimal string, got %T", field, raw)
	}
	if s == "" {
		return 0, false, nil
	}
	gen, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		return 0, false, fmt.Errorf("%s is not a canonical decimal string: %w", field, err)
	}
	if gen < 0 {
		return 0, false, fmt.Errorf("%s must not be negative, got %d", field, gen)
	}
	// Reject non-canonical spellings ("007", "+7"): the server emits exactly
	// strconv.FormatInt, and accepting variants here would let two spellings
	// of one generation disagree with a durable fence in W05.
	if strconv.FormatInt(gen, 10) != s {
		return 0, false, fmt.Errorf("%s is not canonical decimal: %q", field, s)
	}
	return gen, true, nil
}
