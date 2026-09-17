package networkcontext

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestStateRequiresEpochAndResumesSequence(t *testing.T) {
	path := filepath.Join(t.TempDir(), "state.json")
	s, e := OpenState(path)
	if !errors.Is(e, ErrEpochRequired) {
		t.Fatal(e)
	}
	if e = s.InstallEpoch("producer", "epoch-1"); e != nil {
		t.Fatal(e)
	}
	var wg sync.WaitGroup
	for i := 0; i < 10; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if _, e := s.AllocateSequence(); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	reopened, e := OpenState(path)
	if e != nil || reopened.Snapshot().Sequence != 10 {
		t.Fatal(e)
	}
	if e = reopened.InstallEpoch("producer", "epoch-1"); e != nil || reopened.Snapshot().Sequence != 10 {
		t.Fatal("reset existing epoch")
	}
	if e = reopened.InstallEpoch("producer", "epoch-2"); e != nil || reopened.Snapshot().Sequence != 0 {
		t.Fatal("failed rotation")
	}
}
func TestStateWriteFailureDoesNotConsumeSequence(t *testing.T) {
	s := &State{data: ProducerState{SourceIdentity: "p", ProducerEpoch: "e"}, persist: func(string, []byte) error { return os.ErrPermission }}
	if _, e := s.AllocateSequence(); e == nil || s.Snapshot().Sequence != 0 {
		t.Fatal("failed durable allocation advanced state")
	}
}
func TestCorruptStateNeverResets(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state")
	if e := os.WriteFile(p, []byte("{"), 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := OpenState(p); e == nil || errors.Is(e, ErrEpochRequired) {
		t.Fatal(e)
	}
}
func TestReceiptMustMatchPending(t *testing.T) {
	p := filepath.Join(t.TempDir(), "state")
	s, _ := OpenState(p)
	if e := s.InstallEpoch("p", "e"); e != nil {
		t.Fatal(e)
	}
	if _, e := s.AllocateSequence(); e != nil {
		t.Fatal(e)
	}
	r := Report{Version: 1, ProducerEpoch: "e", Sequence: "1", ReportKind: "full", SnapshotID: "snapshot-1", ContentDigest: "digest", ContextManifest: &Manifest{Outcome: Complete, Contexts: []Context{}}}
	if e := s.StoreReport(r); e != nil {
		t.Fatal(e)
	}
	receipt := Receipt{ProducerEpoch: "e", AcceptedSequence: "2", BaseSnapshotID: "snapshot-1", ContentDigest: "digest", NextFullValidationAt: time.Now().Add(time.Hour)}
	if e := s.AcceptReport(receipt); e == nil {
		t.Fatal("accepted wrong sequence")
	}
	receipt.AcceptedSequence = "1"
	if e := s.AcceptReport(receipt); e != nil {
		t.Fatal(e)
	}
	if s.Snapshot().ContentDigest != "digest" || s.Snapshot().Pending != nil {
		t.Fatal("receipt not committed")
	}
}
func TestSchedulerDebounceAndConcurrentAdmission(t *testing.T) {
	now := time.Unix(1000, 0)
	s := NewScheduler(func() float64 { return .5 })
	if !s.Begin(now) {
		t.Fatal("startup")
	}
	if s.Begin(now) {
		t.Fatal("concurrent")
	}
	s.Finish()
	s.Notify(now)
	if s.Begin(now.Add(9 * time.Second)) {
		t.Fatal("debounce")
	}
	if !s.Begin(now.Add(10 * time.Second)) {
		t.Fatal("event")
	}
	s.Finish()
	s.Notify(now.Add(11 * time.Second))
	if s.Begin(now.Add(22 * time.Second)) {
		t.Fatal("extra rate limit")
	}
	if !s.Begin(now.Add(71 * time.Second)) {
		t.Fatal("pending event")
	}
	s.Finish()
	if !s.Begin(now.Add(300 * time.Second)) {
		t.Fatal("periodic")
	}
}

func TestReceiptRejectionRequestsFreshFullWithoutResettingSequence(t *testing.T) {
	for _, reason := range []string{"full_snapshot_required", "invalid_capture_time"} {
		t.Run(reason, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "state")
			s, _ := OpenState(path)
			if err := s.InstallEpoch("p", "e"); err != nil {
				t.Fatal(err)
			}
			if _, err := s.AllocateSequence(); err != nil {
				t.Fatal(err)
			}
			report := Report{Version: 1, ProducerEpoch: "e", Sequence: "1", ReportKind: "unchanged", BaseSnapshotID: "base", ContentDigest: "digest"}
			if err := s.StoreReport(report); err != nil {
				t.Fatal(err)
			}
			// A reboot loses monotonic age; the exact rejected capture must be replaced.
			s, err := OpenState(path)
			if err != nil {
				t.Fatal(err)
			}
			for _, wrong := range []Receipt{{ProducerEpoch: "other", ReportSequence: "1", Reason: reason}, {ProducerEpoch: "e", ReportSequence: "0", Reason: reason}, {ProducerEpoch: "e", AcceptedSequence: "1", Reason: reason}} {
				if err := s.AcceptReport(wrong); err == nil || s.Snapshot().Pending == nil {
					t.Fatal("foreign rejection cleared capture", err)
				}
			}
			if err := s.AcceptReport(Receipt{ProducerEpoch: "e", ReportSequence: "1", Reason: reason}); err != nil {
				t.Fatal(err)
			}
			next, err := OpenState(path)
			if err != nil {
				t.Fatal(err)
			}
			state := next.Snapshot()
			if state.Pending != nil || state.Sequence != 1 || state.BaseSnapshotID != "" || state.ContentDigest != "" {
				t.Fatal(state)
			}
			if sequence, err := next.AllocateSequence(); sequence != 2 || err != nil {
				t.Fatal(sequence, err)
			}
		})
	}
}
