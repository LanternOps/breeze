package sim

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// PoolSample is one /metrics/scrape read of the API's admission-gate pool
// series (apps/api/src/services/metricsRuntime.ts). OK false means the
// sampler could not see the pool (scrape failed, or a series was missing or
// invalid): its numbers are not zeros, they are unknown.
type PoolSample struct {
	T         float64 `json:"t"` // seconds from run start
	OK        bool    `json:"ok"`
	Permits   float64 `json:"permits"`   // DB_POOL_MAX
	Effective float64 `json:"effective"` // permits minus abandoned: the usable pool
	InUse     float64 `json:"inUse"`
	Waiting   float64 `json:"waiting"`
	Abandoned float64 `json:"abandoned"`
	Wedged    float64 `json:"wedged"`          // -1 = the wedge detector has not observed yet (unknown)
	LagMaxS   float64 `json:"lagMaxS"`         // -1 = series absent
	Level     float64 `json:"level"`           // admission shed level; 0 normal; -1 = series absent
	Error     string  `json:"error,omitempty"` // why OK is false
}

// MarshalJSON writes a not-ok sample as {t, ok:false, error} only, so an
// unseen pool can never be read as zeros.
func (s PoolSample) MarshalJSON() ([]byte, error) {
	if !s.OK {
		return json.Marshal(struct {
			T     float64 `json:"t"`
			OK    bool    `json:"ok"`
			Error string  `json:"error"`
		}{s.T, false, s.Error})
	}
	type plain PoolSample
	return json.Marshal(plain(s))
}

const (
	seriesPermits   = "breeze_db_pool_admission_permits"
	seriesEffective = "breeze_db_pool_admission_effective_permits"
	seriesInUse     = "breeze_db_pool_admission_in_use"
	seriesWaiting   = "breeze_db_pool_admission_waiting"
	seriesAbandoned = "breeze_db_pool_admission_abandoned"
	seriesWedged    = "breeze_db_wedged_client_read_backends"
	seriesLag       = "breeze_nodejs_eventloop_lag_window_max_seconds"
	seriesLevel     = "breeze_admission_level"
)

var wantedSeries = map[string]bool{seriesPermits: true, seriesEffective: true, seriesInUse: true, seriesWaiting: true,
	seriesAbandoned: true, seriesWedged: true, seriesLag: true, seriesLevel: true}

// parseScrape reads the unlabelled pool series out of a Prometheus text body.
func parseScrape(text string) PoolSample {
	vals := map[string]float64{}
	sc := bufio.NewScanner(strings.NewReader(text))
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		name := line
		if i := strings.IndexAny(line, "{ "); i >= 0 {
			name = line[:i]
		}
		if !wantedSeries[name] || strings.HasPrefix(line[len(name):], "{") {
			continue // only the unlabelled series
		}
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		v, err := strconv.ParseFloat(fields[1], 64)
		if err != nil {
			continue
		}
		vals[name] = v
	}

	s := PoolSample{LagMaxS: -1, Level: -1}
	get := func(name string) (float64, bool) {
		v, ok := vals[name]
		return v, ok && !math.IsNaN(v) && !math.IsInf(v, 0)
	}
	var missing []string
	need := func(name string, dst *float64, min float64) {
		v, ok := get(name)
		if !ok || v < min {
			missing = append(missing, name)
			return
		}
		*dst = v
	}
	need(seriesPermits, &s.Permits, 1) // -1 = no request pool: invalid, never "0 in use"
	need(seriesEffective, &s.Effective, 0)
	need(seriesInUse, &s.InUse, 0)
	need(seriesWaiting, &s.Waiting, 0)
	need(seriesAbandoned, &s.Abandoned, 0)
	need(seriesWedged, &s.Wedged, -1)
	if v, ok := get(seriesLag); ok {
		s.LagMaxS = v
	}
	if v, ok := get(seriesLevel); ok {
		s.Level = v
	}
	if len(missing) > 0 {
		return PoolSample{Error: "missing or invalid: " + strings.Join(missing, ", ")}
	}
	s.OK = true
	return s
}

// PoolSampler scrapes /metrics/scrape every Interval. Every tick appends one
// sample; a failed scrape is an ok:false sample, never a gap filled with zeros.
type PoolSampler struct {
	URL      string
	Token    string // METRICS_SCRAPE_TOKEN; sent as a header only, never reported
	Interval time.Duration
	Client   *http.Client
	Start    time.Time

	mu      sync.Mutex
	samples []PoolSample
}

const scrapeTimeout = 3 * time.Second

func (p *PoolSampler) Run(ctx context.Context) {
	t := time.NewTicker(p.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s := p.scrape(ctx)
			if ctx.Err() != nil && !s.OK {
				return // cut off by the run ending: not an observation
			}
			p.mu.Lock()
			p.samples = append(p.samples, s)
			p.mu.Unlock()
		}
	}
}

func (p *PoolSampler) scrape(ctx context.Context) PoolSample {
	at := time.Now()
	fail := func(msg string) PoolSample {
		return PoolSample{T: at.Sub(p.Start).Seconds(), Error: msg}
	}
	ctx, cancel := context.WithTimeout(ctx, scrapeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
	if err != nil {
		return fail(err.Error())
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	resp, err := p.Client.Do(req)
	if err != nil {
		return fail(err.Error())
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if resp.StatusCode != http.StatusOK {
		return fail("HTTP " + strconv.Itoa(resp.StatusCode))
	}
	if err != nil {
		return fail(err.Error())
	}
	s := parseScrape(string(body))
	s.T = at.Sub(p.Start).Seconds()
	return s
}

// Samples returns a copy of every sample so far.
func (p *PoolSampler) Samples() []PoolSample {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]PoolSample(nil), p.samples...)
}
