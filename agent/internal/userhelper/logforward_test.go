package userhelper

import (
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

type fakeLogSender struct {
	mu      sync.Mutex
	sent    []ipc.HelperLogRecord
	failing bool
	got     chan struct{}
}

func newFakeLogSender() *fakeLogSender {
	return &fakeLogSender{got: make(chan struct{}, 64)}
}

func (f *fakeLogSender) SendTyped(id, msgType string, payload any) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.failing {
		return errors.New("broken pipe")
	}
	if msgType != ipc.TypeHelperLog {
		return errors.New("unexpected type " + msgType)
	}
	f.sent = append(f.sent, payload.(ipc.HelperLogRecord))
	f.got <- struct{}{}
	return nil
}

func (f *fakeLogSender) records() []ipc.HelperLogRecord {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]ipc.HelperLogRecord(nil), f.sent...)
}

func (f *fakeLogSender) waitN(t *testing.T, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		select {
		case <-f.got:
		case <-time.After(2 * time.Second):
			t.Fatalf("only %d of %d records sent", i, n)
		}
	}
}

func entry(level, msg string) logging.LogEntry {
	return logging.LogEntry{
		Timestamp: time.Now(),
		Level:     level,
		Component: "userhelper",
		Message:   msg,
		Fields:    map[string]any{"component": "userhelper", "attempt": 2, "error": errors.New("boom")},
	}
}

// TestLogForwarderSendsWarnAndError: what the logging forwarder hands over is
// relayed as a TypeHelperLog record with stringified fields.
func TestLogForwarderSendsWarnAndError(t *testing.T) {
	f := NewLogForwarder(8)
	s := newFakeLogSender()
	done := make(chan struct{})
	defer close(done)
	go f.Pump(s, done)

	f.Offer(entry("warn", "WinRT toast failed; falling back to PowerShell"))
	f.Offer(entry("error", "fatal-ish"))
	s.waitN(t, 2)

	recs := s.records()
	if recs[0].Level != "warn" || recs[0].Message != "WinRT toast failed; falling back to PowerShell" {
		t.Fatalf("first record = %+v", recs[0])
	}
	if recs[0].Component != "userhelper" {
		t.Errorf("Component = %q, want userhelper", recs[0].Component)
	}
	if recs[0].Fields["attempt"] != "2" || recs[0].Fields["error"] != "boom" {
		t.Errorf("Fields = %v, want attempt=2 error=boom", recs[0].Fields)
	}
	if _, dup := recs[0].Fields["component"]; dup {
		t.Error("component duplicated into Fields")
	}
	if recs[1].Level != "error" {
		t.Errorf("second level = %q, want error", recs[1].Level)
	}
}

// TestLogForwarderFiltersBelowWarn: the level filter is enforced here too, so
// a forwarder installed at the wrong level cannot relay info lines.
func TestLogForwarderFiltersBelowWarn(t *testing.T) {
	f := NewLogForwarder(8)
	f.Offer(entry("info", "chatty"))
	f.Offer(entry("debug", "chattier"))
	f.Offer(entry("warn", "kept"))

	s := newFakeLogSender()
	done := make(chan struct{})
	defer close(done)
	go f.Pump(s, done)
	s.waitN(t, 1)

	select {
	case <-s.got:
		t.Fatalf("relayed more than the warn record: %+v", s.records())
	case <-time.After(100 * time.Millisecond):
	}
	if recs := s.records(); len(recs) != 1 || recs[0].Message != "kept" {
		t.Fatalf("records = %+v, want only the warn", recs)
	}
}

// TestLogForwarderNeverBlocksAndCountsDrops: Offer runs on the logging
// goroutine, so a full queue (no connection yet) must drop, not block, and the
// next delivered record says how many were lost.
func TestLogForwarderNeverBlocksAndCountsDrops(t *testing.T) {
	f := NewLogForwarder(2)
	offered := make(chan struct{})
	go func() {
		for i := 0; i < 5; i++ {
			f.Offer(entry("warn", "w"))
		}
		close(offered)
	}()
	select {
	case <-offered:
	case <-time.After(2 * time.Second):
		t.Fatal("Offer blocked on a full queue")
	}

	s := newFakeLogSender()
	done := make(chan struct{})
	defer close(done)
	go f.Pump(s, done)
	s.waitN(t, 2)

	f.Offer(entry("warn", "after"))
	s.waitN(t, 1)
	recs := s.records()
	var total uint64
	for _, r := range recs {
		total += r.Dropped
	}
	if total != 3 {
		t.Fatalf("reported drops = %d across %+v, want 3", total, recs)
	}
}

// TestLogForwarderPumpStopsOnSendError: a dead connection ends this pump (the
// next connection starts a new one) and the lost record is counted.
func TestLogForwarderPumpStopsOnSendError(t *testing.T) {
	f := NewLogForwarder(8)
	s := newFakeLogSender()
	s.failing = true

	f.Offer(entry("warn", "lost"))
	returned := make(chan struct{})
	go func() {
		f.Pump(s, make(chan struct{}))
		close(returned)
	}()
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("Pump kept running after a send error")
	}

	s.mu.Lock()
	s.failing = false
	s.mu.Unlock()
	done := make(chan struct{})
	defer close(done)
	go f.Pump(s, done)
	f.Offer(entry("warn", "next"))
	s.waitN(t, 1)
	if recs := s.records(); recs[0].Message != "next" || recs[0].Dropped != 1 {
		t.Fatalf("record after failed send = %+v, want message next with Dropped=1", recs[0])
	}
}

// TestLogForwarderRateCapped: a helper stuck in a warn loop must not crowd
// its IPC connection (desktop signalling shares it), so the helper applies
// the same cap the agent does before anything is queued.
func TestLogForwarderRateCapped(t *testing.T) {
	clock := time.Unix(1_700_000_000, 0)
	f := NewLogForwarder(ipc.HelperLogBurst * 4)
	f.now = func() time.Time { return clock }

	for i := 0; i < ipc.HelperLogBurst+7; i++ {
		f.Offer(entry("warn", "loop"))
	}
	if got := len(f.queue); got != ipc.HelperLogBurst {
		t.Fatalf("queued %d records, want the burst of %d", got, ipc.HelperLogBurst)
	}

	clock = clock.Add(ipc.HelperLogRefill)
	f.Offer(entry("warn", "after"))

	s := newFakeLogSender()
	done := make(chan struct{})
	defer close(done)
	go f.Pump(s, done)
	s.waitN(t, ipc.HelperLogBurst+1)

	var total uint64
	for _, r := range s.records() {
		total += r.Dropped
	}
	if total != 7 {
		t.Fatalf("reported drops = %d, want 7", total)
	}
}

// TestLogForwarderPumpStopsOnDone: the pump belongs to one Run and exits with it.
func TestLogForwarderPumpStopsOnDone(t *testing.T) {
	f := NewLogForwarder(8)
	done := make(chan struct{})
	returned := make(chan struct{})
	go func() {
		f.Pump(newFakeLogSender(), done)
		close(returned)
	}()
	close(done)
	select {
	case <-returned:
	case <-time.After(2 * time.Second):
		t.Fatal("Pump did not exit when done closed")
	}
}
