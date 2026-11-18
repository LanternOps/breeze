package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"runtime"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/inbox"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// maxStoredEndpointMessages bounds the replay store per user. A send is rate
// limited server-side (1 critical per device per 5 min, 20 sends/hour/actor),
// so a device holding more than this many live cards is already abnormal; the
// soonest-expiring ones are dropped first.
const maxStoredEndpointMessages = 50

const endpointMessageStoreFile = "endpoint_messages.json"

// maxTombstones bounds the retract-before-notify set; the oldest is evicted.
const maxTombstones = 1024

// tombstoneTTL is the longest an endpoint message can live (168 h).
const tombstoneTTL = 168 * time.Hour

// errMessageRetracted is returned by Put for an id retracted before it arrived.
var errMessageRetracted = errors.New("message was retracted before delivery")

// messageStore keeps endpoint messages (#8293) that must survive a helper
// restart: the agent respawns the Assist helper on logon, update and crash, and
// a card that "stays until closed" has to come back. The helper stores nothing;
// after it authenticates the agent resends the user's pending messages. Acked,
// closed and expired messages are removed, so they never reappear (Review
// Focus 4).
//
// Since #10190 W02 it is a thin wrapper over the generalised inbox store:
// same file (endpoint_messages.json), same record format, plus an optional
// "owner" (the user principal the card was drawn for). A record written
// before W02 has no owner and is bound to the first user it is replayed to,
// so it never reaches a second user. A rolled-back agent reads the file
// unchanged. Retract-before-notify tombstones stay in memory (168 h).
//
// The file sits in the agent data dir. On Unix it is written 0600; on Windows
// the mode bits are not enforced and protection comes from the data dir's
// ProgramData ACL (SYSTEM + Administrators). It holds message text for at most
// the message's own lifetime (≤ 168 h).
type messageStore struct {
	st *inbox.Store
}

func endpointMessageOptions() inbox.Options {
	o := inbox.MessageOptions(messageIDOf)
	o.MaxPerOwner = maxStoredEndpointMessages
	o.TombstoneTTL = tombstoneTTL
	o.MaxTombstones = maxTombstones
	return o
}

func messageIDOf(raw json.RawMessage) string {
	var v struct {
		MessageID string `json:"messageId"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		return ""
	}
	return v.MessageID
}

func newMessageStore(path string) *messageStore {
	st, err := inbox.Open(path, endpointMessageOptions())
	if err != nil {
		log.Warn("endpoint message store unreadable; starting empty", "error", err.Error())
	}
	return &messageStore{st: st}
}

// endpointMessageStore returns the heartbeat's store, opening it on first use.
func (h *Heartbeat) endpointMessageStore() *messageStore {
	h.endpointMessagesOnce.Do(func() {
		if h.endpointMessages == nil {
			h.endpointMessages = newMessageStore(filepath.Join(config.GetDataDir(), endpointMessageStoreFile))
		}
	})
	return h.endpointMessages
}

// messageOwnerGOOS is the platform messageOwnerKey reads the principal for
// (a test seam).
var messageOwnerGOOS = runtime.GOOS

// messageOwnerKey is the user principal an Assist session draws for (the
// notification-list owner, shared with prompt entries). "" when the session
// carries no principal (a Windows session without a SID): such a session
// must not be handed anyone's cards.
func messageOwnerKey(s *sessionbroker.Session) string {
	if s == nil {
		return ""
	}
	o := prompthost.RendererFromSession(s, messageOwnerGOOS).Owner
	if messageOwnerGOOS == "windows" && o.UserSID == "" {
		return ""
	}
	return o.PrincipalKey()
}

// messageStoreOwner is the owner a newly drawn card is stored under: the
// session's user principal, or — when the session has none — a sentinel no
// principal key can equal ("win:..." / "unix:..."), so the card still
// correlates its ack and close but is never replayed to anyone. It is never
// "", which would leave the card unowned and bind it to the next user.
func messageStoreOwner(s *sessionbroker.Session) string {
	if key := messageOwnerKey(s); key != "" {
		return key
	}
	id := ""
	if s != nil {
		id = s.SessionID
	}
	return "noprincipal:" + id
}

// Put records a card with no owner yet (bound at its first replay). Only
// pre-W02 records and tests use it; new cards go through PutFor with
// messageStoreOwner.
func (s *messageStore) Put(m ipc.MessageShow, now time.Time) error {
	return s.PutFor(m, "", now)
}

// PutFor records a card the Assist helper drew for owner. An already expired
// or unparseable expiry is refused: such a message must never be replayed.
func (s *messageStore) PutFor(m ipc.MessageShow, owner string, now time.Time) error {
	if m.MessageID == "" {
		return errors.New("message id is required")
	}
	expires, err := time.Parse(time.RFC3339, m.ExpiresAt)
	if err != nil {
		return fmt.Errorf("parse expiresAt: %w", err)
	}
	if !expires.After(now) {
		return errors.New("message already expired")
	}
	m.Replay = false
	raw, err := json.Marshal(m)
	if err != nil {
		return err
	}
	// The caller treats a failed Put as "not stored" and never retires it; the
	// store keeps nothing in memory after a failed save, so the card is never
	// replayed after a native fallback.
	err = s.st.Put(inbox.Entry{ID: m.MessageID, Source: inbox.SourceMessage, OwnerKey: owner, ExpiresAt: expires, Payload: raw}, now)
	if errors.Is(err, inbox.ErrTombstoned) {
		return errMessageRetracted
	}
	return err
}

// Get returns a live (not terminal) message by id.
func (s *messageStore) Get(id string) (ipc.MessageShow, bool) {
	e, ok := s.st.Get(id)
	if !ok {
		return ipc.MessageShow{}, false
	}
	var m ipc.MessageShow
	if err := json.Unmarshal(e.Payload, &m); err != nil {
		return ipc.MessageShow{}, false
	}
	return m, true
}

// Pending prunes expired messages and returns every live one,
// soonest-expiring first (the pre-W02 view, no owner binding).
func (s *messageStore) Pending(now time.Time) []ipc.MessageShow {
	return s.PendingFor("", now)
}

// PendingFor returns owner's live messages, soonest-expiring first, binding
// any not-yet-owned (pre-W02) message to owner.
func (s *messageStore) PendingFor(owner string, now time.Time) []ipc.MessageShow {
	entries := s.st.Pending(owner, now)
	shows := make([]ipc.MessageShow, 0, len(entries))
	for _, e := range entries {
		var m ipc.MessageShow
		if err := json.Unmarshal(e.Payload, &m); err != nil {
			log.Warn("unreadable endpoint message dropped from the replay store", "messageId", e.ID, "error", err.Error())
			s.st.Remove(e.ID)
			continue
		}
		shows = append(shows, m)
	}
	return shows
}

// MarkTerminal removes a message (acknowledged, dismissed or expired). It
// reports whether the message was live, so a duplicate or forged event for an
// unknown id is recognisable.
func (s *messageStore) MarkTerminal(id string) bool {
	return s.st.Remove(id)
}

// Tombstone records that id was retracted so a later notify_user for it is refused.
func (s *messageStore) Tombstone(id string, now time.Time) {
	if err := s.st.Tombstone(id, now); err != nil {
		log.Warn("endpoint message store save failed", "error", err.Error())
	}
}

// Retract removes a live message, or tombstones the id when none exists, in one
// critical section so a concurrent Put cannot slip between the two. It reports
// whether a live message was removed.
func (s *messageStore) Retract(id string, now time.Time) bool {
	return s.st.Retract(id, now)
}

// IsTombstoned reports whether id was retracted before its notify arrived.
func (s *messageStore) IsTombstoned(id string, now time.Time) bool {
	return s.st.Tombstoned(id, now)
}

func (s *messageStore) tombstoneCount() int {
	return s.st.TombstoneCount()
}
