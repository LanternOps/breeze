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

	// timeline is nil unless a storm or --timeline asked for it; every hook
	// checks. lastOK is each agent's last successful heartbeat (under mu).
	timeline *Timeline
	lastOK   map[int]time.Time

	// Storm phases (scheduler.go). phase is "event/phase" or "" outside every
	// phase; heartbeat attempts land in that phase's histogram (latency, for
	// attempts that got a response) or transport-error count.
	phase          string
	phases         map[string]*Histogram
	phaseTransport map[string]uint64

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
		phases: map[string]*Histogram{}, phaseTransport: map[string]uint64{},
	}
}

func phaseKey(event, phase string) string { return event + "/" + phase }

// MarkPhase sets the storm phase that heartbeat observations land in from
// now on; an empty event or phase means "in no phase".
func (r *Recorder) MarkPhase(event, phase string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if event == "" || phase == "" {
		r.phase = ""
		return
	}
	r.phase = phaseKey(event, phase)
	if r.phases[r.phase] == nil {
		r.phases[r.phase] = NewHistogram()
	}
}

// PhaseLatency is the heartbeat attempt latency inside one storm phase (ms).
func (r *Recorder) PhaseLatency(event, phase string) LatencyReport {
	r.mu.Lock()
	h := r.phases[phaseKey(event, phase)]
	r.mu.Unlock()
	if h == nil {
		return LatencyReport{}
	}
	return latencyOf(h)
}

// PhaseTransportErrors is how many heartbeat attempts got no response inside
// one storm phase. Reported next to PhaseLatency, which cannot see them.
func (r *Recorder) PhaseTransportErrors(event, phase string) uint64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.phaseTransport[phaseKey(event, phase)]
}

// EnableTimeline turns on the per-step run timeline from r.Start.
func (r *Recorder) EnableTimeline(step, length time.Duration) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.timeline = NewTimeline(r.Start, step, length)
	r.lastOK = map[int]time.Time{}
}

// Timeline returns the run timeline, or nil when it is off.
func (r *Recorder) Timeline() *Timeline {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.timeline
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
	if r.timeline != nil {
		if route == RouteHeartbeat {
			r.timeline.HeartbeatAttempt(start, latency, status, err)
		} else {
			r.timeline.Attempt(start, status, err)
		}
	}
	if route == RouteHeartbeat && r.phase != "" {
		if err != nil {
			r.phaseTransport[r.phase]++
		} else {
			r.phases[r.phase].Observe(latency)
		}
	}
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

// outcomeOK is whether one logical request (after the agent's retries)
// succeeded. crawl-config 401/404 means the workspace module is off (README),
// which the real agent treats as "back off", not as a failure.
func outcomeOK(route string, status int, err error) bool {
	if err != nil {
		return false
	}
	if route == RouteCrawlConfig && (status == 401 || status == 404) {
		return true
	}
	return status < 400
}

func (r *Recorder) tl() *Timeline { return r.Timeline() }

// ObserveOutcome records one logical request's final result on the timeline.
func (r *Recorder) ObserveOutcome(route string, ts time.Time, ok bool) {
	if t := r.tl(); t != nil {
		t.Outcome(route, ts, ok)
	}
}

// HeartbeatOK records a successful heartbeat for agent index; the time since
// that agent's previous success is its heartbeat gap.
func (r *Recorder) HeartbeatOK(index int, ts time.Time) {
	r.mu.Lock()
	t := r.timeline
	if t == nil {
		r.mu.Unlock()
		return
	}
	prev, seen := r.lastOK[index]
	r.lastOK[index] = ts
	r.mu.Unlock()
	if seen {
		t.HeartbeatGap(ts, ts.Sub(prev))
	}
}

// OpenGaps is the longest time any agent has gone without a successful
// heartbeat as of end (seconds): the gaps still open when the run ends.
func (r *Recorder) OpenGaps(end time.Time) float64 {
	r.mu.Lock()
	defer r.mu.Unlock()
	var maxS float64
	for _, last := range r.lastOK {
		if g := end.Sub(last).Seconds(); g > maxS {
			maxS = g
		}
	}
	return maxS
}

// SocketUp / SocketDown move the live-socket gauge (a serve loop started or ended).
func (r *Recorder) SocketUp() {
	if t := r.tl(); t != nil {
		t.SocketUp()
	}
}

func (r *Recorder) SocketDown() {
	if t := r.tl(); t != nil {
		t.SocketDown()
	}
}

// SampleLive writes the live-socket gauge into the timeline bucket for ts.
func (r *Recorder) SampleLive(ts time.Time) {
	if t := r.tl(); t != nil {
		t.SampleLive(ts)
	}
}

func (r *Recorder) WSConnected(reconnect bool, latency time.Duration) {
	r.wsConnects.Add(1)
	if reconnect {
		r.wsReconnects.Add(1)
	}
	r.wsConnectLatency.Observe(latency)
	if t := r.tl(); t != nil {
		t.WSConnect(time.Now())
	}
}

func (r *Recorder) WSConnectFailed() {
	r.wsConnectFailures.Add(1)
	if t := r.tl(); t != nil {
		t.WSConnectFailed(time.Now())
	}
}

func (r *Recorder) WSDisconnected() {
	r.wsDisconnects.Add(1)
	if t := r.tl(); t != nil {
		t.WSDisconnect(time.Now())
	}
}
func (r *Recorder) WSControlPing() { r.wsControlPings.Add(1) }
func (r *Recorder) WSControlPong() { r.wsControlPongs.Add(1) }
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
