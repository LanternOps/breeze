package heartbeat

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/netattach"
)

// netAttachReporter carries networkAttachmentsV1 on the heartbeat (learned
// networks, #12369). The OS read runs in one background goroutine at a time
// under a 3-second context, so a beat never waits for it. A report is kept
// only when its read finished inside that bound, and each kept report rides at
// most one beat. A beat may therefore carry no report, which the server reads
// as "no change" (index wire contract C1).
type netAttachReporter struct {
	mu       sync.Mutex
	open     func() (*netattach.State, error)
	build    func(context.Context, *netattach.State, string, time.Time) netattach.Report
	bound    time.Duration // longest a read may take and still be sent
	maxAge   time.Duration // a report whose read began longer ago than this before the beat is dropped
	state    *netattach.State
	inflight bool
	ready    *netattach.Report
	started  time.Time // the beat time at which the read that produced ready began
	warned   bool      // the state-open failure has been logged
	// dropWarned: a dropped read (overrun or panic) has been logged since the
	// last kept report, so a host that always overruns logs once, not per beat.
	dropWarned bool
}

func newNetAttachReporter(path string) *netAttachReporter {
	return &netAttachReporter{
		open:  func() (*netattach.State, error) { return netattach.OpenState(path) },
		build: netattach.BuildReport,
		bound: 3 * time.Second,
		// Well inside the server's capturedAt freshness window (10 minutes when
		// this was written; learned-networks plan index, E2).
		maxAge: 5 * time.Minute,
	}
}

// attach returns the finished, unsent report (or nil) and starts a read when
// none is running. It never blocks on a read.
func (r *netAttachReporter) attach(now time.Time, serverHost string, stop <-chan struct{}) *netattach.Report {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out *netattach.Report
	if r.ready != nil {
		if now.Sub(r.started) <= r.maxAge {
			out = r.ready
		}
		r.ready = nil
	}
	if r.inflight {
		return out
	}
	if r.state == nil {
		st, err := r.open()
		if err != nil {
			// Retried next beat.
			if !r.warned {
				r.warned = true
				log.Warn("network attachment state unavailable; attachment reports paused", "error", err.Error())
			}
			return out
		}
		r.state = st
	}
	r.inflight = true
	go r.read(now, serverHost, r.state, stop)
	return out
}

func (r *netAttachReporter) read(started time.Time, serverHost string, st *netattach.State, stop <-chan struct{}) {
	var report netattach.Report
	keep := false
	dropped := "" // why a read that produced no usable report is worth a log line
	var begin time.Time
	defer func() {
		if p := recover(); p != nil {
			keep = false
			dropped = "panic: " + fmt.Sprint(p)
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.inflight = false
		if keep {
			r.ready = &report
			r.started = started
			r.dropWarned = false
			return
		}
		if dropped != "" && !r.dropWarned {
			r.dropWarned = true
			log.Warn("network attachment read dropped; no report until a read succeeds",
				"reason", dropped, "elapsed", time.Since(begin).String(), "bound", r.bound.String())
		}
	}()
	ctx, cancel := context.WithTimeout(context.Background(), r.bound)
	defer cancel()
	go func() {
		select {
		case <-stop:
			cancel()
		case <-ctx.Done():
		}
	}()
	begin = time.Now()
	report = r.build(ctx, st, serverHost, begin)
	// A read that overran its bound, or ran into shutdown, is not sent; nor is
	// the zero report a state without a sequence produces (netattach logs that).
	keep = ctx.Err() == nil && time.Since(begin) <= r.bound && report.Epoch != ""
	select {
	case <-stop:
	default:
		if !keep && report.Epoch != "" {
			dropped = "read overran its bound"
		}
	}
}

// attachNetworkAttachments sets networkAttachmentsV1. A Heartbeat built
// without a reporter (tests construct &Heartbeat{} directly) sends none and
// never reads the OS or writes the data directory.
func (h *Heartbeat) attachNetworkAttachments(payload *HeartbeatPayload) {
	if h.netAttach == nil {
		return
	}
	payload.NetworkAttachmentsV1 = h.netAttach.attach(time.Now(), serverHost(h.serverURL()), h.stopChan)
}
