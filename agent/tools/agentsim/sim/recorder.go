package sim

import (
	"sync"
	"sync/atomic"
	"time"
)

type routeStats struct {
	requests        uint64         // logical requests started in the steady window
	attempts        uint64         // first attempts + retries started in the steady window
	transportErrors uint64         // steady window
	status          map[int]uint64 // steady window, by HTTP status
	statusTotal     map[int]uint64 // whole run, by HTTP status; 0 = transport error
	latency         *Histogram     // steady window, per attempt, time to response headers
}

type span struct{ start, stop time.Time }

// Recorder accumulates everything the run report needs. Safe for concurrent use.
type Recorder struct {
	RunID       string
	Start       time.Time
	WindowOpen  time.Time
	WindowClose time.Time

	mu     sync.Mutex
	routes map[string]*routeStats
	spans  map[int]*span
	frames map[string]uint64
	cmdVia map[string]uint64
	resVia map[string]uint64

	wsConnectLatency *Histogram

	wsConnects, wsReconnects, wsConnectFailures, wsDisconnects  atomic.Uint64
	wsControlPings, wsControlPongs                              atomic.Uint64
	cmdDuplicates, cmdDropped, cmdDispatched, cmdDispatchFailed atomic.Uint64
	enrolled, reused, reenrolled, enrollFailed                  atomic.Uint64
}

func NewRecorder(runID string, start, windowOpen, windowClose time.Time) *Recorder {
	return &Recorder{
		RunID: runID, Start: start, WindowOpen: windowOpen, WindowClose: windowClose,
		routes: map[string]*routeStats{}, spans: map[int]*span{}, frames: map[string]uint64{},
		cmdVia: map[string]uint64{}, resVia: map[string]uint64{}, wsConnectLatency: NewHistogram(),
	}
}

func (r *Recorder) inWindow(t time.Time) bool {
	return !t.Before(r.WindowOpen) && t.Before(r.WindowClose)
}

// route returns the stats for name; the caller holds r.mu.
func (r *Recorder) route(name string) *routeStats {
	st, ok := r.routes[name]
	if !ok {
		st = &routeStats{status: map[int]uint64{}, statusTotal: map[int]uint64{}, latency: NewHistogram()}
		r.routes[name] = st
	}
	return st
}

// ObserveHTTP records one attempt; first marks the logical request.
func (r *Recorder) ObserveHTTP(route string, first bool, start time.Time, latency time.Duration, status int, err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	st := r.route(route)
	st.statusTotal[status]++
	if !r.inWindow(start) {
		return
	}
	st.attempts++
	if first {
		st.requests++
	}
	if err != nil {
		st.transportErrors++
		return
	}
	st.status[status]++
	st.latency.Observe(latency)
}

func (r *Recorder) AgentOnline(index int, t time.Time) {
	r.mu.Lock()
	r.spans[index] = &span{start: t}
	r.mu.Unlock()
}

func (r *Recorder) AgentOffline(index int, t time.Time) {
	r.mu.Lock()
	if s, ok := r.spans[index]; ok {
		s.stop = t
	}
	r.mu.Unlock()
}

// agentMinutes is the summed running time of every agent inside
// [WindowOpen, min(WindowClose, end)), and how many were up when it opened.
func (r *Recorder) agentMinutes(end time.Time) (float64, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	closeAt := r.WindowClose
	if end.Before(closeAt) {
		closeAt = end
	}
	var total time.Duration
	onlineAtOpen := 0
	for _, s := range r.spans {
		stop := s.stop
		if stop.IsZero() || stop.After(closeAt) {
			stop = closeAt
		}
		start := s.start
		if !start.After(r.WindowOpen) && (s.stop.IsZero() || s.stop.After(r.WindowOpen)) {
			onlineAtOpen++
		}
		if start.Before(r.WindowOpen) {
			start = r.WindowOpen
		}
		if stop.After(start) {
			total += stop.Sub(start)
		}
	}
	return total.Minutes(), onlineAtOpen
}

func (r *Recorder) WSConnected(reconnect bool, latency time.Duration) {
	r.wsConnects.Add(1)
	if reconnect {
		r.wsReconnects.Add(1)
	}
	r.wsConnectLatency.Observe(latency)
}
func (r *Recorder) WSConnectFailed() { r.wsConnectFailures.Add(1) }
func (r *Recorder) WSDisconnected()  { r.wsDisconnects.Add(1) }
func (r *Recorder) WSControlPing()   { r.wsControlPings.Add(1) }
func (r *Recorder) WSControlPong()   { r.wsControlPongs.Add(1) }
func (r *Recorder) WSFrame(kind string) {
	r.mu.Lock()
	r.frames[kind]++
	r.mu.Unlock()
}
func (r *Recorder) CommandReceived(via string) {
	r.mu.Lock()
	r.cmdVia[via]++
	r.mu.Unlock()
}
func (r *Recorder) CommandResultSent(via string) {
	r.mu.Lock()
	r.resVia[via]++
	r.mu.Unlock()
}
func (r *Recorder) CommandDuplicate() { r.cmdDuplicates.Add(1) }
func (r *Recorder) CommandDropped()   { r.cmdDropped.Add(1) }
func (r *Recorder) CommandDispatched(ok bool) {
	if ok {
		r.cmdDispatched.Add(1)
		return
	}
	r.cmdDispatchFailed.Add(1)
}
func (r *Recorder) Enrolled()     { r.enrolled.Add(1) }
func (r *Recorder) EnrollReused() { r.reused.Add(1) }
func (r *Recorder) Reenrolled()   { r.reenrolled.Add(1) }
func (r *Recorder) EnrollFailed() { r.enrollFailed.Add(1) }
