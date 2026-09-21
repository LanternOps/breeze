package heartbeat

import (
	"fmt"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/desktopfence"
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
// W05 makes the fence durable (desktopfence.Store, atomic-write state file
// under the agent data dir) and adds sync-on-unknown: a start carrying a
// generation for a session the fence has NO record of — fresh install, lost or
// corrupt state file, evicted entry — is not admitted on the strength of the
// payload alone. The caller first asks the control plane to echo the session's
// current generation and phase (a plain revocation_lease_renew, whose answer
// already flows) and only a start at or above that echoed generation, on a
// non-terminal session, is admitted. Missing state therefore fails closed
// until resync, and forgetting an entry is always safe — which is what makes
// the entry cap below sound.

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
	// desktopFenceReasonUnsynced — the fence has no durable record for this
	// session and the control plane has not (yet) echoed its generation, so
	// the start cannot be ordered against anything. Refused until a sync.
	desktopFenceReasonUnsynced desktopFenceReason = "unsynced"
	// desktopFenceReasonPersistFailed — the start was admissible but its
	// fence record could not be written. A fence that only exists in memory
	// is not the durable fence this wave promises, so the start is refused;
	// the in-memory high-water mark still advances (it never rolls back).
	desktopFenceReasonPersistFailed desktopFenceReason = "persist_failed"
)

// maxDesktopFenceEntries caps the persisted fence. Beyond it the oldest
// NON-terminal entries (by last update) are evicted first — an evicted
// session is "unknown" again and unknown means sync-on-unknown, never
// admission. Tombstones are evicted only once older than
// desktopFenceTombstoneRetention, because a generationless start from an old
// server bypasses the sync and only the tombstone itself can refuse it.
const maxDesktopFenceEntries = 1024

// desktopFenceTombstoneRetention is how long an evictable tombstone is kept
// past the cap. No command survives on the server anywhere near this long
// (the connecting-session reaper runs at minutes), so a start for a session
// ended a week ago cannot be delivered any more.
const desktopFenceTombstoneRetention = 7 * 24 * time.Hour

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

// desktopFenceSyncInput is what a lease-renew answer tells the fence about a
// session: the server's current generation (absent on an old API) and whether
// the session is terminal (a revoked answer, or a non-'none' termination
// phase).
type desktopFenceSyncInput struct {
	Generation    int64
	HasGeneration bool
	Terminal      bool
	// Nonce is the syncNonce the control plane echoed from the renew that
	// produced this answer. Empty on an old API and on the watchdog's own
	// renewals (which send none). A waiter registered with a nonce is only
	// satisfied by an answer carrying that nonce or none at all, so a stalled
	// earlier answer cannot certify a later sync.
	Nonce string
}

// desktopFenceSyncOutcome is what a waiter on subscribeSync is woken with.
type desktopFenceSyncOutcome int

const (
	// desktopFenceSyncSynced — an answer was applied; re-run admitStart.
	desktopFenceSyncSynced desktopFenceSyncOutcome = iota + 1
	// desktopFenceSyncUnavailable — the control plane could not answer; the
	// session stays unsynced and the start must be refused.
	desktopFenceSyncUnavailable
)

// desktopFenceDecision is the fence's verdict on one start.
type desktopFenceDecision struct {
	Admitted bool
	Reason   desktopFenceReason
	// NeedsSync is set with Reason == desktopFenceReasonUnsynced: the caller
	// should sync the session with the control plane and ask again.
	NeedsSync bool
	// HighWater is the high-water generation in force when the decision was
	// taken, for logging.
	HighWater int64
}

// desktopFenceEntry is the in-memory form of desktopfence.Entry.
type desktopFenceEntry = desktopfence.Entry

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
	// persist writes the whole fence; nil (bare literal, tests) keeps the
	// fence in memory only. Installed by attachStore.
	persist func(desktopfence.State) error
	// now is the eviction clock; nil means time.Now.
	now func() time.Time
	// waiters are callers blocked in the sync-on-unknown round trip, keyed by
	// session id, woken by noteSync / noteStop / noteSyncUnavailable.
	waiters map[string][]desktopFenceWaiter
}

type desktopFenceWaiter struct {
	nonce string
	ch    chan desktopFenceSyncOutcome
}

// attachStore loads the durable fence from store and routes every later
// mutation through it. A corrupt file is quarantined by the store and the
// fence starts empty — which is safe, because empty means every session is
// unknown and unknown means sync-on-unknown.
func (f *desktopFence) attachStore(store *desktopfence.Store) {
	if store == nil {
		return
	}
	state, err := store.Load()
	if err != nil {
		log.Warn("desktop fence state could not be loaded; starting empty and requiring a control-plane sync per session",
			"path", store.Path(), "error", err.Error())
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.entries = make(map[string]desktopFenceEntry, len(state.Sessions))
	for id, e := range state.Sessions {
		// Belt and braces: the store never writes these, and a restart must
		// neither rejoin a call that died with the old process nor trust a
		// sync that process performed.
		e.HighWaterCommandID = ""
		e.Synced = false
		f.entries[id] = e
	}
	f.persist = store.Save
}

func (f *desktopFence) clock() time.Time {
	if f.now != nil {
		return f.now()
	}
	return time.Now()
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
	if entry.Terminal {
		return desktopFenceDecision{Reason: desktopFenceReasonTerminal, HighWater: entry.HighWater}
	}

	// Old server: no generation to compare. Admit, and leave the high-water
	// mark untouched so a later real generation still lands.
	if !in.HasGeneration {
		return desktopFenceDecision{Admitted: true, HighWater: entry.HighWater}
	}

	// Stale relative to the server: it has already moved past this
	// generation (a later re-offer, or the terminal bump). Checked before the
	// sync gate because it is knowledge, not certification — a lower bound
	// learned from any answer stays valid.
	if in.Generation < entry.SyncedGeneration {
		return desktopFenceDecision{Reason: desktopFenceReasonSuperseded, HighWater: entry.HighWater}
	}

	// The control plane has not confirmed this session in THIS process —
	// never seen, loaded from disk, or the state that knew it is gone. The
	// payload alone cannot be ordered against a terminal that a failed write
	// or a lost file may have forgotten, so the caller must sync first. A
	// loaded high-water mark still applies below once it has.
	if !entry.Synced {
		return desktopFenceDecision{Reason: desktopFenceReasonUnsynced, NeedsSync: true, HighWater: entry.HighWater}
	}

	if !entry.HasHighWater || in.Generation > entry.HighWater {
		entry.HighWater = in.Generation
		entry.HighWaterCommandID = in.CommandID
		entry.HasHighWater = true
		if err := f.setEntryLocked(sessionID, entry); err != nil {
			// The mark has advanced in memory and stays advanced; only the
			// join token is withdrawn so a redelivery cannot slip in on the
			// strength of a record that was never written.
			entry.HighWaterCommandID = ""
			f.entries[sessionID] = entry
			log.Error("desktop fence record could not be persisted; refusing start",
				"sessionId", sessionID, "generation", in.Generation, "error", err.Error())
			return desktopFenceDecision{Reason: desktopFenceReasonPersistFailed, HighWater: entry.HighWater}
		}
		return desktopFenceDecision{Admitted: true, HighWater: in.Generation}
	}

	// Same generation, same command: the one start that reached us over both
	// the WebSocket and the heartbeat response (#3107). Let it through to
	// joinOrRunDesktopStart, which collapses the two onto one helper
	// round-trip. The high-water mark is already at this generation, so
	// nothing to record.
	if in.Generation == entry.HighWater && in.CommandID != "" && in.CommandID == entry.HighWaterCommandID {
		return desktopFenceDecision{Admitted: true, HighWater: entry.HighWater}
	}

	return desktopFenceDecision{Reason: desktopFenceReasonSuperseded, HighWater: entry.HighWater}
}

// noteStop installs the absolute terminal tombstone for a session — even when
// no session is running under that id. That is the reorder fix: a stop that
// overtakes its start must still fence the start.
func (f *desktopFence) noteStop(sessionID string, in desktopStopFenceInput) {
	f.mu.Lock()
	defer f.mu.Unlock()

	entry := f.entries[sessionID]
	entry.Terminal = true
	// Carry the terminal generation into the high-water mark when it is newer.
	// The mark only ever moves forward.
	if in.HasGeneration && (!entry.HasHighWater || in.Generation > entry.HighWater) {
		entry.HighWater = in.Generation
		entry.HasHighWater = true
		entry.HighWaterCommandID = ""
	}
	if err := f.setEntryLocked(sessionID, entry); err != nil {
		// The tombstone holds in memory regardless; only its durability is
		// lost, and the next mutation retries the write.
		log.Error("desktop fence tombstone could not be persisted",
			"sessionId", sessionID, "error", err.Error())
	}
	f.wakeLocked(sessionID, desktopFenceSyncSynced)
}

// noteSync applies what the control plane said about a session in a
// lease-renew answer. It only ever adds knowledge: a terminal answer installs
// the tombstone, an echoed generation raises the synced generation, and the
// high-water mark is never lowered. An answer that changes nothing is not
// re-persisted, so a healthy 25 s renew cadence costs no disk writes.
func (f *desktopFence) noteSync(sessionID string, in desktopFenceSyncInput) {
	f.mu.Lock()
	defer f.mu.Unlock()

	entry, known := f.entries[sessionID]
	next := entry
	// Knowledge merges monotonically from ANY answer; certification ("this
	// session is confirmed live in this process") only from an answer that is
	// ours: nonce-matched, or nonce-less (old API / the watchdog's own renew)
	// while someone is waiting or the session is already running here.
	if f.answerCertifiesLocked(sessionID, in.Nonce, known && entry.HasHighWater) {
		next.Synced = true
	}
	if in.HasGeneration && in.Generation > next.SyncedGeneration {
		next.SyncedGeneration = in.Generation
	}
	if in.Terminal {
		next.Terminal = true
		if in.HasGeneration && (!next.HasHighWater || in.Generation > next.HighWater) {
			next.HighWater = in.Generation
			next.HasHighWater = true
			next.HighWaterCommandID = ""
		}
	}
	if !known || next != entry {
		if err := f.setEntryLocked(sessionID, next); err != nil {
			log.Error("desktop fence sync could not be persisted",
				"sessionId", sessionID, "error", err.Error())
		}
	}
	f.wakeMatchingLocked(sessionID, in.Nonce, desktopFenceSyncSynced)
}

func (f *desktopFence) answerCertifiesLocked(sessionID, nonce string, running bool) bool {
	waiters := f.waiters[sessionID]
	if nonce == "" {
		return running || len(waiters) > 0
	}
	for _, w := range waiters {
		if w.nonce == nonce {
			return true
		}
	}
	return false
}

// noteSyncUnavailable wakes anyone waiting on a sync for sessionID with an
// unavailable outcome. Nothing is recorded: an unavailable answer carries no
// knowledge, and the session stays unsynced.
func (f *desktopFence) noteSyncUnavailable(sessionID, nonce string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.wakeMatchingLocked(sessionID, nonce, desktopFenceSyncUnavailable)
}

// subscribeSync registers a waiter for the next sync outcome on sessionID
// that carries nonce (or no nonce at all). Register BEFORE sending the renew
// so an answer cannot be missed; always pair with unsubscribeSync.
func (f *desktopFence) subscribeSync(sessionID, nonce string) chan desktopFenceSyncOutcome {
	ch := make(chan desktopFenceSyncOutcome, 1)
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.waiters == nil {
		f.waiters = make(map[string][]desktopFenceWaiter)
	}
	f.waiters[sessionID] = append(f.waiters[sessionID], desktopFenceWaiter{nonce: nonce, ch: ch})
	return ch
}

func (f *desktopFence) unsubscribeSync(sessionID string, ch chan desktopFenceSyncOutcome) {
	f.mu.Lock()
	defer f.mu.Unlock()
	list := f.waiters[sessionID]
	for i, w := range list {
		if w.ch == ch {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(f.waiters, sessionID)
	} else {
		f.waiters[sessionID] = list
	}
}

// wakeLocked wakes every waiter on sessionID regardless of nonce — used by
// noteStop, where the outcome (terminal) is the same for all of them.
func (f *desktopFence) wakeLocked(sessionID string, outcome desktopFenceSyncOutcome) {
	f.wakeMatchingLocked(sessionID, "", outcome)
}

// wakeMatchingLocked wakes the waiters an answer with nonce is for: all of
// them when the answer carries no nonce, otherwise only the one it was
// requested with.
func (f *desktopFence) wakeMatchingLocked(sessionID, nonce string, outcome desktopFenceSyncOutcome) {
	for _, w := range f.waiters[sessionID] {
		if nonce != "" && w.nonce != nonce {
			continue
		}
		select {
		case w.ch <- outcome:
		default: // already woken; the waiter re-checks the fence anyway
		}
	}
}

// isTerminal reports whether sessionID is tombstoned. Used to re-check a
// start after it has actually created capture: a terminal that landed while
// the start was in flight must still win.
func (f *desktopFence) isTerminal(sessionID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.entries[sessionID].Terminal
}

// snapshot returns a copy of every entry, for the helper connect-time sync.
func (f *desktopFence) snapshot() map[string]desktopFenceEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make(map[string]desktopFenceEntry, len(f.entries))
	for id, e := range f.entries {
		out[id] = e
	}
	return out
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

// setEntryLocked records entry in memory, evicts beyond the cap, and
// persists. The in-memory write happens FIRST and is never undone on a
// persist failure: the fence may be less durable than promised, never less
// strict than what it has already seen.
func (f *desktopFence) setEntryLocked(sessionID string, entry desktopFenceEntry) error {
	if f.entries == nil {
		f.entries = make(map[string]desktopFenceEntry)
	}
	entry.UpdatedAtUnixMs = f.clock().UnixMilli()
	f.entries[sessionID] = entry
	f.evictLocked(sessionID)
	if f.persist == nil {
		return nil
	}
	state := desktopfence.State{Sessions: make(map[string]desktopfence.Entry, len(f.entries))}
	for id, e := range f.entries {
		state.Sessions[id] = e
	}
	return f.persist(state)
}

// evictLocked drops the oldest entries (by UpdatedAtUnixMs) until the fence
// is at the cap, never evicting keep. Non-terminal entries go first;
// tombstones only once older than desktopFenceTombstoneRetention.
func (f *desktopFence) evictLocked(keep string) {
	excess := len(f.entries) - maxDesktopFenceEntries
	if excess <= 0 {
		return
	}
	type aged struct {
		id string
		at int64
	}
	var live, stale []aged
	cutoff := f.clock().Add(-desktopFenceTombstoneRetention).UnixMilli()
	for id, e := range f.entries {
		if id == keep {
			continue
		}
		switch {
		case !e.Terminal:
			live = append(live, aged{id: id, at: e.UpdatedAtUnixMs})
		case e.UpdatedAtUnixMs < cutoff:
			stale = append(stale, aged{id: id, at: e.UpdatedAtUnixMs})
		}
	}
	byAge := func(list []aged) {
		sort.Slice(list, func(i, j int) bool {
			if list[i].at != list[j].at {
				return list[i].at < list[j].at
			}
			return list[i].id < list[j].id
		})
	}
	byAge(live)
	byAge(stale)
	for _, list := range [][]aged{live, stale} {
		for i := 0; excess > 0 && i < len(list); i++ {
			delete(f.entries, list[i].id)
			excess--
		}
	}
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
