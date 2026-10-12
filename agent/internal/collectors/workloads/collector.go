package workloads

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
)

// DriverTimeout bounds one driver's Detect and, separately, its Collect.
const DriverTimeout = 30 * time.Second

// collectedAtLayout is RFC 3339 in UTC with millisecond precision. The API skips
// a report whose collectedAt is not newer than the stored one, so two reports in
// the same second (a settings change right after a send) must still order.
const collectedAtLayout = "2006-01-02T15:04:05.000Z"

// Collector runs every driver: Detect always, Collect only for runtimes the
// settings enable.
type Collector struct {
	drivers []Driver
	now     func() time.Time
	timeout time.Duration
}

// Option customizes a Collector (tests only).
type Option func(*Collector)

// WithClock replaces the clock used for Report.CollectedAt.
func WithClock(now func() time.Time) Option { return func(c *Collector) { c.now = now } }

// WithDriverTimeout replaces DriverTimeout.
func WithDriverTimeout(d time.Duration) Option { return func(c *Collector) { c.timeout = d } }

// New returns a Collector over drivers; pass DefaultDrivers() in production.
func New(drivers []Driver, opts ...Option) *Collector {
	c := &Collector{drivers: drivers, now: time.Now, timeout: DriverTimeout}
	for _, o := range opts {
		o(c)
	}
	return c
}

// HasDrivers reports whether this OS can host any workload runtime at all.
func (c *Collector) HasDrivers() bool { return len(c.drivers) > 0 }

// Collect produces one report. It returns nil when there are no drivers. A
// panicking driver degrades only its own runtime.
func (c *Collector) Collect(ctx context.Context, s Settings) *Report {
	if len(c.drivers) == 0 {
		return nil
	}
	report := &Report{
		ProtocolVersion: ProtocolVersion,
		CollectedAt:     c.now().UTC().Format(collectedAtLayout),
		Runtimes:        make([]RuntimeReport, 0, len(c.drivers)),
	}
	for _, d := range c.drivers {
		if ctx.Err() != nil {
			return nil
		}
		report.Runtimes = append(report.Runtimes, c.collectOne(ctx, d, s))
	}
	report.fitPayload(MaxPayloadBytes)
	return report
}

func (c *Collector) collectOne(ctx context.Context, d Driver, s Settings) RuntimeReport {
	rt := d.Runtime()
	dctx, cancel := context.WithTimeout(ctx, c.timeout)
	det, err := collectors.Guard("workloads.detect."+string(rt), func() (Detection, error) {
		return d.Detect(dctx), nil
	})
	cancel()
	if err != nil {
		det = Detection{State: DetectionUnknown, Reason: ReasonPanic}
	}
	rep := RuntimeReport{
		Runtime:        rt,
		Detection:      normalizeDetection(det.State),
		RuntimeVersion: strp(clip(det.Version, 64)),
		Workloads:      []Workload{},
	}
	switch rep.Detection {
	case DetectionAbsent:
		rep.Collection, rep.Complete = CollectionUnavailable, true
		rep.RuntimeVersion = nil
	case DetectionUnknown:
		rep.Collection = CollectionUnavailable
		rep.Error = strp(sanitizeError(det.Reason))
	default:
		if !s.RuntimeEnabled(rt) {
			rep.Collection, rep.Complete = CollectionDisabled, true
			return rep
		}
		cctx, ccancel := context.WithTimeout(ctx, c.timeout)
		res, cerr := collectors.Guard("workloads.collect."+string(rt), func() (Result, error) {
			return d.Collect(cctx, det), nil
		})
		ccancel()
		if cerr != nil {
			res = Result{Collection: CollectionError, Error: ReasonPanic}
		}
		fillFromResult(&rep, res)
	}
	return rep
}

func normalizeDetection(state string) string {
	switch state {
	case DetectionPresent, DetectionAbsent, DetectionUnknown:
		return state
	}
	return DetectionUnknown
}

func fillFromResult(rep *RuntimeReport, res Result) {
	switch res.Collection {
	case CollectionOK, CollectionUnavailable, CollectionPermissionDenied, CollectionError, CollectionUnsupported:
		rep.Collection = res.Collection
	default:
		rep.Collection, res.Error = CollectionError, "invalid_collection_state"
	}
	rep.Complete = res.Complete
	rep.Error = strp(sanitizeError(res.Error))
	if rep.Collection != CollectionOK {
		// The server ignores workloads of a failed collection; sending none keeps
		// a failed driver from ever looking like an empty host.
		return
	}
	ws := dedupeWorkloads(res.Workloads)
	rep.ObservedCount = res.ObservedCount
	if rep.ObservedCount < len(ws) {
		rep.ObservedCount = len(ws)
	}
	if len(ws) > MaxWorkloadsPerRuntime {
		ws, rep.Complete = ws[:MaxWorkloadsPerRuntime], false
	}
	rep.Workloads = make([]Workload, len(ws))
	copy(rep.Workloads, ws)
	for i := range rep.Workloads {
		rep.Workloads[i].Bound()
	}
}

// dedupeWorkloads keeps the first occurrence of each workloadId. Drivers return
// workloads in priority order, so the first one is the one worth reporting; the
// API rejects a whole report that repeats an id within a runtime.
func dedupeWorkloads(ws []Workload) []Workload {
	seen := make(map[string]struct{}, len(ws))
	out := make([]Workload, 0, len(ws))
	for _, w := range ws {
		if _, dup := seen[w.WorkloadID]; dup {
			continue
		}
		seen[w.WorkloadID] = struct{}{}
		out = append(out, w)
	}
	return out
}

func sanitizeError(s string) string {
	s = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return ' '
		}
		return r
	}, s)
	return clip(strings.TrimSpace(s), MaxErrorLen)
}

// fitPayload trims workloads until the serialized report fits maxBytes, taking
// from whichever runtime currently reports the most, and marks it incomplete.
// Workloads are already ordered most-relevant first, so the tail goes first.
func (r *Report) fitPayload(maxBytes int) {
	for {
		raw, err := json.Marshal(r)
		if err != nil || len(raw) <= maxBytes {
			return
		}
		largest := -1
		for i := range r.Runtimes {
			if len(r.Runtimes[i].Workloads) > 0 && (largest < 0 || len(r.Runtimes[i].Workloads) > len(r.Runtimes[largest].Workloads)) {
				largest = i
			}
		}
		if largest < 0 {
			return
		}
		rr := &r.Runtimes[largest]
		keep := len(rr.Workloads) * 9 / 10
		rr.Workloads = rr.Workloads[:keep:keep]
		rr.Complete = false
	}
}

// Hash is a stable digest of everything in the report except CollectedAt.
// Runtimes and workloads are sorted so driver ordering never changes it. The
// agent sends when the hash differs from the last accepted report; because the
// digest covers detection, collection, completeness, version, counts and the
// error code, any status change is a hash change.
func (r *Report) Hash() string {
	canon := Report{ProtocolVersion: r.ProtocolVersion, Runtimes: make([]RuntimeReport, len(r.Runtimes))}
	for i, rt := range r.Runtimes {
		rt.Workloads = append([]Workload(nil), rt.Workloads...)
		sort.Slice(rt.Workloads, func(a, b int) bool { return rt.Workloads[a].WorkloadID < rt.Workloads[b].WorkloadID })
		canon.Runtimes[i] = rt
	}
	sort.Slice(canon.Runtimes, func(a, b int) bool { return canon.Runtimes[a].Runtime < canon.Runtimes[b].Runtime })
	raw, _ := json.Marshal(canon)
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}
