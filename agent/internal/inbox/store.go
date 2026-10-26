// Package inbox is the agent's persistent notification list (#10190, spec
// §3.2, plan P5): one store type, two files.
//
//   - Endpoint messages keep endpoint_messages.json at the same path and in
//     the same record format ({"show", "expiresAt"}) plus an optional additive
//     "owner". An agent rolled back to a pre-W02 build reads the file
//     unchanged (it ignores "owner"). Message tombstones stay in memory,
//     168 h, exactly as before.
//   - Prompt entries live in prompt_inbox.json with 24 h tombstones that
//     persist across restarts, so a decided prompt is never redrawn.
//
// Assist keeps no durable state; the agent replays from here.
package inbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// Entry sources.
const (
	SourceMessage = "message"
	SourcePrompt  = "prompt"
)

// ErrTombstoned is returned by Put for an id retracted or decided earlier.
var ErrTombstoned = errors.New("inbox: entry was retracted or decided")

// Entry is one list entry.
type Entry struct {
	ID       string
	Source   string // SourceMessage | SourcePrompt
	OwnerKey string // the user principal it is bound to; "" = not yet bound (pre-W02 record)
	ScopeID  string // MSP identity scope it was created under ("" = none)
	// ExpiresAt is when the entry leaves the list.
	ExpiresAt time.Time
	Payload   json.RawMessage
}

// Options configure one store.
type Options struct {
	Source string
	// MaxPerOwner caps entries per owner (the soonest-expiring are dropped).
	MaxPerOwner int
	// EntryTTL caps an entry's life from the time it is stored (0 = none).
	EntryTTL time.Duration
	// TombstoneTTL is how long a retracted / decided id is refused.
	TombstoneTTL time.Duration
	// MaxTombstones bounds the tombstone set (the oldest is evicted).
	MaxTombstones int
	// PersistTombstones writes tombstones to the file (prompts). Messages keep
	// them in memory so the legacy file format is untouched.
	PersistTombstones bool
	// PayloadID returns the id a payload claims; a loaded record whose payload
	// disagrees with its key is dropped (nil = no check).
	PayloadID func(json.RawMessage) string
	// FileMode for the store file (Unix; Windows relies on the data dir ACL).
	FileMode os.FileMode
}

// MessageOptions are the endpoint-message store's options.
func MessageOptions(payloadID func(json.RawMessage) string) Options {
	return Options{
		Source:        SourceMessage,
		MaxPerOwner:   50,
		TombstoneTTL:  168 * time.Hour,
		MaxTombstones: 1024,
		PayloadID:     payloadID,
		FileMode:      0o600,
	}
}

// PromptOptions are the prompt list's options (7 days, 50 per owner, 24 h
// persisted tombstones).
func PromptOptions() Options {
	return Options{
		Source:            SourcePrompt,
		MaxPerOwner:       50,
		EntryTTL:          7 * 24 * time.Hour,
		TombstoneTTL:      24 * time.Hour,
		MaxTombstones:     1024,
		PersistTombstones: true,
		FileMode:          0o600,
	}
}

// record is the on-disk shape. "show" and "expiresAt" are the pre-W02 fields
// and must keep their names and encoding.
type record struct {
	Show      json.RawMessage `json:"show,omitempty"`
	ExpiresAt time.Time       `json:"expiresAt"`
	Owner     string          `json:"owner,omitempty"`
	ScopeID   string          `json:"scopeId,omitempty"`
	Tombstone bool            `json:"tombstone,omitempty"`
}

// Store is one persisted list. Safe for concurrent use.
type Store struct {
	opts    Options
	path    string
	mu      sync.Mutex
	entries map[string]record
	tombs   map[string]time.Time // id -> refused until
}

// Open loads a store. A missing file is an empty store. An unreadable or
// corrupt file also yields a usable empty store, and the error says why (the
// caller logs it); the next save replaces the file.
func Open(path string, opts Options) (*Store, error) {
	s := &Store{opts: opts, path: path, entries: map[string]record{}, tombs: map[string]time.Time{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return s, nil
		}
		return s, fmt.Errorf("inbox: %s unreadable; starting empty: %w", filepath.Base(path), err)
	}
	var loaded map[string]record
	if err := json.Unmarshal(raw, &loaded); err != nil {
		return s, fmt.Errorf("inbox: %s corrupt; starting empty: %w", filepath.Base(path), err)
	}
	for id, r := range loaded {
		switch {
		case id == "":
		case r.Tombstone:
			if opts.PersistTombstones {
				s.tombs[id] = r.ExpiresAt
			}
		case opts.PayloadID != nil && opts.PayloadID(r.Show) != id:
		default:
			s.entries[id] = r
		}
	}
	return s, nil
}

func (s *Store) entry(id string, r record) Entry {
	return Entry{ID: id, Source: s.opts.Source, OwnerKey: r.Owner, ScopeID: r.ScopeID, ExpiresAt: r.ExpiresAt, Payload: r.Show}
}

// Put stores (or replaces) an entry. An already expired entry or a
// tombstoned id is refused. On a failed save the entry is not kept in memory
// either, so a caller that treats the error as "not stored" never replays it.
func (s *Store) Put(e Entry, now time.Time) error {
	if e.ID == "" {
		return errors.New("inbox: entry id is required")
	}
	expires := e.ExpiresAt
	if s.opts.EntryTTL > 0 && expires.After(now.Add(s.opts.EntryTTL)) {
		expires = now.Add(s.opts.EntryTTL)
	}
	if !expires.After(now) {
		return errors.New("inbox: entry already expired")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.tombstonedLocked(e.ID, now) {
		return ErrTombstoned
	}
	s.pruneLocked(now)
	prev, had := s.entries[e.ID]
	s.entries[e.ID] = record{Show: e.Payload, ExpiresAt: expires, Owner: e.OwnerKey, ScopeID: e.ScopeID}
	evicted := s.enforceCapLocked(e.OwnerKey)
	if err := s.saveLocked(); err != nil {
		delete(s.entries, e.ID)
		if had {
			s.entries[e.ID] = prev
		}
		for id, r := range evicted {
			s.entries[id] = r
		}
		return err
	}
	return nil
}

// Get returns a live entry.
func (s *Store) Get(id string) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.entries[id]
	if !ok {
		return Entry{}, false
	}
	return s.entry(id, r), true
}

// Remove deletes a live entry (acknowledged, closed, expired) without
// tombstoning it. It reports whether the entry was live.
func (s *Store) Remove(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.entries[id]; !ok {
		return false
	}
	delete(s.entries, id)
	s.saveLogged()
	return true
}

// Retract removes a live entry, or tombstones the id when none exists, in
// one critical section so a concurrent Put cannot slip between the two. It
// reports whether a live entry was removed.
func (s *Store) Retract(id string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.entries[id]; !ok {
		s.tombstoneLocked(id, now)
		if s.opts.PersistTombstones {
			s.saveLogged()
		}
		return false
	}
	delete(s.entries, id)
	s.saveLogged()
	return true
}

// Tombstone refuses id for TombstoneTTL (and drops a live entry with that id).
func (s *Store) Tombstone(id string, now time.Time) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, live := s.entries[id]
	delete(s.entries, id)
	s.tombstoneLocked(id, now)
	if s.opts.PersistTombstones || live {
		return s.saveLocked()
	}
	return nil
}

// Tombstoned reports whether id is currently refused.
func (s *Store) Tombstoned(id string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.tombstonedLocked(id, now)
}

// TombstoneCount is the number of tombstones held (tests).
func (s *Store) TombstoneCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.tombs)
}

// PurgeScope removes every entry created under scopeID (an org move or a
// partner change: entries are purged, never re-branded). It returns how many.
func (s *Store) PurgeScope(scopeID string) int {
	if scopeID == "" {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for id, r := range s.entries {
		if r.ScopeID == scopeID {
			delete(s.entries, id)
			n++
		}
	}
	if n > 0 {
		s.saveLogged()
	}
	return n
}

// Pending prunes expired entries and returns the live ones for ownerKey,
// soonest-expiring first. Entries not yet bound to an owner (written before
// W02) are bound to ownerKey now and persisted, so they are never replayed to
// a second principal. An empty ownerKey returns every entry without binding
// (the pre-W02 view).
func (s *Store) Pending(ownerKey string, now time.Time) []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	changed := s.pruneLocked(now)
	out := make([]Entry, 0, len(s.entries))
	for id, r := range s.entries {
		switch {
		case ownerKey == "":
		case r.Owner == "":
			r.Owner = ownerKey
			s.entries[id] = r
			changed = true
		case r.Owner != ownerKey:
			continue
		}
		out = append(out, s.entry(id, r))
	}
	if changed {
		s.saveLogged()
	}
	sortEntries(out)
	return out
}

func sortEntries(out []Entry) {
	sort.Slice(out, func(i, j int) bool {
		if !out[i].ExpiresAt.Equal(out[j].ExpiresAt) {
			return out[i].ExpiresAt.Before(out[j].ExpiresAt)
		}
		return out[i].ID < out[j].ID
	})
}

func (s *Store) pruneLocked(now time.Time) bool {
	changed := false
	for id, r := range s.entries {
		if !r.ExpiresAt.After(now) {
			delete(s.entries, id)
			changed = true
		}
	}
	for id, until := range s.tombs {
		if !until.After(now) {
			delete(s.tombs, id)
			changed = changed || s.opts.PersistTombstones
		}
	}
	return changed
}

// enforceCapLocked drops owner's soonest-expiring entries beyond the cap and
// returns what it dropped (restored if the save fails).
func (s *Store) enforceCapLocked(owner string) map[string]record {
	if s.opts.MaxPerOwner <= 0 {
		return nil
	}
	var ids []string
	for id, r := range s.entries {
		if r.Owner == owner {
			ids = append(ids, id)
		}
	}
	if len(ids) <= s.opts.MaxPerOwner {
		return nil
	}
	sort.Slice(ids, func(i, j int) bool {
		a, b := s.entries[ids[i]], s.entries[ids[j]]
		if !a.ExpiresAt.Equal(b.ExpiresAt) {
			return a.ExpiresAt.Before(b.ExpiresAt)
		}
		return ids[i] < ids[j]
	})
	evicted := map[string]record{}
	for _, id := range ids[:len(ids)-s.opts.MaxPerOwner] {
		evicted[id] = s.entries[id]
		delete(s.entries, id)
	}
	return evicted
}

func (s *Store) tombstoneLocked(id string, now time.Time) {
	s.tombs[id] = now.Add(s.opts.TombstoneTTL)
	for s.opts.MaxTombstones > 0 && len(s.tombs) > s.opts.MaxTombstones {
		oldest, oldestUntil := "", time.Time{}
		for k, until := range s.tombs {
			if oldest == "" || until.Before(oldestUntil) {
				oldest, oldestUntil = k, until
			}
		}
		delete(s.tombs, oldest)
	}
}

func (s *Store) tombstonedLocked(id string, now time.Time) bool {
	until, ok := s.tombs[id]
	return ok && until.After(now)
}

// saveLogged saves and, on failure, keeps going: the in-memory state is
// authoritative for this process and the next successful save catches up.
func (s *Store) saveLogged() {
	if err := s.saveLocked(); err != nil {
		storeLog.Warn("inbox save failed", "file", filepath.Base(s.path), "error", err.Error())
	}
}

// saveLocked writes the store atomically (temp file + rename).
func (s *Store) saveLocked() error {
	if s.path == "" {
		return nil
	}
	out := make(map[string]record, len(s.entries)+len(s.tombs))
	for id, r := range s.entries {
		out[id] = r
	}
	if s.opts.PersistTombstones {
		for id, until := range s.tombs {
			if _, live := out[id]; !live {
				out[id] = record{ExpiresAt: until, Tombstone: true}
			}
		}
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, filepath.Base(s.path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	mode := s.opts.FileMode
	if mode == 0 {
		mode = 0o600
	}
	if err := tmp.Chmod(mode); err != nil {
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

// Inbox is the one notification list: endpoint messages and prompt entries.
type Inbox struct {
	Messages *Store
	Prompts  *Store
}

// ListFor is the merged list for one owner, soonest-expiring first.
func (i Inbox) ListFor(ownerKey string, now time.Time) []Entry {
	var out []Entry
	for _, s := range []*Store{i.Prompts, i.Messages} {
		if s != nil {
			out = append(out, s.Pending(ownerKey, now)...)
		}
	}
	sortEntries(out)
	return out
}
