package prompthost

import (
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Tick runs the host's timers against the wall clock: replays for renderers
// that connected, terminal lingers, response deadlines, held placements, the
// present budget, failed sends, and the disconnect grace. Run calls it once a
// second (tests call it directly). Comparing against clock.Now() rather than
// arming monotonic timers means a machine that slept across a deadline
// expires the prompt on the first tick after resume, exactly once, and never
// later.
func (h *Host) Tick() {
	ob := &outbox{}
	h.mu.Lock()
	now := h.clock.Now()
	h.tombs.prune(now)

	connected := make([]RendererSession, 0, len(h.connected))
	for key, r := range h.connected {
		delete(h.connected, key)
		connected = append(connected, r)
		h.replay(r, now, ob)
	}

	var expiring []string
	for _, rec := range h.sortedRecords() {
		if !rec.lingerUntil.IsZero() {
			if !now.Before(rec.lingerUntil) {
				h.closeLocked(rec, ipc.PromptCloseResolved, now, ob)
			}
			continue
		}
		if !rec.expiryFired && rec.everPrompt {
			if d := rec.deadline(); !d.IsZero() && !now.Before(d) {
				expiring = append(expiring, rec.show.PromptID)
				continue
			}
		}
		for _, pl := range rec.placements {
			h.tickPlacement(rec, pl, now, ob)
		}
	}
	h.unlockAndFlush(ob)

	for _, id := range expiring {
		h.expire(id)
	}
	for _, r := range connected {
		h.replayFinishedEntries(r)
	}
}

func (h *Host) tickPlacement(rec *record, pl *placement, now time.Time, ob *outbox) {
	switch pl.deferred {
	case deferLocked:
		if !h.locked[pl.owner.WinSessionID] {
			h.place(rec, pl, now, ob, false)
		}
		return
	case deferModal:
		if !h.modalBusy(rec, pl.owner) {
			h.place(rec, pl, now, ob, false)
		}
		return
	}
	if pl.path != PathPrompt || pl.renderer == "" {
		return
	}
	switch {
	case pl.sendFailed:
		h.fallback(rec, pl, now, ob, "send_failed")
	case !pl.graceUntil.IsZero():
		if !now.Before(pl.graceUntil) {
			h.fallback(rec, pl, now, ob, "renderer_gone")
		}
	case !pl.presented && !pl.listOnly && !now.Before(pl.presentBy):
		h.fallback(rec, pl, now, ob, "present_budget")
	}
}

// expire runs a prompt's expiry as a decision: serialized with actions
// (actionMu), re-checked under the state lock, fired at most once. If the
// domain's OnExpire leaves the prompt open and not terminal, it is closed as
// expired; if OnExpire moved it to a terminal state, it lingers as usual.
func (h *Host) expire(id string) {
	h.actionMu.Lock()
	defer h.actionMu.Unlock()

	h.mu.Lock()
	rec := h.prompts[id]
	now := h.clock.Now()
	if rec == nil || rec.expiryFired || !rec.lingerUntil.IsZero() || rec.show.State.Terminal() {
		h.mu.Unlock()
		return
	}
	if d := rec.deadline(); d.IsZero() || now.Before(d) {
		h.mu.Unlock()
		return
	}
	rec.expiryFired = true
	onExpire := rec.p.OnExpire
	h.mu.Unlock()

	if onExpire != nil {
		onExpire()
	}

	ob := &outbox{}
	h.mu.Lock()
	if cur := h.prompts[id]; cur != nil && cur.lingerUntil.IsZero() && !cur.show.State.Terminal() {
		h.closeLocked(cur, ipc.PromptCloseExpired, h.clock.Now(), ob)
	}
	h.unlockAndFlush(ob)
	h.log.Info("prompt expired", "promptId", id)
}
