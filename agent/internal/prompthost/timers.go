package prompthost

import (
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Tick runs the host's timers against the wall clock: replays for renderers
// that connected, terminal lingers, response deadlines, held placements, the
// present budget, and the disconnect grace. It is called once a second by Run
// (and directly by tests). Comparing against clock.Now() rather than arming
// monotonic timers means a machine that slept across a deadline expires the
// prompt on the first tick after resume, exactly once, and never later.
func (h *Host) Tick() {
	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	h.tombs.prune(now)

	for key, r := range h.connected {
		delete(h.connected, key)
		h.replay(r, now, ob)
	}

	for _, rec := range h.sortedRecords() {
		if !rec.lingerUntil.IsZero() {
			if !now.Before(rec.lingerUntil) {
				h.closeLocked(rec, ipc.PromptCloseResolved, now, ob)
			}
			continue
		}
		if !rec.expiryFired && rec.everPrompt {
			if d := rec.deadline(); !d.IsZero() && !now.Before(d) {
				rec.expiryFired = true
				id, onExpire := rec.show.PromptID, rec.p.OnExpire
				ob.call(func() {
					if onExpire != nil {
						onExpire()
					}
					h.expireIfOpen(id)
				})
				continue
			}
		}
		for _, pl := range rec.placements {
			h.tickPlacement(rec, pl, now, ob)
		}
	}
	h.mu.Unlock()
	h.flush(ob)
}

func (h *Host) tickPlacement(rec *record, pl *placement, now time.Time, ob *outbox) {
	switch pl.deferred {
	case deferLocked:
		if !h.locked[pl.owner.WinSessionID] {
			h.place(rec, pl, now, ob)
		}
		return
	case deferModal:
		if !h.modalBusy(rec, pl.owner) {
			h.place(rec, pl, now, ob)
		}
		return
	}
	if pl.path != PathPrompt || pl.renderer == "" {
		return
	}
	if !pl.graceUntil.IsZero() {
		if !now.Before(pl.graceUntil) {
			h.fallback(rec, pl, now, ob, "renderer_gone")
		}
		return
	}
	if !pl.presented && !pl.listOnly && !now.Before(pl.presentBy) {
		h.fallback(rec, pl, now, ob, "present_budget")
	}
}

// expireIfOpen closes a prompt whose deadline passed, unless the domain's
// OnExpire already moved it to a terminal state (then it lingers) or closed it.
func (h *Host) expireIfOpen(id string) {
	ob := &outbox{}
	h.mu.Lock()
	if rec := h.prompts[id]; rec != nil && rec.lingerUntil.IsZero() && !rec.show.State.Terminal() {
		h.closeLocked(rec, ipc.PromptCloseExpired, h.clock.Now(), ob)
	}
	h.mu.Unlock()
	h.flush(ob)
}
