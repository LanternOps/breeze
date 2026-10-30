package prompthost

import (
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// rendererServes reports whether a renderer can draw for an owner: the SYSTEM
// helper serves its whole Windows session, every other renderer only its own
// principal.
func rendererServes(r RendererSession, o Owner) bool {
	if r.Role == ipc.HelperRoleSystem {
		return o.WinSessionID != 0 && r.Owner.WinSessionID == o.WinSessionID
	}
	return r.Owner.Matches(o)
}

// replay brings a (re)connected renderer up to date (spec §3.1, §3.2):
//   - every open prompt the selector now assigns to it moves there with a new
//     lease; a copy on another renderer (the native fallback) is fenced first;
//   - nothing is activated: every replay is no_activate, and all but the
//     oldest pending decision are replayed list-only, so at most one decision
//     surface comes back. An indicator stays an indicator (it is a pill, not
//     a card, and never a decision).
//
// Called with mu held; finished entries are replayed by
// replayFinishedEntries, which reads the inbox outside the lock.
func (h *Host) replay(r RendererSession, now time.Time, ob *outbox) {
	type move struct {
		rec *record
		pl  *placement
		c   Choice
	}
	var moves []move
	for _, rec := range h.sortedRecords() {
		if !rec.lingerUntil.IsZero() || rec.neverReask() {
			continue // a NeverReask prompt stays where it was drawn
		}
		for _, pl := range rec.placements {
			if pl.deferred != deferNone || pl.renderer == r.Key || !rendererServes(r, pl.owner) {
				continue
			}
			c := h.choose(rec, pl)
			if c.Path != PathPrompt || c.Renderer.Key != r.Key {
				continue
			}
			moves = append(moves, move{rec, pl, c})
		}
	}
	restored := false
	for _, m := range moves {
		h.fence(m.rec, m.pl, ob)
		switch {
		case m.rec.show.Presentation == ipc.PromptPresentationIndicator:
		case !restored && ipc.IsPromptDecision(m.rec.show.State, m.rec.show.Presentation) && !m.pl.listOnly:
			restored = true
		default:
			m.pl.listOnly = true
		}
		m.pl.rateChecked = true // a replay is not a new card
		h.assign(m.rec, m.pl, m.c, now, ob, false)
		// assign queued the show last; make it non-activating.
		if n := len(ob.steps); n > 0 && ob.steps[n-1].send != nil {
			if s, ok := ob.steps[n-1].send.payload.(ipc.PromptShow); ok {
				s.Focus = ipc.PromptFocusNoActivate
				ob.steps[n-1].send.payload = s
			}
		}
	}
}

// replayFinishedEntries replays the renderer principal's finished entries
// (outcomes still in the notification list) list-only and non-activating.
func (h *Host) replayFinishedEntries(r RendererSession) {
	if h.inbox == nil {
		return
	}
	entries := h.inbox.PromptEntries(r.Owner.PrincipalKey())
	if len(entries) == 0 {
		return
	}
	ob := &outbox{}
	h.mu.Lock()
	for _, e := range entries {
		if h.prompts[e.PromptID] != nil || !e.Show.State.Terminal() {
			continue // live prompts were replayed with a lease of their own
		}
		if _, ok := negotiateVersion(e.Show.Kind, []int{e.Show.KindVersion}, r, h.enabled); !ok {
			continue
		}
		s := e.Show
		s.Lease = ipc.PromptLease{RendererSession: r.Key, Epoch: 1}
		s.Presentation = ipc.PromptPresentationListOnly
		s.Focus = ipc.PromptFocusNoActivate
		ob.send(r.Key, ipc.TypePromptShow, s.Kind, s.PromptID, nil, s)
	}
	h.unlockAndFlush(ob)
}
