package sim

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"time"
)

// ReportSchema identifies the run-report format W0c's perf workflow reads.
// Change it on any breaking change to the fields below.
const ReportSchema = "breeze.agentsim.report/v1"

type Report struct {
	Schema    string        `json:"schema"`
	RunID     string        `json:"runId"`
	StartedAt time.Time     `json:"startedAt"`
	EndedAt   time.Time     `json:"endedAt"`
	Target    string        `json:"target"`
	Config    ReportConfig  `json:"config"`
	Agents    AgentReport   `json:"agents"`
	Window    WindowReport  `json:"window"`
	Totals    TotalsReport  `json:"totals"`
	Routes    []RouteReport `json:"routes"`
	WS        WSReport      `json:"ws"`
	Commands  CommandReport `json:"commands"`
}

type RetryReport struct {
	MaxRetries          int     `json:"maxRetries"`
	InitialDelaySeconds float64 `json:"initialDelaySeconds"`
	MaxDelaySeconds     float64 `json:"maxDelaySeconds"`
}

type ReportConfig struct {
	Agents            int                `json:"agents"`
	RampPerSecond     float64            `json:"rampPerSecond"`
	DurationSeconds   float64            `json:"durationSeconds"`
	WarmupSeconds     float64            `json:"warmupSeconds"`
	StartMode         StartMode          `json:"startMode"`
	WSEnabled         bool               `json:"wsEnabled"`
	AgentVersion      string             `json:"agentVersion"`
	OSType            string             `json:"osType"`
	CadenceSeconds    map[string]float64 `json:"cadenceSeconds"`
	CommandsPerMinute float64            `json:"commandsPerMinute"`
	Retry             RetryReport        `json:"retry"`
}

type AgentReport struct {
	Configured         int `json:"configured"`
	Started            int `json:"started"`
	OnlineAtWindowOpen int `json:"onlineAtWindowOpen"`
	EnrolledThisRun    int `json:"enrolledThisRun"`
	ReusedFromStore    int `json:"reusedFromStore"`
	Reenrolled         int `json:"reenrolled"`
	EnrollFailures     int `json:"enrollFailures"`
}

type WindowReport struct {
	Start        time.Time `json:"start"`
	End          time.Time `json:"end"`
	Seconds      float64   `json:"seconds"`
	AgentMinutes float64   `json:"agentMinutes"`
}

type TotalsReport struct {
	Requests                       uint64  `json:"requests"`
	Attempts                       uint64  `json:"attempts"`
	AllRequests                    uint64  `json:"allRequests"`
	RequestsPerAgentMinute         float64 `json:"requestsPerAgentMinute"`
	ExpectedRequestsPerAgentMinute float64 `json:"expectedRequestsPerAgentMinute"`
	DeviationPct                   float64 `json:"deviationPct"`
	Non2xx                         uint64  `json:"non2xx"`
	TransportErrors                uint64  `json:"transportErrors"`
}

type LatencyReport struct {
	Count uint64  `json:"count"`
	P50   float64 `json:"p50"`
	P95   float64 `json:"p95"`
	P99   float64 `json:"p99"`
	Max   float64 `json:"max"`
}

type RouteReport struct {
	Route                  string         `json:"route"`
	Requests               uint64         `json:"requests"`
	Attempts               uint64         `json:"attempts"`
	PerAgentMinute         float64        `json:"perAgentMinute"`
	ExpectedPerAgentMinute float64        `json:"expectedPerAgentMinute"`
	LatencyMs              LatencyReport  `json:"latencyMs"`
	Status                 map[int]uint64 `json:"status"`
	StatusTotal            map[int]uint64 `json:"statusTotal"`
	TransportErrors        uint64         `json:"transportErrors"`
}

type WSReport struct {
	Connects             uint64            `json:"connects"`
	Reconnects           uint64            `json:"reconnects"`
	ConnectFailures      uint64            `json:"connectFailures"`
	Disconnects          uint64            `json:"disconnects"`
	ControlPingsSent     uint64            `json:"controlPingsSent"`
	ControlPongsReceived uint64            `json:"controlPongsReceived"`
	FramesReceived       map[string]uint64 `json:"framesReceived"`
	ConnectLatencyMs     LatencyReport     `json:"connectLatencyMs"`
}

type CommandReport struct {
	Dispatched       uint64            `json:"dispatched"`
	DispatchFailures uint64            `json:"dispatchFailures"`
	Received         map[string]uint64 `json:"received"`
	Duplicates       uint64            `json:"duplicates"`
	Dropped          uint64            `json:"dropped"`
	ResultsSent      map[string]uint64 `json:"resultsSent"`
}

func latencyOf(h *Histogram) LatencyReport {
	return LatencyReport{Count: h.Count(), P50: h.Quantile(0.50), P95: h.Quantile(0.95), P99: h.Quantile(0.99), Max: h.MaxMs()}
}

func copyCounts[K comparable](in map[K]uint64) map[K]uint64 {
	out := make(map[K]uint64, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

func perAgentMinute(n uint64, minutes float64) float64 {
	if minutes <= 0 {
		return 0 // never NaN: json.Marshal rejects it and the report would be lost
	}
	return float64(n) / minutes
}

// onlyNotFound is true when a route was answered and every answer was 404.
func onlyNotFound(counts map[int]uint64) bool {
	if counts[http.StatusNotFound] == 0 {
		return false
	}
	for code, c := range counts {
		if c > 0 && code != http.StatusNotFound {
			return false
		}
	}
	return true
}

type routeSnapshot struct {
	requests, attempts, transportErrors uint64
	status, statusTotal                 map[int]uint64
	latency                             LatencyReport
}

func (r *Recorder) snapshotRoutes() map[string]routeSnapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make(map[string]routeSnapshot, len(r.routes))
	for name, st := range r.routes {
		out[name] = routeSnapshot{
			requests: st.requests, attempts: st.attempts, transportErrors: st.transportErrors,
			status: copyCounts(st.status), statusTotal: copyCounts(st.statusTotal), latency: latencyOf(st.latency),
		}
	}
	return out
}

// BuildReport freezes the recorder into a report. started is how many agents
// actually began running.
func BuildReport(rec *Recorder, cfg Config, ended time.Time, started int) Report {
	routes := rec.snapshotRoutes()
	model := ExpectedPerAgentMinute(cfg.Cadence, onlyNotFound(routes[RouteCrawlConfig].statusTotal))
	minutes, onlineAtOpen := rec.agentMinutes(ended)

	windowEnd := rec.WindowClose
	if ended.Before(windowEnd) {
		windowEnd = ended
	}
	seconds := windowEnd.Sub(rec.WindowOpen).Seconds()
	if seconds < 0 {
		seconds = 0
	}

	rep := Report{
		Schema: ReportSchema, RunID: rec.RunID, StartedAt: rec.Start.UTC(), EndedAt: ended.UTC(), Target: cfg.ServerURL,
		Config: ReportConfig{
			Agents: cfg.Agents, RampPerSecond: cfg.RampPerSecond, DurationSeconds: cfg.Duration.Seconds(),
			WarmupSeconds: cfg.Warmup.Seconds(), StartMode: cfg.StartMode, WSEnabled: cfg.WSEnabled,
			AgentVersion: cfg.AgentVersion, OSType: cfg.OSType, CadenceSeconds: cfg.Cadence.Seconds(),
			CommandsPerMinute: cfg.Commander.PerMinute,
			Retry:             RetryReport{MaxRetries: cfg.Retry.MaxRetries, InitialDelaySeconds: cfg.Retry.InitialDelay.Seconds(), MaxDelaySeconds: cfg.Retry.MaxDelay.Seconds()},
		},
		Agents: AgentReport{
			Configured: cfg.Agents, Started: started, OnlineAtWindowOpen: onlineAtOpen,
			EnrolledThisRun: int(rec.enrolled.Load()), ReusedFromStore: int(rec.reused.Load()),
			Reenrolled: int(rec.reenrolled.Load()), EnrollFailures: int(rec.enrollFailed.Load()),
		},
		Window: WindowReport{Start: rec.WindowOpen.UTC(), End: windowEnd.UTC(), Seconds: seconds, AgentMinutes: minutes},
	}

	names := map[string]struct{}{}
	for n := range routes {
		names[n] = struct{}{}
	}
	for n := range model {
		names[n] = struct{}{}
	}
	sorted := make([]string, 0, len(names))
	for n := range names {
		sorted = append(sorted, n)
	}
	sort.Strings(sorted)

	var expected float64
	for _, n := range sorted {
		st := routes[n]
		exp, modelled := model[n]
		rep.Routes = append(rep.Routes, RouteReport{
			Route: n, Requests: st.requests, Attempts: st.attempts,
			PerAgentMinute: perAgentMinute(st.requests, minutes), ExpectedPerAgentMinute: exp,
			LatencyMs: st.latency, Status: st.status, StatusTotal: st.statusTotal, TransportErrors: st.transportErrors,
		})
		if modelled {
			rep.Totals.Requests += st.requests
			rep.Totals.Attempts += st.attempts
			expected += exp
		}
		if n == RouteEnroll || n == RouteWSUpgrade {
			continue // once per agent / per connection, not steady-state traffic; 101 is not an error
		}
		rep.Totals.AllRequests += st.requests
		rep.Totals.TransportErrors += st.transportErrors
		for code, c := range st.status {
			if code < 200 || code >= 300 {
				rep.Totals.Non2xx += c
			}
		}
	}
	rep.Totals.RequestsPerAgentMinute = perAgentMinute(rep.Totals.Requests, minutes)
	rep.Totals.ExpectedRequestsPerAgentMinute = expected
	if expected > 0 && minutes > 0 {
		rep.Totals.DeviationPct = (rep.Totals.RequestsPerAgentMinute - expected) / expected * 100
	}

	rec.mu.Lock()
	rep.WS = WSReport{
		Connects: rec.wsConnects.Load(), Reconnects: rec.wsReconnects.Load(), ConnectFailures: rec.wsConnectFailures.Load(),
		Disconnects: rec.wsDisconnects.Load(), ControlPingsSent: rec.wsControlPings.Load(), ControlPongsReceived: rec.wsControlPongs.Load(),
		FramesReceived: copyCounts(rec.frames), ConnectLatencyMs: latencyOf(rec.wsConnectLatency),
	}
	rep.Commands = CommandReport{
		Dispatched: rec.cmdDispatched.Load(), DispatchFailures: rec.cmdDispatchFailed.Load(),
		Received: copyCounts(rec.cmdVia), Duplicates: rec.cmdDuplicates.Load(), Dropped: rec.cmdDropped.Load(),
		ResultsSent: copyCounts(rec.resVia),
	}
	rec.mu.Unlock()
	return rep
}

// WriteReport writes r atomically (temp file + rename).
func WriteReport(path string, r Report) error {
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".report-*.json")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(append(data, '\n')); err != nil {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), path)
}
