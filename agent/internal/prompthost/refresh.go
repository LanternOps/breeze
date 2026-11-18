package prompthost

import (
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// W05 host seams (#10190, restart).
//
// A restart card lives for the whole campaign: every warning rung re-shows
// it (Show: a full prompt_show, so a card the person hid comes back), while
// a postponement or a cancellation changes it where it is (Refresh: a
// prompt_update, so the card the person just collapsed stays collapsed —
// spec §3.3 "Postponing does not reopen the prompt"). Unlike Update, whose
// Patch is sent as given, Refresh carries a whole new Prompt and renders it
// per placement through Localize, so a de-DE session gets German copy.

// Refresh replaces the content of an open prompt in place. Each renderer
// gets a prompt_update carrying the new state, copy, facts, actions, default
// and timing, localized for its session; nothing is re-surfaced and nothing
// takes focus. The prompt keeps its owners, placements and leases. A
// terminal state lingers and is then closed resolved, so the list keeps the
// outcome.
func (h *Host) Refresh(p Prompt) error {
	if p.ID == "" {
		p.ID = p.Show.PromptID
	}
	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	rec := h.prompts[p.ID]
	if rec == nil {
		tomb := h.tombs.has(p.ID, now)
		h.mu.Unlock()
		if tomb {
			return ErrTombstoned
		}
		return ErrUnknownPrompt
	}
	if !rec.lingerUntil.IsZero() {
		h.mu.Unlock()
		return fmt.Errorf("prompthost: %s is already in a terminal state", p.ID)
	}
	if p.Kind.Name != rec.p.Kind.Name || p.Kind.Version != rec.p.Kind.Version {
		h.mu.Unlock()
		return fmt.Errorf("prompthost: refresh of %s changes its kind", p.ID)
	}
	next := p.Show
	next.PromptID = p.ID
	next.Kind = rec.show.Kind
	next.KindVersion = rec.show.KindVersion
	next.Lease = rec.show.Lease
	next.Rev = rec.show.Rev + 1
	if next.Actions == nil {
		next.Actions = []ipc.PromptAction{}
	}
	if next.IdentityRef == nil {
		// The identity a prompt was created under stays with it (spec §3.1
		// identityRef): a scope change must still find and close it.
		next.IdentityRef = rec.show.IdentityRef
	}
	if err := ipc.ValidatePromptShow(next); err != nil {
		h.mu.Unlock()
		return fmt.Errorf("prompthost: %w", err)
	}
	p.Owners = rec.p.Owners
	rec.p = p
	rec.show = next
	for _, pl := range rec.placements {
		if pl.path != PathPrompt || pl.renderer == "" {
			continue
		}
		ws := h.wireShow(rec, pl)
		state, copy, facts, actions, timing := ws.State, ws.Copy, ws.Facts, ws.Actions, ws.Timing
		if facts == nil {
			facts = []ipc.PromptFact{}
		}
		ob.send(pl.renderer, ipc.TypePromptUpdate, rec.show.Kind, rec.show.PromptID, nil, ipc.PromptUpdate{
			PromptID:        ws.PromptID,
			Rev:             ws.Rev,
			Lease:           ws.Lease,
			State:           &state,
			Copy:            &copy,
			Facts:           &facts,
			Actions:         &actions,
			DefaultActionID: ws.DefaultActionID,
			Timing:          &timing,
		})
	}
	if next.State.Terminal() {
		linger := rec.p.Kind.Linger
		if linger <= 0 {
			linger = defaultLinger
		}
		rec.lingerUntil = now.Add(linger)
	}
	h.persist(rec, now, ob)
	h.unlockAndFlush(ob)
	return nil
}

// RemoveFinished retracts an after-the-fact entry RecordFinished wrote, for
// each owner: the event it reports did not happen after all (a restart
// aborted in its last minute, or an OS command that failed).
func (h *Host) RemoveFinished(promptID string, owners []Owner) error {
	if h.inbox == nil {
		return nil
	}
	var errs []error
	for _, o := range owners {
		if err := h.inbox.RetractPrompt(listEntryID(promptID, o)); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// RecordFinished writes an after-the-fact entry ("Your computer restarted at
// 03:12 …", spec §3.2) to each owner's notification list without drawing
// anything now. It is replayed list-only, never activated, when the owner's
// renderer next connects (replayFinishedEntries). The state must be terminal:
// a decision is never parked in the list this way. The write is synchronous,
// so a caller about to restart the machine knows the entry is on disk.
func (h *Host) RecordFinished(p Prompt) error {
	if p.ID == "" {
		p.ID = p.Show.PromptID
	}
	if h.inbox == nil {
		return errors.New("prompthost: no notification list")
	}
	if len(p.Owners) == 0 {
		return errors.New("prompthost: prompt has no owner")
	}
	if !p.Show.State.Terminal() {
		return fmt.Errorf("prompthost: %s is not finished (state %q)", p.ID, p.Show.State)
	}
	show := p.Show
	show.PromptID = p.ID
	show.Kind = p.Kind.Name
	show.KindVersion = p.Kind.Version
	show.Lease = ipc.PromptLease{RendererSession: "host", Epoch: 1}
	show.Rev = 1
	show.Presentation = ipc.PromptPresentationListOnly
	show.Focus = ipc.PromptFocusNoActivate
	if show.Actions == nil {
		show.Actions = []ipc.PromptAction{}
	}
	if err := ipc.ValidatePromptShow(show); err != nil {
		return fmt.Errorf("prompthost: %w", err)
	}
	expires := h.clock.Now().Add(listEntryTTL)
	if ms := show.ListEntry.ExpiresAtUnixMs; ms > 0 {
		expires = time.UnixMilli(ms)
	}
	scope := ""
	if show.IdentityRef != nil {
		scope = show.IdentityRef.ScopeID
	}
	rec := &record{p: p, show: show}
	var errs []error
	seen := map[string]bool{}
	for _, o := range p.Owners {
		id := listEntryID(p.ID, o)
		if seen[id] {
			continue
		}
		seen[id] = true
		// The owner's language: their live renderer's, else the machine's.
		loc := h.SessionLocale(RendererSession{})
		if rs := h.dir.Renderers(o); len(rs) > 0 {
			loc = h.SessionLocale(rs[0])
		}
		localized := h.localize(rec, show, loc) // pure: Localize only
		if err := h.inbox.PutPrompt(ListEntry{
			ID:        id,
			PromptID:  p.ID,
			OwnerKey:  o.PrincipalKey(),
			ScopeID:   scope,
			ExpiresAt: expires,
			Show:      localized,
		}); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
