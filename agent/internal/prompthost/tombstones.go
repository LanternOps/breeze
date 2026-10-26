package prompthost

import "time"

// tombstones remember decided prompts for 24 h so a late replay or a
// re-delivered server command cannot resurrect one. Persisted through the
// inbox when one is configured (survives an agent restart).
type tombstones struct {
	at    map[string]time.Time
	inbox PromptInbox
}

func newTombstones(inbox PromptInbox) *tombstones {
	return &tombstones{at: map[string]time.Time{}, inbox: inbox}
}

func (t *tombstones) add(id string, now time.Time) {
	t.at[id] = now
	if t.inbox != nil {
		t.inbox.TombstonePrompt(id)
	}
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
