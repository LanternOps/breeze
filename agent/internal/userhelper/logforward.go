package userhelper

import (
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

// logRecordSender is the slice of *ipc.Conn the forwarder needs.
type logRecordSender interface {
	SendTyped(id, msgType string, payload any) error
}

// LogForwarder relays a helper's warn+ log records to the agent over IPC so
// they reach Agent Logs (#9266). It is for helpers with no log shipper of
// their own — on Windows no user-readable file carries the helper token —
// whose warnings were otherwise readable nowhere.
//
// Offer is called synchronously by the logging handler, so it never blocks
// and never logs: a full queue (no connection yet, or the agent not reading)
// drops the record and counts it. Pump drains the queue onto one connection
// and returns when that connection's Run ends or a send fails; the next Run
// starts a new Pump. The count of dropped records rides on the next record
// that is delivered.
//
// Offer applies ipc.HelperLogCap before queueing, so a helper stuck in a
// warn loop cannot crowd the IPC connection it shares with desktop
// signalling; the agent applies the same cap again per session, since it
// cannot trust this side to.
type LogForwarder struct {
	queue   chan ipc.HelperLogRecord
	dropped atomic.Uint64

	now     func() time.Time // a field so tests can freeze it
	capOnce sync.Once
	rateCap *ipc.HelperLogCap
}

// NewLogForwarder returns a forwarder queueing at most capacity records.
func NewLogForwarder(capacity int) *LogForwarder {
	if capacity <= 0 {
		capacity = 1
	}
	return &LogForwarder{queue: make(chan ipc.HelperLogRecord, capacity), now: time.Now}
}

// Offer queues e if it is warn+ and within the rate cap; it never blocks.
func (f *LogForwarder) Offer(e logging.LogEntry) {
	if lvl := e.Level; lvl != "warn" && lvl != "error" {
		return
	}
	now := f.now()
	f.capOnce.Do(func() { f.rateCap = ipc.NewHelperLogCap(now) })
	allowed, capDropped := f.rateCap.Allow(now)
	if !allowed {
		return // counted by the cap; reported on the next record it admits
	}
	if capDropped > 0 {
		f.dropped.Add(capDropped)
	}

	rec := ipc.HelperLogRecord{
		Time:      e.Timestamp,
		Level:     e.Level,
		Component: e.Component,
		Message:   e.Message,
	}
	if len(e.Fields) > 0 {
		rec.Fields = make(map[string]string, len(e.Fields))
		for k, v := range e.Fields {
			if k == logging.KeyComponent {
				continue
			}
			rec.Fields[k] = fmt.Sprint(v)
		}
	}
	rec, ok := ipc.SanitizeHelperLogRecord(rec)
	if !ok {
		return
	}
	select {
	case f.queue <- rec:
	default:
		f.dropped.Add(1)
	}
}

// Pump sends queued records on conn until done closes or a send fails.
func (f *LogForwarder) Pump(conn logRecordSender, done <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case rec := <-f.queue:
			rec.Dropped = f.dropped.Swap(0)
			if err := conn.SendTyped("", ipc.TypeHelperLog, rec); err != nil {
				// This record is lost too. No log line: anything at warn
				// here would be offered straight back to this forwarder.
				f.dropped.Add(rec.Dropped + 1)
				return
			}
		}
	}
}

// helperLogForwardQueue bounds what a helper holds while it is not connected.
const helperLogForwardQueue = 128

var activeLogForwarder atomic.Pointer[LogForwarder]

// EnableLogForwarding installs a process-wide LogForwarder as the logging
// forwarder at warn level. Every later Client.Run pumps it onto its
// connection. Call it only when the process has no log shipper, or every
// warn reaches Agent Logs twice.
func EnableLogForwarding() {
	f := NewLogForwarder(helperLogForwardQueue)
	activeLogForwarder.Store(f)
	logging.SetForwarder(slog.LevelWarn, f.Offer)
}
