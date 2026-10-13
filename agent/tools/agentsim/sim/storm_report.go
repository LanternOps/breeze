package sim

import (
	"math"
	"time"
)

// EventWindow is one event's measured windows, in seconds from run start:
// pre = [StartS−PreS, StartS), storm = [StartS, EndS], recovery = (EndS, EndS+RecoveryS].
type EventWindow struct {
	Name                          string
	PreS, StartS, EndS, RecoveryS float64
}

func (ev EventWindow) closeS() float64 { return ev.EndS + ev.RecoveryS }

// ReconnectCurve is how fast agent sockets came back (D4/D5). tXX are seconds
// from the event end until live sockets reach XX % of the pre-event
// baseline; null when that never happened inside the window.
type ReconnectCurve struct {
	Baseline              int64    `json:"baseline"`
	Trough                int64    `json:"trough"`
	T50S                  *float64 `json:"t50S"`
	T90S                  *float64 `json:"t90S"`
	T99S                  *float64 `json:"t99S"`
	PeakConnectsPerSecond float64  `json:"peakConnectsPerSecond"`
	Connects              uint64   `json:"connects"`
	ConnectFailures       uint64   `json:"connectFailures"`
	ReconnectSpanS        float64  `json:"reconnectSpanS"`
	PeakToMean            float64  `json:"peakToMean"`
}

// PhaseCounts is a per-phase count (heartbeat transport errors).
type PhaseCounts struct {
	Pre      uint64 `json:"pre"`
	Storm    uint64 `json:"storm"`
	Recovery uint64 `json:"recovery"`
}

// HeartbeatBlock is heartbeat attempt latency per phase (ms) with the
// transport errors that latency cannot see, and the longest gap any agent
// went without a successful heartbeat (s).
type HeartbeatBlock struct {
	Pre             LatencyReport `json:"pre"`
	Storm           LatencyReport `json:"storm"`
	Recovery        LatencyReport `json:"recovery"`
	TransportErrors PhaseCounts   `json:"transportErrors"`
	MaxGapS         float64       `json:"maxGapS"`
}

// ErrorBlock is the error budget (D6): logical requests that still failed
// after the agent's own retries, over [start, end+recovery].
type ErrorBlock struct {
	Heartbeats     uint64  `json:"heartbeats"`
	HeartbeatsLost uint64  `json:"heartbeatsLost"`
	Requests       uint64  `json:"requests"`
	RequestsLost   uint64  `json:"requestsLost"`
	LostPct        float64 `json:"lostPct"`
}

// PoolBlock is DB pool recovery (D7) over [start, end+recovery].
type PoolBlock struct {
	Samples           int      `json:"samples"`
	OKSamples         int      `json:"okSamples"`
	LongestScrapeGapS float64  `json:"longestScrapeGapS"`
	MinEffectiveRatio float64  `json:"minEffectiveRatio"`
	MaxWaiting        float64  `json:"maxWaiting"`
	MaxWedged         float64  `json:"maxWedged"`
	WedgedUnknown     int      `json:"wedgedUnknown,omitempty"` // ok samples where the wedge detector had not observed
	RecoveryS         *float64 `json:"recoveryS"`
	Note              string   `json:"note,omitempty"`
}

// StormEvent is one event's analysis.
type StormEvent struct {
	Name            string         `json:"name"`
	StartS          float64        `json:"startS"`
	EndS            float64        `json:"endS"`
	RecoveryWindowS float64        `json:"recoveryWindowS"`
	Reconnect       ReconnectCurve `json:"reconnect"`
	Heartbeat       HeartbeatBlock `json:"heartbeat"`
	Errors          ErrorBlock     `json:"errors"`
	Pool            PoolBlock      `json:"pool"`
}

// GateResult is one gate evaluated on one event. Durations are seconds.
// Value is null when the data the gate needs was never observed.
type GateResult struct {
	Gate      string   `json:"gate"`
	Event     string   `json:"event"`
	Threshold float64  `json:"threshold"`
	Value     *float64 `json:"value"`
	Pass      bool     `json:"pass"`
}

func bucketStep(b []Bucket) float64 {
	if len(b) >= 2 && b[1].T > b[0].T {
		return b[1].T - b[0].T
	}
	return 1
}

// inWindow: the bucket overlaps [StartS, close].
func inEventWindow(b Bucket, step float64, ev EventWindow) bool {
	return b.T+step > ev.StartS && b.T <= ev.closeS()
}

func reconnectCurve(buckets []Bucket, ev EventWindow) ReconnectCurve {
	var rc ReconnectCurve
	step := bucketStep(buckets)

	var preSum float64
	var preN int
	for _, b := range buckets {
		if b.T >= ev.StartS-ev.PreS && b.T+step <= ev.StartS {
			preSum += float64(b.WSLive)
			preN++
		}
	}
	if preN > 0 {
		rc.Baseline = int64(math.Round(preSum / float64(preN)))
	}

	troughIdx := -1
	for i, b := range buckets {
		if !inEventWindow(b, step, ev) {
			continue
		}
		if troughIdx < 0 || b.WSLive < rc.Trough {
			rc.Trough, troughIdx = b.WSLive, i
		}
		rc.Connects += b.WSConnects
		rc.ConnectFailures += b.WSConnectFailures
		if p := float64(b.WSConnects) / step; p > rc.PeakConnectsPerSecond {
			rc.PeakConnectsPerSecond = p
		}
	}
	if troughIdx < 0 {
		return rc // the window holds no buckets (run ended first)
	}

	threshold := func(pct float64) *float64 {
		need := int64(math.Ceil(pct * float64(rc.Baseline)))
		for i := troughIdx; i < len(buckets); i++ {
			b := buckets[i]
			if b.T > ev.closeS() {
				break
			}
			if b.T >= ev.EndS && b.WSLive >= need {
				v := b.T - ev.EndS
				return &v
			}
		}
		return nil
	}
	rc.T50S, rc.T90S, rc.T99S = threshold(0.50), threshold(0.90), threshold(0.99)

	// Spread of the reconnects after the end (W09 reads these).
	var total uint64
	for _, b := range buckets {
		if b.T >= ev.EndS && b.T <= ev.closeS() {
			total += b.WSConnects
		}
	}
	if total > 0 {
		need := uint64(math.Ceil(0.99 * float64(total)))
		first, last := -1, -1
		var cum uint64
		for i, b := range buckets {
			if b.T < ev.EndS || b.T > ev.closeS() {
				continue
			}
			if first < 0 && b.WSConnects > 0 {
				first = i
			}
			cum += b.WSConnects
			if cum >= need {
				last = i
				break
			}
		}
		rc.ReconnectSpanS = buckets[last].T - buckets[first].T
		var sum, peak uint64
		for i := first; i <= last; i++ {
			sum += buckets[i].WSConnects
			if buckets[i].WSConnects > peak {
				peak = buckets[i].WSConnects
			}
		}
		if mean := float64(sum) / float64(last-first+1); mean > 0 {
			rc.PeakToMean = float64(peak) / mean
		}
	}
	return rc
}

func heartbeatBlock(rec *Recorder, ev EventWindow, buckets []Bucket, runEndS float64) HeartbeatBlock {
	hb := HeartbeatBlock{
		Pre: rec.PhaseLatency(ev.Name, "pre"), Storm: rec.PhaseLatency(ev.Name, "storm"), Recovery: rec.PhaseLatency(ev.Name, "recovery"),
		TransportErrors: PhaseCounts{
			Pre:      rec.PhaseTransportErrors(ev.Name, "pre"),
			Storm:    rec.PhaseTransportErrors(ev.Name, "storm"),
			Recovery: rec.PhaseTransportErrors(ev.Name, "recovery"),
		},
	}
	step := bucketStep(buckets)
	for _, b := range buckets {
		if inEventWindow(b, step, ev) && b.MaxHeartbeatGapS > hb.MaxGapS {
			hb.MaxGapS = b.MaxHeartbeatGapS
		}
	}
	if ev.closeS() >= runEndS { // a gap still open when the run ended never got a closing beat
		end := rec.Start.Add(time.Duration(runEndS * float64(time.Second)))
		hb.MaxGapS = math.Max(hb.MaxGapS, rec.OpenGaps(end))
	}
	return hb
}

func errorBlock(buckets []Bucket, ev EventWindow) ErrorBlock {
	var e ErrorBlock
	step := bucketStep(buckets)
	for _, b := range buckets {
		if !inEventWindow(b, step, ev) {
			continue
		}
		e.Heartbeats += b.Heartbeats
		e.HeartbeatsLost += b.HeartbeatsLost
		e.Requests += b.Requests
		e.RequestsLost += b.RequestsLost
	}
	if e.Requests > 0 {
		e.LostPct = float64(e.RequestsLost) / float64(e.Requests) * 100
	}
	return e
}

func poolBlock(samples []PoolSample, ev EventWindow) PoolBlock {
	var p PoolBlock
	in := func(t float64) bool { return t >= ev.StartS && t <= ev.closeS() }
	first := true
	for _, s := range samples {
		if !in(s.T) {
			continue
		}
		p.Samples++
		if !s.OK {
			continue
		}
		p.OKSamples++
		ratio := s.Effective / s.Permits
		if first || ratio < p.MinEffectiveRatio {
			p.MinEffectiveRatio = ratio
		}
		first = false
		p.MaxWaiting = math.Max(p.MaxWaiting, s.Waiting)
		if s.Wedged < 0 {
			p.WedgedUnknown++
		} else {
			p.MaxWedged = math.Max(p.MaxWedged, s.Wedged)
		}
		if p.RecoveryS == nil && s.T >= ev.EndS && s.Effective >= s.Permits && s.Wedged <= 0 {
			v := s.T - ev.EndS
			p.RecoveryS = &v
		}
	}

	// Longest stretch without an ok sample that overlaps the window. Anchors
	// are ok samples; a run of failures at either end of the series is
	// measured to the first/last sample, so an API that never came back
	// still shows its gap.
	overlaps := func(a, b float64) bool { return b >= ev.StartS && a <= ev.closeS() }
	prev := -1
	for i, s := range samples {
		if !s.OK {
			continue
		}
		from := samples[0].T
		if prev >= 0 {
			from = samples[prev].T
		}
		if overlaps(from, s.T) {
			p.LongestScrapeGapS = math.Max(p.LongestScrapeGapS, s.T-from)
		}
		prev = i
	}
	if n := len(samples); n > 0 {
		from := samples[0].T
		if prev >= 0 {
			from = samples[prev].T
		}
		if to := samples[n-1].T; overlaps(from, to) {
			p.LongestScrapeGapS = math.Max(p.LongestScrapeGapS, to-from)
		}
	}
	return p
}

// evaluateGates yields one result per set gate per event. A gate whose data
// was never observed fails: an unseen pool or heartbeat is not a pass.
func evaluateGates(events []StormEvent, g Gates) []GateResult {
	var out []GateResult
	add := func(gate, event string, threshold float64, value *float64, pass bool) {
		out = append(out, GateResult{Gate: gate, Event: event, Threshold: threshold, Value: value, Pass: pass})
	}
	for _, ev := range events {
		hbSeen := ev.Heartbeat.Storm.Count+ev.Heartbeat.Recovery.Count > 0
		poolSeen := ev.Pool.OKSamples > 0
		if g.HeartbeatP95 > 0 {
			th := g.HeartbeatP95.Seconds()
			if hbSeen {
				v := math.Max(ev.Heartbeat.Storm.P95, ev.Heartbeat.Recovery.P95) / 1000
				add("heartbeat-p95", ev.Name, th, &v, v <= th)
			} else {
				add("heartbeat-p95", ev.Name, th, nil, false)
			}
		}
		if g.PoolMinRatio > 0 {
			if poolSeen {
				v := ev.Pool.MinEffectiveRatio
				add("pool-min-ratio", ev.Name, g.PoolMinRatio, &v, v >= g.PoolMinRatio)
			} else {
				add("pool-min-ratio", ev.Name, g.PoolMinRatio, nil, false)
			}
		}
		if g.PoolRecovery > 0 {
			th := g.PoolRecovery.Seconds()
			if poolSeen && ev.Pool.RecoveryS != nil {
				v := *ev.Pool.RecoveryS
				add("pool-recovery", ev.Name, th, &v, v <= th)
			} else {
				add("pool-recovery", ev.Name, th, nil, false)
			}
		}
		if g.MaxGap > 0 {
			th := g.MaxGap.Seconds()
			if hbSeen {
				v := ev.Heartbeat.MaxGapS
				add("max-gap", ev.Name, th, &v, v <= th)
			} else {
				add("max-gap", ev.Name, th, nil, false)
			}
		}
		if g.LostPct > 0 {
			v := ev.Errors.LostPct
			add("lost-pct", ev.Name, g.LostPct, &v, v <= g.LostPct)
		}
	}
	return out
}

// gateConfig renders the set gates for the report config (seconds / ratio / percent).
func (g Gates) asMap() map[string]float64 {
	m := map[string]float64{}
	if g.HeartbeatP95 > 0 {
		m["heartbeat-p95"] = g.HeartbeatP95.Seconds()
	}
	if g.PoolMinRatio > 0 {
		m["pool-min-ratio"] = g.PoolMinRatio
	}
	if g.PoolRecovery > 0 {
		m["pool-recovery"] = g.PoolRecovery.Seconds()
	}
	if g.MaxGap > 0 {
		m["max-gap"] = g.MaxGap.Seconds()
	}
	if g.LostPct > 0 {
		m["lost-pct"] = g.LostPct
	}
	if len(m) == 0 {
		return nil
	}
	return m
}

// StormInputs is what the runner hands BuildReport for a storm run.
type StormInputs struct {
	Steps   []StepRecord
	Events  []ScheduledEvent
	Samples []PoolSample
	URL     string // scrape URL, never the token
	Sampled bool   // a pool sampler ran (METRICS_SCRAPE_TOKEN was set)
}

// TimelineReport is the per-step run timeline.
type TimelineReport struct {
	StepSeconds float64  `json:"stepSeconds"`
	Buckets     []Bucket `json:"buckets"`
}

// PoolReport is every pool sample of the run.
type PoolReport struct {
	IntervalSeconds float64      `json:"intervalSeconds"`
	URL             string       `json:"url"`
	Samples         []PoolSample `json:"samples"`
}

// StormReport is the storm analysis. Pass is false when any evaluated gate
// failed; StepsFailed and EventsPlanned vs len(Events) make a fault that
// never fired visible even when no gate is set.
type StormReport struct {
	Scenario      string       `json:"scenario"`
	File          string       `json:"file,omitempty"`
	EventsPlanned int          `json:"eventsPlanned"`
	StepsFailed   int          `json:"stepsFailed"`
	Steps         []StepRecord `json:"steps"`
	Events        []StormEvent `json:"events"`
	Gates         []GateResult `json:"gates"`
	Pass          bool         `json:"pass"`
}

func buildStorm(rec *Recorder, cfg Config, ended time.Time, in *StormInputs) *StormReport {
	sr := &StormReport{Scenario: cfg.Storm.Name, File: cfg.StormPath, EventsPlanned: len(cfg.Storm.Events),
		Steps: in.Steps, Events: []StormEvent{}, Gates: []GateResult{}}
	if sr.Steps == nil {
		sr.Steps = []StepRecord{}
	}
	for _, s := range in.Steps {
		if !s.OK {
			sr.StepsFailed++
		}
	}
	var buckets []Bucket
	if t := rec.Timeline(); t != nil {
		buckets = t.Buckets()
	}
	runEndS := ended.Sub(rec.Start).Seconds()
	for _, se := range in.Events {
		end := se.End
		if end.IsZero() {
			end = ended
		}
		ev := EventWindow{Name: se.Name, PreS: se.PreWindow.Seconds(), StartS: se.Start.Sub(rec.Start).Seconds(),
			EndS: end.Sub(rec.Start).Seconds(), RecoveryS: se.Recovery.Seconds()}
		out := StormEvent{Name: ev.Name, StartS: ev.StartS, EndS: ev.EndS, RecoveryWindowS: ev.RecoveryS,
			Reconnect: reconnectCurve(buckets, ev), Heartbeat: heartbeatBlock(rec, ev, buckets, runEndS),
			Errors: errorBlock(buckets, ev)}
		if in.Sampled {
			out.Pool = poolBlock(in.Samples, ev)
			if out.Pool.Samples == 0 {
				out.Pool.Note = "no scrape landed in this window"
			}
		} else {
			out.Pool.Note = "pool not sampled: METRICS_SCRAPE_TOKEN unset"
		}
		sr.Events = append(sr.Events, out)
	}
	sr.Gates = append(sr.Gates, evaluateGates(sr.Events, cfg.Gates)...)
	sr.Pass = true
	for _, g := range sr.Gates {
		if !g.Pass {
			sr.Pass = false
		}
	}
	return sr
}
