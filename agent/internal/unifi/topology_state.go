package unifi

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// ErrTopologyEpochRequired means no server-issued producer epoch is installed.
var ErrTopologyEpochRequired = errors.New("unifi topology: server producer epoch required")

// TopologyProducerState is the per-collector durable topology state, following
// collectors/networkcontext/state.go: a private file under the agent data dir,
// replaced atomically, never silently reset to an older sequence.
type TopologyProducerState struct {
	SourceIdentity string `json:"sourceIdentity"`
	ProducerEpoch  string `json:"producerEpoch"`
	Sequence       uint64 `json:"sequence"`
	// AcknowledgedSequence/Digests record the last companion the server took
	// (HTTP 202), keyed by ResourceKey.
	AcknowledgedSequence string            `json:"acknowledgedSequence,omitempty"`
	AcknowledgedDigests  map[string]string `json:"acknowledgedDigests,omitempty"`
	// DetailCursor rotates the bounded device-detail window across polls.
	DetailCursor int `json:"detailCursor"`
}

type TopologyState struct {
	mu   sync.Mutex
	path string
	data TopologyProducerState
	// lost is set when prior state is missing or unreadable: sequences issued
	// under the same epoch may already exceed a restarted counter, so the next
	// installed epoch starts from a wall-clock floor instead of 1.
	lost bool
}

var safeCollectorID = regexp.MustCompile(`^[A-Za-z0-9-]{1,64}$`)

// topologyStatePath maps a collector id to a file inside dir; ids that are not
// plain UUID-ish tokens are hashed so they can never traverse or collide.
func topologyStatePath(dir, collectorID string) string {
	name := collectorID
	if !safeCollectorID.MatchString(collectorID) {
		sum := sha256.Sum256([]byte(collectorID))
		name = "h" + hex.EncodeToString(sum[:16])
	}
	return filepath.Join(dir, "unifi-topology-"+name+".json")
}

// OpenTopologyState loads state. A missing file is a fresh state; a corrupt
// file returns an error together with a usable (empty, recovery-flagged) handle.
func OpenTopologyState(path string) (*TopologyState, error) {
	s := &TopologyState{path: path}
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		s.lost = true
		return s, nil
	}
	if err != nil {
		s.lost = true
		return s, err
	}
	if len(b) > 1<<20 || json.Unmarshal(b, &s.data) != nil || !validKey(s.data.ProducerEpoch) || !validKey(s.data.SourceIdentity) {
		s.data = TopologyProducerState{}
		s.lost = true
		return s, fmt.Errorf("unifi topology state %s: unreadable", filepath.Base(path))
	}
	return s, nil
}

func (s *TopologyState) save(next TopologyProducerState) error {
	b, err := json.Marshal(next)
	if err != nil {
		return err
	}
	if err := atomicWriteFile(s.path, b); err != nil {
		return err
	}
	s.data = next
	return nil
}

// InstallEpoch adopts the server-issued epoch. A new epoch restarts the
// sequence and forgets acknowledged digests; the same epoch is a no-op.
func (s *TopologyState) InstallEpoch(source, epoch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validKey(source) || !validKey(epoch) {
		return ErrTopologyEpochRequired
	}
	if s.data.ProducerEpoch == epoch && s.data.SourceIdentity == source {
		return nil
	}
	next := TopologyProducerState{SourceIdentity: source, ProducerEpoch: epoch, DetailCursor: s.data.DetailCursor}
	if s.lost {
		// Unknown history under possibly the same epoch: jump past any counter
		// value it could have reached (one sequence per poll).
		next.Sequence = uint64(time.Now().UnixMilli())
	}
	if err := s.save(next); err != nil {
		return err
	}
	s.lost = false
	return nil
}

// AllocateSequence persists and returns the next sequence before collection.
func (s *TopologyState) AllocateSequence() (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.ProducerEpoch == "" || s.data.Sequence == math.MaxUint64 {
		return 0, ErrTopologyEpochRequired
	}
	next := s.data
	next.Sequence++
	if err := s.save(next); err != nil {
		return 0, err
	}
	return next.Sequence, nil
}

// Acknowledge records the digests of an accepted companion.
func (s *TopologyState) Acknowledge(sequence string, digests map[string]string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.data
	next.AcknowledgedSequence = sequence
	next.AcknowledgedDigests = make(map[string]string, len(digests))
	for k, v := range digests {
		next.AcknowledgedDigests[k] = v
	}
	return s.save(next)
}

func (s *TopologyState) SetDetailCursor(cursor int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.DetailCursor == cursor {
		return nil
	}
	next := s.data
	next.DetailCursor = cursor
	return s.save(next)
}

func (s *TopologyState) Snapshot() TopologyProducerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.data
	out.AcknowledgedDigests = make(map[string]string, len(s.data.AcknowledgedDigests))
	for k, v := range s.data.AcknowledgedDigests {
		out.AcknowledgedDigests[k] = v
	}
	return out
}

// atomicWriteFile writes a private temp file, fsyncs it and renames it over
// path (os.Rename replaces the target on Windows too).
func atomicWriteFile(path string, b []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".unifi-topology-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer func() { _ = os.Remove(name) }()
	if err := f.Chmod(0o600); err != nil {
		_ = f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(name, path); err != nil {
		return err
	}
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync() // best effort; unsupported on Windows
		_ = d.Close()
	}
	return nil
}
