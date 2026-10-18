package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// maxStoredEndpointMessages bounds the replay store. A send is rate limited
// server-side (1 critical per device per 5 min, 20 sends/hour/actor), so a
// device holding more than this many live cards is already abnormal; the
// soonest-expiring ones are dropped first.
const maxStoredEndpointMessages = 50

const endpointMessageStoreFile = "endpoint_messages.json"

// storedMessage is one card the Assist helper drew and the user has not yet
// acknowledged or closed.
type storedMessage struct {
	Show      ipc.MessageShow `json:"show"`
	ExpiresAt time.Time       `json:"expiresAt"`
}

// messageStore keeps endpoint messages (#8293) that must survive a helper
// restart: the agent respawns the Assist helper on logon, update and crash, and
// a card that "stays until closed" has to come back. The helper stores nothing;
// after it authenticates the agent resends Pending(). Acked, closed and expired
// messages are removed, so they never reappear (Review Focus 4).
//
// The file sits in the agent data dir. On Unix it is written 0600; on Windows
// the mode bits are not enforced and protection comes from the data dir's
// ProgramData ACL (SYSTEM + Administrators). It holds message text for at most
// the message's own lifetime (≤ 168 h).
type messageStore struct {
	mu   sync.Mutex
	path string
	msgs map[string]storedMessage
	// tombs records ids retracted before their notify_user arrived (commands run
	// concurrently). In memory only: a restart in that window is vanishingly
	// rare and the message's own expiry bounds the exposure.
	tombs map[string]time.Time
}

// maxTombstones bounds the retract-before-notify set; the oldest is evicted.
const maxTombstones = 1024

// tombstoneTTL is the longest an endpoint message can live (168 h).
const tombstoneTTL = 168 * time.Hour

// errMessageRetracted is returned by Put for an id retracted before it arrived.
var errMessageRetracted = errors.New("message was retracted before delivery")

func newMessageStore(path string) *messageStore {
	s := &messageStore{path: path, msgs: map[string]storedMessage{}, tombs: map[string]time.Time{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			log.Warn("endpoint message store unreadable; starting empty", "error", err.Error())
		}
		return s
	}
	var loaded map[string]storedMessage
	if err := json.Unmarshal(raw, &loaded); err != nil {
		log.Warn("endpoint message store corrupt; starting empty", "error", err.Error())
		return s
	}
	for id, m := range loaded {
		if id != "" && id == m.Show.MessageID {
			s.msgs[id] = m
		}
	}
	return s
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

// Put records a card the Assist helper has drawn. An already expired or
// unparseable expiry is refused: such a message must never be replayed.
func (s *messageStore) Put(m ipc.MessageShow, now time.Time) error {
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
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.isTombstonedLocked(m.MessageID, now) {
		return errMessageRetracted
	}
	s.pruneLocked(now)
	s.msgs[m.MessageID] = storedMessage{Show: m, ExpiresAt: expires}
	s.enforceCapLocked()
	if err := s.saveLocked(); err != nil {
		// The caller treats a failed Put as "not stored" and never retires it;
		// a copy left in memory would replay the card after a native fallback.
		delete(s.msgs, m.MessageID)
		return err
	}
	return nil
}

// Get returns a live (not terminal) message by id.
func (s *messageStore) Get(id string) (ipc.MessageShow, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	m, ok := s.msgs[id]
	return m.Show, ok
}

// Pending prunes expired messages and returns the rest, soonest-expiring first.
func (s *messageStore) Pending(now time.Time) []ipc.MessageShow {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.pruneLocked(now) {
		if err := s.saveLocked(); err != nil {
			log.Warn("endpoint message store save failed", "error", err.Error())
		}
	}
	out := make([]storedMessage, 0, len(s.msgs))
	for _, m := range s.msgs {
		out = append(out, m)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].ExpiresAt.Equal(out[j].ExpiresAt) {
			return out[i].ExpiresAt.Before(out[j].ExpiresAt)
		}
		return out[i].Show.MessageID < out[j].Show.MessageID
	})
	shows := make([]ipc.MessageShow, 0, len(out))
	for _, m := range out {
		shows = append(shows, m.Show)
	}
	return shows
}

// MarkTerminal removes a message (acknowledged, dismissed or expired). It
// reports whether the message was live, so a duplicate or forged event for an
// unknown id is recognisable.
func (s *messageStore) MarkTerminal(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.msgs[id]; !ok {
		return false
	}
	delete(s.msgs, id)
	if err := s.saveLocked(); err != nil {
		log.Warn("endpoint message store save failed", "error", err.Error())
	}
	return true
}

func (s *messageStore) pruneLocked(now time.Time) bool {
	changed := false
	for id, m := range s.msgs {
		if !m.ExpiresAt.After(now) {
			delete(s.msgs, id)
			changed = true
			// No upstream event in W1: the helper reports expiry while it is
			// running; this covers expiry while it was not.
			log.Info("endpoint message expired in the replay store", "messageId", id)
		}
	}
	return changed
}

func (s *messageStore) enforceCapLocked() {
	if len(s.msgs) <= maxStoredEndpointMessages {
		return
	}
	all := make([]storedMessage, 0, len(s.msgs))
	for _, m := range s.msgs {
		all = append(all, m)
	}
	sort.Slice(all, func(i, j int) bool { return all[i].ExpiresAt.Before(all[j].ExpiresAt) })
	for _, m := range all[:len(all)-maxStoredEndpointMessages] {
		delete(s.msgs, m.Show.MessageID)
	}
}

// saveLocked writes the store atomically (temp file + rename); 0600 on Unix.
func (s *messageStore) saveLocked() error {
	if s.path == "" {
		return nil
	}
	raw, err := json.Marshal(s.msgs)
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, endpointMessageStoreFile+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

// Tombstone records that id was retracted so a later notify_user for it is refused.
func (s *messageStore) Tombstone(id string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.tombstoneLocked(id, now)
}

// Retract removes a live message, or tombstones the id when none exists, in one
// critical section so a concurrent Put cannot slip between the two. It reports
// whether a live message was removed.
func (s *messageStore) Retract(id string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.msgs[id]; !ok {
		s.tombstoneLocked(id, now)
		return false
	}
	delete(s.msgs, id)
	if err := s.saveLocked(); err != nil {
		log.Warn("endpoint message store save failed", "error", err.Error())
	}
	return true
}

func (s *messageStore) tombstoneLocked(id string, now time.Time) {
	for k, exp := range s.tombs {
		if !exp.After(now) {
			delete(s.tombs, k)
		}
	}
	s.tombs[id] = now.Add(tombstoneTTL)
	for len(s.tombs) > maxTombstones {
		oldest, oldestExp := "", time.Time{}
		for k, exp := range s.tombs {
			if oldest == "" || exp.Before(oldestExp) {
				oldest, oldestExp = k, exp
			}
		}
		delete(s.tombs, oldest)
	}
}

// IsTombstoned reports whether id was retracted before its notify arrived.
func (s *messageStore) IsTombstoned(id string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.isTombstonedLocked(id, now)
}

func (s *messageStore) isTombstonedLocked(id string, now time.Time) bool {
	exp, ok := s.tombs[id]
	return ok && exp.After(now)
}

func (s *messageStore) tombstoneCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.tombs)
}
