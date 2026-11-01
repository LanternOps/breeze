package inbox

import (
	"encoding/json"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

var storeLog = logging.L("inbox")

// Ownership: every entry is bound to the user principal it was shown to
// (prompthost.Owner.PrincipalKey: Windows SID, Unix uid), never to a bare
// session id, so an after-the-fact entry still reaches the same person after
// the next sign-in, and never another user after fast user switching or an
// RDS reconnect into a different session.

// PromptInbox adapts a prompt Store to prompthost.PromptInbox.
type PromptInbox struct {
	Store *Store
	Now   func() time.Time
}

var _ prompthost.PromptInbox = (*PromptInbox)(nil)

func (p *PromptInbox) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
}

// PutPrompt stores a prompt's list entry.
func (p *PromptInbox) PutPrompt(e prompthost.ListEntry) error {
	raw, err := json.Marshal(e.Show)
	if err != nil {
		return err
	}
	return p.Store.Put(Entry{ID: e.ID, Source: SourcePrompt, OwnerKey: e.OwnerKey, ScopeID: e.ScopeID, ExpiresAt: e.ExpiresAt, Payload: raw}, p.now())
}

// RetractPrompt removes a prompt's list entry.
func (p *PromptInbox) RetractPrompt(id string) error {
	p.Store.Remove(id)
	return nil
}

// TombstonePrompt refuses the prompt id for 24 h, across restarts.
func (p *PromptInbox) TombstonePrompt(promptID string) error {
	return p.Store.Tombstone(tombstoneKey(promptID), p.now())
}

// PromptTombstoned reports whether the prompt id was decided recently.
func (p *PromptInbox) PromptTombstoned(promptID string) bool {
	return p.Store.Tombstoned(tombstoneKey(promptID), p.now())
}

// PromptEntries returns the owner's prompt entries.
func (p *PromptInbox) PromptEntries(ownerKey string) []prompthost.ListEntry {
	if ownerKey == "" {
		return nil
	}
	var out []prompthost.ListEntry
	for _, e := range p.Store.Pending(ownerKey, p.now()) {
		var show ipc.PromptShow
		if err := json.Unmarshal(e.Payload, &show); err != nil {
			storeLog.Warn("unreadable prompt list entry dropped", "id", e.ID, "error", err.Error())
			p.Store.Remove(e.ID)
			continue
		}
		out = append(out, prompthost.ListEntry{ID: e.ID, PromptID: show.PromptID, OwnerKey: e.OwnerKey, ScopeID: e.ScopeID, ExpiresAt: e.ExpiresAt, Show: show})
	}
	return out
}

// tombstoneKey keeps prompt-id tombstones apart from entry ids
// ("<promptId>#<owner>") in the same file.
func tombstoneKey(promptID string) string { return "tomb:" + promptID }
