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
//     surface comes back;
//   - finished entries still in the notification list are replayed list-only.
func (h *Host) replay(r RendererSession, now time.Time, ob *outbox) {
	type move struct {
		rec *record
		pl  *placement
		c   Choice
	}
	var moves []move
	live := map[string]bool{}
	for _, rec := range h.sortedRecords() {
		live[rec.show.PromptID] = true
		if !rec.lingerUntil.IsZero() {
			continue
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
		surface := !restored && ipc.IsPromptDecision(m.rec.show.State, m.rec.show.Presentation) && !m.pl.listOnly
		if surface {
			restored = true
		} else {
			m.pl.listOnly = true
		}
		m.pl.rateChecked = true // a replay is not a new card
		h.assign(m.rec, m.pl, m.c, now, ob)
		// assign queued the show last; make it non-activating.
		if n := len(ob.sends); n > 0 {
			if s, ok := ob.sends[n-1].payload.(ipc.PromptShow); ok {
				s.Focus = ipc.PromptFocusNoActivate
				ob.sends[n-1].payload = s
			}
		}
	}
	h.replayFinishedEntries(r, live, ob)
}

func (h *Host) replayFinishedEntries(r RendererSession, live map[string]bool, ob *outbox) {
	if h.inbox == nil {
		return
	}
	for _, e := range h.inbox.PromptEntries(r.Owner.Key()) {
		if live[e.PromptID] {
			continue
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
}
