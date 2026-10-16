package heartbeat

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"math"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors/workloads"
	"github.com/breeze-rmm/agent/internal/observability"
)

const (
	// workloadsKeepalive forces a send even when nothing changed, so the API's
	// "last seen" stays fresh for hosts whose workloads are static.
	workloadsKeepalive = 6 * time.Hour
	// workloadsRetryDelay is how soon a failed send is retried (never later than
	// the normal interval).
	workloadsRetryDelay = 10 * time.Minute
)

// workloadsCollector is the heartbeat's view of workloads.Collector; tests
// substitute a fake.
type workloadsCollector interface {
	HasDrivers() bool
	Collect(ctx context.Context, s workloads.Settings) *workloads.Report
}

// workloadsRuntime owns the one inventory worker. Fields marked "mu" are
// protected by Heartbeat.mu; the hash fields belong to the worker goroutine.
type workloadsRuntime struct {
	col    workloadsCollector
	ctx    context.Context
	cancel context.CancelFunc
	wake   chan struct{}

	started    bool               // mu
	stopping   bool               // mu
	settings   workloads.Settings // mu
	generation uint64             // mu; bumped on every accepted settings change

	lastHash string    // worker only; advanced only after a 2xx
	lastSent time.Time // worker only

	// firstDelay overrides workloadsFirstDelay (tests only; zero means default).
	firstDelay time.Duration
}

// workloadsUpload carries the worker's context to sendInventoryData while
// serializing exactly as the report it wraps.
type workloadsUpload struct {
	ctx  context.Context
	data any
}

func (p workloadsUpload) MarshalJSON() ([]byte, error) { return json.Marshal(p.data) }

// workloadsSubmissionError is a non-2xx answer to PUT /agents/{id}/workloads.
type workloadsSubmissionError struct{ status int }

func (e *workloadsSubmissionError) Error() string {
	return fmt.Sprintf("inventory send failed for workloads: status %d", e.status)
}

// permanent reports a rejection that resending the same report cannot fix
// soon: a 4xx other than 401 (credentials are refreshed), 408 (timeout) and
// 429 (rate limited).
func (e *workloadsSubmissionError) permanent() bool {
	return e.status >= 400 && e.status < 500 && e.status != 401 && e.status != 408 && e.status != 429
}

func (h *Heartbeat) initWorkloads() {
	col := workloads.New(workloads.DefaultDrivers())
	if !col.HasDrivers() {
		return // this OS cannot host a workload runtime we know about
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.workloads = &workloadsRuntime{
		col: col, ctx: ctx, cancel: cancel,
		wake:     make(chan struct{}, 1),
		settings: workloads.DefaultSettings(), // Enabled=false until a policy says otherwise
	}
}

// parseWorkloadSettings reads workload_inventory_settings in snake_case or
// camelCase. `enabled` and a valid 15..1440 interval are required; a missing
// per-runtime switch defaults to true (the column default), a non-boolean one
// invalidates the payload.
func parseWorkloadSettings(raw any) (workloads.Settings, bool) {
	m, ok := raw.(map[string]any)
	if !ok {
		return workloads.Settings{}, false
	}
	enabled, ok := m["enabled"].(bool)
	if !ok {
		return workloads.Settings{}, false
	}
	pick := func(snake, camel string) (any, bool) {
		if v, exists := m[snake]; exists {
			return v, true
		}
		v, exists := m[camel]
		return v, exists
	}
	flag := func(snake, camel string) (bool, bool) {
		v, exists := pick(snake, camel)
		if !exists {
			return true, true
		}
		b, ok := v.(bool)
		return b, ok
	}
	s := workloads.Settings{Enabled: enabled}
	var okDocker, okPodman, okHyperV, okProxmox bool
	s.Docker, okDocker = flag("docker_enabled", "dockerEnabled")
	s.Podman, okPodman = flag("podman_enabled", "podmanEnabled")
	s.HyperV, okHyperV = flag("hyperv_enabled", "hypervEnabled")
	s.Proxmox, okProxmox = flag("proxmox_enabled", "proxmoxEnabled")
	if !okDocker || !okPodman || !okHyperV || !okProxmox {
		return workloads.Settings{}, false
	}
	v, exists := pick("interval_minutes", "intervalMinutes")
	if !exists {
		return workloads.Settings{}, false
	}
	var minutes int
	switch n := v.(type) {
	case int:
		minutes = n
	case float64:
		if math.IsNaN(n) || math.IsInf(n, 0) || n != math.Trunc(n) {
			return workloads.Settings{}, false
		}
		minutes = int(n)
	default:
		return workloads.Settings{}, false
	}
	if minutes < 15 || minutes > 1440 {
		return workloads.Settings{}, false
	}
	s.IntervalMinutes = minutes
	return s, true
}

// applyWorkloadInventoryConfig applies a workload_inventory_settings /
// workloadInventorySettings config update. An invalid payload is ignored and
// the previous settings stay in force. A real change bumps the generation so a
// collection already in flight is discarded, and wakes the worker.
func (h *Heartbeat) applyWorkloadInventoryConfig(raw any) {
	s, ok := parseWorkloadSettings(raw)
	if !ok {
		log.Warn("ignoring invalid workload_inventory_settings; previous settings stay in force", "payload", raw)
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.workloads
	if r == nil || r.stopping || r.settings == s {
		return
	}
	r.settings = s
	r.generation++
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

func workloadsHash(id string, last time.Time) uint64 {
	h := fnv.New64a()
	_, _ = h.Write([]byte(id + ":workloads:" + strconv.FormatInt(last.UnixNano(), 10)))
	return h.Sum64()
}

// workloadsFirstDelay keeps the first cycle off the boot path and spreads a
// fleet that booted together over a minute: 60 s plus up to 60 s.
func workloadsFirstDelay(id string) time.Duration {
	return time.Minute + time.Duration(workloadsHash(id, time.Time{})%uint64(time.Minute+1))
}

// workloadsInterval jitters the configured interval by up to ±10%,
// deterministically from the agent id and the last run.
func workloadsInterval(id string, interval time.Duration, last time.Time) time.Duration {
	offset := int64(workloadsHash(id, last)%20001) - 10000
	return interval + time.Duration(int64(interval)*offset/100000)
}

// workloadsShouldSend is the change-only rule: send the first report, any
// report whose hash differs from the last accepted one, and a keepalive.
func workloadsShouldSend(prevHash, hash string, lastSent, now time.Time) bool {
	return prevHash == "" || prevHash != hash || now.Sub(lastSent) >= workloadsKeepalive
}

func (h *Heartbeat) startWorkloads() {
	h.mu.Lock()
	r := h.workloads
	if r == nil || r.started || r.stopping {
		h.mu.Unlock()
		return
	}
	r.started = true
	h.inventoryWg.Add(1)
	h.mu.Unlock()
	go func() {
		defer h.inventoryWg.Done()
		defer observability.Recoverer("heartbeat.workloads")
		h.runWorkloads(r)
	}()
}

// stopWorkloads cancels any in-flight collection or upload and prevents new
// cycles. It must run before inventoryWg.Wait so a blocked cycle unblocks.
func (h *Heartbeat) stopWorkloads() {
	h.mu.Lock()
	r := h.workloads
	if r != nil {
		r.stopping = true
	}
	h.mu.Unlock()
	if r != nil {
		r.cancel()
	}
}

// runWorkloads is the worker loop. The first cycle waits out the first-run delay
// (60-120 s) no matter what: a settings delivery before that point only updates
// the settings the first cycle will read, so a heartbeat that carries config
// does not pull the first collection onto the boot path. After the first cycle a
// settings change wakes the loop immediately.
func (h *Heartbeat) runWorkloads(r *workloadsRuntime) {
	delay := r.firstDelay
	if delay <= 0 {
		delay = workloadsFirstDelay(h.config.AgentID)
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	firstDone := false
	for {
		select {
		case <-r.ctx.Done():
			return
		case <-timer.C:
			firstDone = true
		case <-r.wake:
			if !firstDone {
				continue // coalesced into the first run
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
		}
		if r.ctx.Err() != nil {
			return
		}
		timer.Reset(h.workloadsCycle(r, time.Now()))
	}
}

// workloadsCycle runs one collect-and-maybe-send cycle and returns how long to
// wait before the next one.
//
//   - The settings generation is read before collecting and compared after; a
//     change in between discards the result and re-runs immediately, so a report
//     made under stale settings is never sent.
//   - The hash advances only after sendInventoryData returns nil (a 2xx). A
//     failed send leaves the old hash, so the next cycle sends again.
func (h *Heartbeat) workloadsCycle(r *workloadsRuntime, now time.Time) time.Duration {
	select { // a wake that predates this cycle is already satisfied by it
	case <-r.wake:
	default:
	}
	h.mu.Lock()
	generation, settings := r.generation, r.settings
	h.mu.Unlock()
	interval := time.Duration(settings.IntervalMinutes) * time.Minute
	next := workloadsInterval(h.config.AgentID, interval, now)

	report := r.col.Collect(r.ctx, settings)
	if report == nil {
		return next
	}
	h.mu.Lock()
	changed := r.generation != generation
	h.mu.Unlock()
	if changed {
		log.Debug("workload inventory settings changed during collection; discarding result")
		return 0
	}
	hash := report.Hash()
	if !workloadsShouldSend(r.lastHash, hash, r.lastSent, now) {
		return next
	}
	if err := h.sendInventoryData("workloads", workloadsUpload{ctx: r.ctx, data: report}, "workloads"); err != nil {
		// sendInventoryData has already logged the failure and its status.
		var subErr *workloadsSubmissionError
		if errors.As(err, &subErr) && subErr.permanent() {
			// Re-sending the same report would be rejected the same way; wait
			// for the next scheduled cycle rather than re-uploading every retry.
			return next
		}
		if next > workloadsRetryDelay {
			return workloadsRetryDelay
		}
		return next
	}
	r.lastHash, r.lastSent = hash, now
	return next
}
