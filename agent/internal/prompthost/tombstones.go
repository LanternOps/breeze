package prompthost

import "time"

// tombstones remember decided prompts for 24 h so a late replay or a
// re-delivered server command cannot resurrect one. The in-memory set is the
// immediate truth; the inbox copy (written after the state lock is released)
// survives an agent restart.
type tombstones struct {
	at    map[string]time.Time
	inbox PromptInbox
}

func newTombstones(inbox PromptInbox) *tombstones {
	return &tombstones{at: map[string]time.Time{}, inbox: inbox}
}

// add records id now and queues the persistent write on ob.
func (t *tombstones) add(id string, now time.Time, ob *outbox, h *Host) {
	t.at[id] = now
	if t.inbox == nil {
		return
	}
	inbox := t.inbox
	ob.io(func() {
		if err := inbox.TombstonePrompt(id); err != nil {
			h.log.Warn("prompt tombstone not persisted; a restart could redraw it", "promptId", id, "error", err.Error())
		}
	})
}

func (t *tombstones) has(id string, now time.Time) bool {
	if at, ok := t.at[id]; ok && now.Sub(at) < promptTombstoneTTL {
		return true
	}
	return t.inbox != nil && t.inbox.PromptTombstoned(id)
}

func (t *tombstones) prune(now time.Time) {
	for id, at := range t.at {
		if now.Sub(at) >= promptTombstoneTTL {
			delete(t.at, id)
		}
	}
}
