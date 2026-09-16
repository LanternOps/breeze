package networkcontext

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/google/uuid"
)

var ErrEpochRequired = errors.New("server producer epoch required")

type Receipt struct {
	ProducerEpoch        string    `json:"producerEpoch"`
	AcceptedSequence     string    `json:"acceptedSequence"`
	ContentDigest        string    `json:"contentDigest"`
	BaseSnapshotID       string    `json:"baseSnapshotId"`
	NextFullValidationAt time.Time `json:"nextFullValidationAt"`
	Reason               string    `json:"reason,omitempty"`
}
type ProducerState struct {
	SourceIdentity       string    `json:"sourceIdentity"`
	ProducerEpoch        string    `json:"producerEpoch"`
	Sequence             uint64    `json:"sequence"`
	BaseSnapshotID       string    `json:"baseSnapshotId"`
	ContentDigest        string    `json:"contentDigest"`
	NextFullValidationAt time.Time `json:"nextFullValidationAt"`
	Pending              *Report   `json:"pending,omitempty"`
}

// State owns a private durable state file. Never reset corrupt state to sequence
// zero: obtaining a new server epoch is the only safe recovery from state loss.
type State struct {
	mu      sync.Mutex
	path    string
	data    ProducerState
	persist func(string, []byte) error
}

func OpenState(path string) (*State, error) {
	s := &State{path: path, persist: atomicStateWrite}
	b, e := os.ReadFile(path)
	if errors.Is(e, os.ErrNotExist) {
		return s, ErrEpochRequired
	}
	if e != nil {
		return nil, e
	}
	if len(b) > MaxEnvelopeBytes*2 {
		return nil, ErrMalformed
	}
	if e = json.Unmarshal(b, &s.data); e != nil {
		return nil, fmt.Errorf("producer state: %w", ErrMalformed)
	}
	if !validKey(s.data.ProducerEpoch) || !validKey(s.data.SourceIdentity) {
		return nil, ErrEpochRequired
	}
	return s, nil
}
func (s *State) save(next ProducerState) error {
	b, e := json.Marshal(next)
	if e != nil {
		return e
	}
	if e = s.persist(s.path, b); e != nil {
		return e
	}
	s.data = next
	return nil
}
func (s *State) InstallEpoch(source, epoch string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !validKey(source) || !validKey(epoch) {
		return ErrMalformed
	}
	if s.data.ProducerEpoch == epoch {
		if s.data.SourceIdentity != source {
			return ErrMalformed
		}
		return nil
	}
	return s.save(ProducerState{SourceIdentity: source, ProducerEpoch: epoch})
}
func (s *State) AllocateSequence() (uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.ProducerEpoch == "" {
		return 0, ErrEpochRequired
	}
	if s.data.Sequence == math.MaxUint64 {
		return 0, ErrEpochRequired
	}
	next := s.data
	next.Sequence++
	next.Pending = nil
	if e := s.save(next); e != nil {
		return 0, e
	}
	return next.Sequence, nil
}
func (s *State) Snapshot() ProducerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.data
	if out.Pending != nil {
		b, _ := json.Marshal(out.Pending)
		out.Pending = nil
		_ = json.Unmarshal(b, &out.Pending)
	}
	return out
}
func (s *State) StoreReport(report Report) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if report.Sequence != strconv.FormatUint(s.data.Sequence, 10) || report.ProducerEpoch != s.data.ProducerEpoch {
		return ErrMalformed
	}
	next := s.data
	next.Pending = &report
	return s.save(next)
}
func (s *State) AcceptReport(receipt Receipt) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p := s.data.Pending
	if receipt.ProducerEpoch != s.data.ProducerEpoch || p == nil || receipt.AcceptedSequence != p.Sequence {
		return errors.New("receipt does not match pending capture")
	}
	next := s.data
	if receipt.Reason == "full_snapshot_required" {
		next.BaseSnapshotID = ""
		next.ContentDigest = ""
		next.Pending = nil
		return s.save(next)
	}
	if receipt.Reason != "" {
		return fmt.Errorf("report rejected: %s", receipt.Reason)
	}
	if receipt.ContentDigest != p.ContentDigest || receipt.BaseSnapshotID == "" {
		return errors.New("receipt digest mismatch")
	}
	if p.ReportKind == "full" && receipt.BaseSnapshotID != p.SnapshotID && !(receipt.BaseSnapshotID == s.data.BaseSnapshotID && receipt.ContentDigest == s.data.ContentDigest) {
		return errors.New("receipt snapshot mismatch")
	}
	if p.ReportKind == "unchanged" && receipt.BaseSnapshotID != p.BaseSnapshotID {
		return errors.New("receipt baseline mismatch")
	}
	next.BaseSnapshotID = receipt.BaseSnapshotID
	next.ContentDigest = receipt.ContentDigest
	next.NextFullValidationAt = receipt.NextFullValidationAt
	next.Pending = nil
	return s.save(next)
}
func atomicStateWrite(path string, b []byte) error {
	dir := filepath.Dir(path)
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	f, e := os.CreateTemp(dir, ".topology-state-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e != nil {
		f.Close()
		return e
	}
	if _, e = f.Write(b); e != nil {
		f.Close()
		return e
	}
	if e = f.Sync(); e != nil {
		f.Close()
		return e
	}
	if e = f.Close(); e != nil {
		return e
	}
	if e = os.Rename(name, path); e != nil {
		return e
	}
	d, e := os.Open(dir)
	if e != nil {
		return e
	}
	defer d.Close()
	return d.Sync()
}
func appendSections[T any](dst []json.RawMessage, sections []Section[T]) ([]json.RawMessage, error) {
	for _, s := range sections {
		b, e := json.Marshal(s)
		if e != nil {
			return nil, e
		}
		dst = append(dst, b)
	}
	return dst, nil
}
func BuildReport(snapshot Snapshot, state ProducerState) (Report, error) {
	if state.Sequence == 0 || !validKey(state.ProducerEpoch) || !validKey(state.SourceIdentity) {
		return Report{}, ErrEpochRequired
	}
	manifest := snapshot.ContextManifest
	report := Report{Version: 1, ReportKind: "full", ProducerEpoch: state.ProducerEpoch, SnapshotID: uuid.NewString(), Sequence: strconv.FormatUint(state.Sequence, 10), CapturedAt: snapshot.CapturedAt.UTC().Format(time.RFC3339Nano), ExpectedIntervalSeconds: 300, Capabilities: snapshot.Capabilities, ContextManifest: &manifest, Sections: []json.RawMessage{}}
	var e error
	report.Sections, e = appendSections(report.Sections, snapshot.Interfaces)
	if e != nil {
		return Report{}, e
	}
	report.Sections, e = appendSections(report.Sections, snapshot.Routes)
	if e != nil {
		return Report{}, e
	}
	report.Sections, e = appendSections(report.Sections, snapshot.Resolvers)
	if e != nil {
		return Report{}, e
	}
	report.Sections, e = appendSections(report.Sections, snapshot.Rules)
	if e != nil {
		return Report{}, e
	}
	report.Sections, e = appendSections(report.Sections, snapshot.Neighbors)
	if e != nil {
		return Report{}, e
	}
	if e = SetDigests(&report, state.SourceIdentity); e != nil {
		return Report{}, e
	}
	if e = requireSize(report); e != nil {
		return Report{}, e
	}
	if state.BaseSnapshotID != "" && state.ContentDigest == report.ContentDigest && snapshot.CapturedAt.Before(state.NextFullValidationAt) {
		report.ReportKind = "unchanged"
		report.BaseSnapshotID = state.BaseSnapshotID
		report.Capabilities = nil
		report.ContextManifest = nil
		report.Sections = nil
	}
	return report, nil
}
