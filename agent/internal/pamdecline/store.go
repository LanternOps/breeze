// Package pamdecline is the agent's durable record of what the person at the
// keyboard answered on a PAM elevation dialog (#8971).
//
// When a UAC prompt is pending technician approval, the agent shows the end
// user a dialog. If they answer Deny, let it time out, or the dialog fails,
// the agent dismisses consent.exe — but the server's request stays pending
// until it hears about it, and a technician approval that lands in that window
// used to launch the app the user had just declined. This store closes that
// race on the endpoint, whatever the server knows:
//
//   - RunPamFlow marks the request "awaiting" before it shows the dialog, and
//     flips it to "declined" before it dismisses consent.exe. Approve removes
//     the entry; it is the only answer that permits an apply.
//   - Both apply paths (pam_apply_v2 and the legacy actuate_elevation) ask
//     Check/Await first and refuse a declined request (user_declined), wait a
//     bounded time on an awaiting one (user_decision_pending on timeout), and
//     refuse everything while the file is untrusted
//     (user_decline_record_untrusted).
//   - The declined entries are also the outbox for the server withdraw:
//     Due lists those still to deliver, MarkAttempt/MarkAcked record progress.
//     An ack never clears the refusal.
//
// Writes mutate memory first and then persist (temp file, 0600, fsync,
// atomic replace, directory sync), so a persist failure still refuses in this
// process; it returns ErrPersist for the caller to log. Request IDs must be
// canonical lowercase UUIDs.
package pamdecline

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/atomicrename"
)

// Reason is why the end user's answer was not an approval. Byte-identical to
// PAM_WITHDRAW_REASONS (apps/api/src/db/schema/elevations.ts) and the
// server's elevation_requests_withdrawn_reason_chk.
type Reason string

const (
	ReasonUserDenied  Reason = "user_denied"
	ReasonUserTimeout Reason = "user_timeout"
	ReasonDialogError Reason = "dialog_error"
)

func (r Reason) valid() bool {
	switch r {
	case ReasonUserDenied, ReasonUserTimeout, ReasonDialogError:
		return true
	}
	return false
}

// State of an entry. An approved request has no entry.
type State string

const (
	// StateAwaiting: the dialog is (or was about to be) on screen.
	StateAwaiting State = "awaiting"
	// StateDeclined: the user did not approve. Final.
	StateDeclined State = "declined"
)

// Failure codes an apply path reports when Check/Await refuses.
const (
	CodeUserDeclined           = "user_declined"
	CodeUserDecisionPending    = "user_decision_pending"
	CodeDeclineRecordUntrusted = "user_decline_record_untrusted"
)

const (
	// AckedRetention keeps an entry the server has answered for this long
	// after the ack. A decline with no withdraw to send (not pending at
	// ingest) is settled at its decline time and ages out the same way.
	// Un-acked pending declines never age out.
	AckedRetention = 7 * 24 * time.Hour
	// MaxEntries bounds the file. Above it the oldest acked entries go
	// first, then the oldest overall (logged by the caller via Evicted).
	MaxEntries = 4096
	// UntrustedLoadFence is how long every apply is refused after the file
	// failed to load. It covers the server's pending TTL and a long approval
	// window many times over.
	UntrustedLoadFence = 24 * time.Hour
)

// ServerStatus values the store distinguishes: only a pending request is
// withdrawn on the server.
const serverStatusPending = "pending"

// AckOutcomeNotDelivered settles a decline the server is never told about:
// the request was not pending at ingest (auto_approved, or no status
// recorded), so there is no withdraw to send. Settling it lets the
// AckedRetention prune apply; the local refusal holds until then.
const AckOutcomeNotDelivered = "not_delivered"

// settleIfUndeliverable marks a declined, unsettled entry whose request was
// not pending at ingest as settled at its decline time. It reports whether it
// changed e.
func settleIfUndeliverable(e *Entry) bool {
	if e.State != StateDeclined || e.ServerStatus == serverStatusPending || !e.AckedAt.IsZero() {
		return false
	}
	e.AckedAt = e.DeclinedAt
	e.AckOutcome = AckOutcomeNotDelivered
	return true
}

const schemaVersion = 1

var (
	// ErrCorrupt: the file could not be decoded. It was moved to
	// <path>.corrupt and every apply is refused for UntrustedLoadFence. Also
	// wrapping ErrPersist means the fence is held in memory only (see Load).
	ErrCorrupt = errors.New("pam decline record is corrupt")
	// ErrUnreadable: the file exists but could not be read. It was left in
	// place, every apply is refused for UntrustedLoadFence in this process,
	// and the store does not write until restart.
	ErrUnreadable = errors.New("pam decline record could not be read")
	// ErrPersist: the change is in memory (and enforced) but not on disk.
	ErrPersist = errors.New("pam decline record could not be persisted")
)

var canonicalUUID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Entry is one request's recorded answer.
type Entry struct {
	RequestID string `json:"requestId"`
	State     State  `json:"state"`
	// ServerStatus is the server's ingest answer: "pending" or "auto_approved".
	ServerStatus  string    `json:"serverStatus"`
	Reason        Reason    `json:"reason,omitempty"`
	CreatedAt     time.Time `json:"createdAt"`
	DeclinedAt    time.Time `json:"declinedAt,omitempty"`
	AckedAt       time.Time `json:"ackedAt,omitempty"`
	AckOutcome    string    `json:"ackOutcome,omitempty"`
	Attempts      int       `json:"attempts"`
	NextAttemptAt time.Time `json:"nextAttemptAt,omitempty"`
}

type wireFile struct {
	SchemaVersion int `json:"schemaVersion"`
	// UntrustedUntil carries the load fence across a restart: the corrupt
	// file it was armed for has been moved aside.
	UntrustedUntil time.Time        `json:"untrustedUntil,omitempty"`
	Entries        map[string]Entry `json:"entries"`
}

// Store is safe for concurrent use.
type Store struct {
	path string
	now  func() time.Time

	// persistMu serializes mutations end to end (memory change, snapshot,
	// write), so files are written in mutation order. mu guards the maps and
	// is never held across disk I/O, so Check never waits on a write.
	persistMu sync.Mutex
	mu        sync.Mutex

	entries        map[string]*Entry
	waiters        map[string]chan struct{}
	untrustedUntil time.Time
	evicted        int
	// writeBlocked, once set by Load, refuses every write: the file on disk
	// holds state this process could not load and must not be overwritten.
	writeBlocked error

	// Test seams; nil in production.
	readFileFn func(string) ([]byte, error)
	renameFn   func(oldpath, newpath string) error
	writeFault func() error
}

// NewStore returns an empty store. path "" keeps it in memory only.
func NewStore(path string, now func() time.Time) *Store {
	if now == nil {
		now = time.Now
	}
	return &Store{path: path, now: now, entries: make(map[string]*Entry), waiters: make(map[string]chan struct{})}
}

// Path is the backing file ("" for a memory-only store).
func (s *Store) Path() string { return s.path }

// Load replaces the in-memory state with the file's. A missing file is an
// empty store. Entries still "awaiting" belong to a dialog that died with the
// previous process: they become declined/user_timeout (and due for delivery
// when pending).
//
// Load fails closed in three ways, each arming the UntrustedLoadFence:
//   - an undecodable file is moved to <path>.corrupt and the fence is written
//     to a fresh file so a restart within the window keeps refusing
//     (ErrCorrupt). If that write fails, the corrupt file is put back so the
//     next Load fences again (ErrCorrupt and ErrPersist).
//   - a corrupt file that cannot be moved aside stays where it is and this
//     store never writes over it (ErrCorrupt and ErrPersist).
//   - a file that cannot be read (access denied, EIO, a sharing violation) is
//     not corruption: it stays in place with its un-acked declines, the fence
//     holds in memory only, and this store never writes over it
//     (ErrUnreadable).
//
// A store that may not write still mutates memory and returns ErrPersist from
// every mutation, so new declines are still refused in this process.
func (s *Store) Load() error {
	if s.path == "" {
		return nil
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()

	readFile := os.ReadFile
	if s.readFileFn != nil {
		readFile = s.readFileFn
	}
	data, err := readFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	now := s.now()
	if err != nil {
		s.fenceLocked(now, fmt.Errorf("the decline record at %s could not be read at load; not rewriting it until restart", s.path))
		return fmt.Errorf("%w: %v", ErrUnreadable, err)
	}
	var wire wireFile
	if err := decode(data, &wire); err != nil {
		return s.quarantineLocked(now, err)
	}

	converted := false
	entries := make(map[string]*Entry, len(wire.Entries))
	for id, e := range wire.Entries {
		e := e
		if e.State == StateAwaiting {
			e.State = StateDeclined
			e.Reason = ReasonUserTimeout
			e.DeclinedAt = now
			converted = true
		}
		if settleIfUndeliverable(&e) {
			converted = true
		}
		entries[id] = &e
	}
	s.mu.Lock()
	s.entries = entries
	s.untrustedUntil = wire.UntrustedUntil
	snap := s.snapshotLocked()
	s.mu.Unlock()
	if converted {
		if err := s.write(snap); err != nil {
			return fmt.Errorf("%w: %v", ErrPersist, err)
		}
	}
	return nil
}

// fenceLocked empties the store and arms the fence in memory. A non-nil
// blockWrites stops every later write. Caller holds persistMu.
func (s *Store) fenceLocked(now time.Time, blockWrites error) wireFile {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries = make(map[string]*Entry)
	s.untrustedUntil = now.Add(UntrustedLoadFence)
	if blockWrites != nil {
		s.writeBlocked = blockWrites
	}
	return s.snapshotLocked()
}

// quarantineLocked moves an undecodable file to <path>.corrupt and persists
// the fence in its place. Caller holds persistMu.
func (s *Store) quarantineLocked(now time.Time, decodeErr error) error {
	rename := os.Rename
	if s.renameFn != nil {
		rename = s.renameFn
	}
	corrupt := s.path + ".corrupt"
	if err := rename(s.path, corrupt); err != nil {
		// The original stays where it is, so the next Load fences again; never
		// write the fence over it.
		s.fenceLocked(now, fmt.Errorf("the corrupt decline record at %s could not be moved aside; not rewriting it until restart", s.path))
		return fmt.Errorf("%w: %v; %w: could not move it aside: %v", ErrCorrupt, decodeErr, ErrPersist, err)
	}
	snap := s.fenceLocked(now, nil)
	if err := s.write(snap); err != nil {
		// Without this file a restart would load a clean store with no fence.
		// Put the corrupt file back so the next Load fences again.
		if rerr := rename(corrupt, s.path); rerr != nil {
			return fmt.Errorf("%w: %v; %w: fence not written (%v) and the corrupt file could not be restored (%v); a restart will not fence",
				ErrCorrupt, decodeErr, ErrPersist, err, rerr)
		}
		return fmt.Errorf("%w: %v; %w: fence not written (%v); the corrupt file was restored so a restart fences again",
			ErrCorrupt, decodeErr, ErrPersist, err)
	}
	return fmt.Errorf("%w: %v", ErrCorrupt, decodeErr)
}

func decode(data []byte, wire *wireFile) error {
	if err := json.Unmarshal(data, wire); err != nil {
		return err
	}
	if wire.SchemaVersion != schemaVersion {
		return fmt.Errorf("unsupported schema version %d", wire.SchemaVersion)
	}
	for id, e := range wire.Entries {
		if !canonicalUUID.MatchString(id) || e.RequestID != id {
			return fmt.Errorf("entry %q has a non-canonical or mismatched request id", id)
		}
		switch e.State {
		case StateAwaiting:
		case StateDeclined:
			if !e.Reason.valid() {
				return fmt.Errorf("entry %q has unknown reason %q", id, e.Reason)
			}
		default:
			return fmt.Errorf("entry %q has unknown state %q", id, e.State)
		}
	}
	return nil
}

func validID(requestID string) error {
	if !canonicalUUID.MatchString(requestID) {
		return fmt.Errorf("pamdecline: %q is not a canonical lowercase UUID", requestID)
	}
	return nil
}

// BeginAwaiting records that the dialog for requestID is about to be shown.
// On an entry that is already declined it changes nothing and reports
// alreadyDeclined, so a re-fired prompt for a declined request is never
// offered again.
func (s *Store) BeginAwaiting(requestID, serverStatus string) (alreadyDeclined bool, err error) {
	if err := validID(requestID); err != nil {
		return false, err
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	if e, ok := s.entries[requestID]; ok {
		declined := e.State == StateDeclined
		s.mu.Unlock()
		return declined, nil
	}
	s.makeRoomLocked()
	s.entries[requestID] = &Entry{RequestID: requestID, State: StateAwaiting, ServerStatus: serverStatus, CreatedAt: s.now()}
	s.waiters[requestID] = make(chan struct{})
	snap := s.snapshotLocked()
	s.mu.Unlock()
	return false, s.persist(snap)
}

// Release removes an awaiting entry whose dialog was never shown (no helper
// session), keeping today's behaviour for that request. No-op on a declined
// entry.
func (s *Store) Release(requestID string) error { return s.removeAwaiting(requestID) }

// Consent removes an awaiting entry: the user approved. No-op on a declined
// entry (Decline is first-wins and final).
func (s *Store) Consent(requestID string) error { return s.removeAwaiting(requestID) }

func (s *Store) removeAwaiting(requestID string) error {
	if err := validID(requestID); err != nil {
		return err
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	e, ok := s.entries[requestID]
	if !ok || e.State != StateAwaiting {
		s.mu.Unlock()
		return nil
	}
	delete(s.entries, requestID)
	s.wakeLocked(requestID)
	snap := s.snapshotLocked()
	s.mu.Unlock()
	return s.persist(snap)
}

// Decline records that the user did not approve requestID. An awaiting or
// absent entry becomes declined; an entry already declined keeps its first
// reason and time.
func (s *Store) Decline(requestID string, reason Reason) error {
	if err := validID(requestID); err != nil {
		return err
	}
	if !reason.valid() {
		return fmt.Errorf("pamdecline: unknown reason %q", reason)
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	now := s.now()
	e, ok := s.entries[requestID]
	switch {
	case ok && e.State == StateDeclined:
		s.mu.Unlock()
		return nil
	case ok:
		e.State = StateDeclined
		e.Reason = reason
		e.DeclinedAt = now
		settleIfUndeliverable(e)
	default:
		s.makeRoomLocked()
		e = &Entry{RequestID: requestID, State: StateDeclined, Reason: reason, CreatedAt: now, DeclinedAt: now}
		settleIfUndeliverable(e)
		s.entries[requestID] = e
	}
	s.wakeLocked(requestID)
	snap := s.snapshotLocked()
	s.mu.Unlock()
	return s.persist(snap)
}

// DeclineIfAwaiting declines requestID only while it is awaiting, and reports
// whether it did. RunPamFlow's exit path uses it so a flow that ends without
// an answer (a recovered panic, a cancelled context) never leaves a request
// that a later apply could wait on, and never touches one already resolved.
func (s *Store) DeclineIfAwaiting(requestID string, reason Reason) (bool, error) {
	if err := validID(requestID); err != nil {
		return false, err
	}
	if !reason.valid() {
		return false, fmt.Errorf("pamdecline: unknown reason %q", reason)
	}
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	e, ok := s.entries[requestID]
	if !ok || e.State != StateAwaiting {
		s.mu.Unlock()
		return false, nil
	}
	e.State = StateDeclined
	e.Reason = reason
	e.DeclinedAt = s.now()
	settleIfUndeliverable(e)
	s.wakeLocked(requestID)
	snap := s.snapshotLocked()
	s.mu.Unlock()
	return true, s.persist(snap)
}

// Check answers, without blocking, whether an apply for requestID must be
// refused, and with which failure code.
func (s *Store) Check(requestID string) (refuse bool, code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	refuse, code, _ = s.checkLocked(strings.ToLower(requestID))
	return refuse, code
}

func (s *Store) checkLocked(requestID string) (bool, string, chan struct{}) {
	if s.now().Before(s.untrustedUntil) {
		return true, CodeDeclineRecordUntrusted, nil
	}
	e, ok := s.entries[requestID]
	if !ok {
		return false, "", nil
	}
	if e.State == StateDeclined {
		return true, CodeUserDeclined, nil
	}
	return true, CodeUserDecisionPending, s.waiters[requestID]
}

// Await is Check that waits while the request is awaiting the user's answer.
// It returns when the entry resolves or ctx is done; a ctx that ends first
// refuses with user_decision_pending.
func (s *Store) Await(ctx context.Context, requestID string) (refuse bool, code string) {
	id := strings.ToLower(requestID)
	for {
		s.mu.Lock()
		refuse, code, wait := s.checkLocked(id)
		s.mu.Unlock()
		if code != CodeUserDecisionPending {
			return refuse, code
		}
		if wait == nil {
			// Awaiting without a waiter: an entry loaded from disk is never
			// awaiting, so this is unreachable. Fail closed.
			return true, CodeUserDecisionPending
		}
		select {
		case <-wait:
		case <-ctx.Done():
			return true, CodeUserDecisionPending
		}
	}
}

// Due lists the declined entries the server still has to hear about:
// pending at ingest, un-acked, and past their next attempt time. Oldest
// decline first.
func (s *Store) Due() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	var out []Entry
	for _, e := range s.entries {
		if e.State != StateDeclined || e.ServerStatus != serverStatusPending || !e.AckedAt.IsZero() {
			continue
		}
		if !e.NextAttemptAt.IsZero() && e.NextAttemptAt.After(now) {
			continue
		}
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].DeclinedAt.Before(out[j].DeclinedAt) })
	return out
}

// MarkAttempt records a delivery attempt that must be retried at next.
func (s *Store) MarkAttempt(requestID string, next time.Time) error {
	return s.mutate(requestID, func(e *Entry) {
		e.Attempts++
		e.NextAttemptAt = next
	})
}

// MarkAcked records the server's definitive answer. It never clears the
// refusal.
func (s *Store) MarkAcked(requestID, outcome string) error {
	return s.mutate(requestID, func(e *Entry) {
		e.AckedAt = s.now()
		e.AckOutcome = outcome
	})
}

func (s *Store) mutate(requestID string, fn func(*Entry)) error {
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	e, ok := s.entries[requestID]
	if !ok {
		s.mu.Unlock()
		return nil
	}
	fn(e)
	snap := s.snapshotLocked()
	s.mu.Unlock()
	return s.persist(snap)
}

// Prune drops entries acked (or settled as AckOutcomeNotDelivered) more than
// AckedRetention ago.
func (s *Store) Prune() error {
	s.persistMu.Lock()
	defer s.persistMu.Unlock()
	s.mu.Lock()
	cutoff := s.now().Add(-AckedRetention)
	changed := false
	for id, e := range s.entries {
		if !e.AckedAt.IsZero() && e.AckedAt.Before(cutoff) {
			delete(s.entries, id)
			changed = true
		}
	}
	if !changed {
		s.mu.Unlock()
		return nil
	}
	snap := s.snapshotLocked()
	s.mu.Unlock()
	return s.persist(snap)
}

// Snapshot returns a copy of every entry (diagnostics and tests).
func (s *Store) Snapshot() []Entry {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Entry, 0, len(s.entries))
	for _, e := range s.entries {
		out = append(out, *e)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RequestID < out[j].RequestID })
	return out
}

// Len is the number of entries.
func (s *Store) Len() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.entries)
}

// TakeEvicted returns how many entries the cap evicted since the last call,
// so the caller can log it loudly.
func (s *Store) TakeEvicted() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	n := s.evicted
	s.evicted = 0
	return n
}

func (s *Store) entry(requestID string) (Entry, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[requestID]
	if !ok {
		return Entry{}, false
	}
	return *e, true
}

// makeRoomLocked evicts one entry when the store is full: the oldest acked
// entry, else the oldest declined one. An awaiting entry (a dialog on screen)
// is never evicted.
func (s *Store) makeRoomLocked() {
	if len(s.entries) < MaxEntries {
		return
	}
	var victim *Entry
	for _, e := range s.entries {
		if e.AckedAt.IsZero() {
			continue
		}
		if victim == nil || e.AckedAt.Before(victim.AckedAt) {
			victim = e
		}
	}
	if victim == nil {
		for _, e := range s.entries {
			if e.State == StateAwaiting {
				continue
			}
			if victim == nil || e.CreatedAt.Before(victim.CreatedAt) {
				victim = e
			}
		}
	}
	if victim == nil {
		return
	}
	delete(s.entries, victim.RequestID)
	s.evicted++
}

func (s *Store) wakeLocked(requestID string) {
	if ch, ok := s.waiters[requestID]; ok {
		close(ch)
		delete(s.waiters, requestID)
	}
}

func (s *Store) snapshotLocked() wireFile {
	w := wireFile{SchemaVersion: schemaVersion, UntrustedUntil: s.untrustedUntil, Entries: make(map[string]Entry, len(s.entries))}
	for id, e := range s.entries {
		w.Entries[id] = *e
	}
	return w
}

func (s *Store) persist(snap wireFile) error {
	if err := s.write(snap); err != nil {
		return fmt.Errorf("%w: %v", ErrPersist, err)
	}
	return nil
}

// write atomically replaces the file with snap (desktopfence/store.go
// pattern). Caller holds persistMu.
func (s *Store) write(snap wireFile) error {
	if s.path == "" {
		return nil
	}
	if s.writeBlocked != nil {
		return s.writeBlocked
	}
	if s.writeFault != nil {
		if err := s.writeFault(); err != nil {
			return err
		}
	}
	payload, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".pam-declined-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	ok := false
	defer func() {
		_ = tmp.Close()
		if !ok {
			_ = os.Remove(name)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := atomicrename.Replace(name, s.path); err != nil {
		return err
	}
	syncDir(dir)
	ok = true
	return nil
}

// syncDir makes the rename durable on POSIX. Best effort: Windows cannot open
// a directory for sync, and NTFS journals the rename itself.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	_ = d.Sync()
	_ = d.Close()
}
