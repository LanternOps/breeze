package unifi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/observability"
)

type CollectorConfig struct {
	CollectorID         string `json:"collectorId"`
	UnifiHostID         string `json:"unifiHostId"`
	ControllerURL       string `json:"controllerUrl"`
	APIKey              string `json:"apiKey"`
	PollIntervalSeconds int    `json:"pollIntervalSeconds"`
	// Optional topology negotiation (Collection §8). The companion is attached
	// only when the server lists version 1 AND issues the epoch + source
	// identity its digests are bound to; otherwise the upload is legacy-only.
	AcceptedUnifiTopologyVersions []int  `json:"acceptedUnifiTopologyVersions,omitempty"`
	TopologyProducerEpoch         string `json:"topologyProducerEpoch,omitempty"`
	TopologySourceIdentity        string `json:"topologySourceIdentity,omitempty"`
}

// topologyVersion is the highest topology version this agent implements that
// the server advertises (spec §4.3): 2 for [1,2] (or [2]), 1 for [1], 0 for
// nothing (or only versions this agent does not implement). The advertisement
// is authoritative; v2 is never inferred from anything else.
func (c CollectorConfig) topologyVersion() int {
	v := 0
	for _, a := range c.AcceptedUnifiTopologyVersions {
		if (a == 1 || a == 2) && a > v {
			v = a
		}
	}
	return v
}

type CollectorDeps struct {
	// APIBaseURL returns the CURRENT Breeze server root, e.g.
	// https://breeze.example.com — NOT including /api/v1. It is a provider
	// (typically heartbeat.ServerURL), not a copied string, so backup-server-URL
	// promotion after failover (#2323) is visible to every request. A copied
	// cfg.ServerURL kept uploading to a dead primary for the process lifetime
	// (#2423).
	APIBaseURL func() string
	AgentID    string       // this agent's id; agent telemetry endpoints live under /api/v1/agents/<AgentID>/
	HTTP       *http.Client // authed transport to the Breeze API (agent token attached)
	Logf       func(format string, args ...any)
	// StateDir holds per-collector topology state (sequence, acknowledged
	// digests). Empty disables the topology companion.
	StateDir string
	// Wake ends an idle wait early (#7970): the heartbeat signals it when the
	// server says this device has collectors. Nil is valid: the loop then
	// relies on the idle re-check alone.
	Wake *Waker

	// schedule overrides the fetch cadence; nil means defaultFetchSchedule.
	schedule *fetchSchedule

	// Test seams (W09, #8148). now is the clock for Retry-After deferral
	// (nil = time.Now); rnd feeds the Retry-After jitter (nil = rand.Float64);
	// waitHook sees every wait the loop computes after a fetch and returns the
	// wait actually used (nil = unchanged).
	now      func() time.Time
	rnd      func() float64
	waitHook func(time.Duration) time.Duration
}

// agentBase builds the per-agent endpoint prefix the API mounts under
// (agentAuthMiddleware runs on /api/v1/agents/:id/*). The /api/v1 prefix is
// mandatory — every other agent call (heartbeat, monitoring, commands, logs)
// builds ServerURL + "/api/v1/agents/...", and the collector must match or the
// API 404s the request and the collector never leaves status=pending (#2263).
// The device is resolved from the agent token server-side; the :id in the path
// matches the existing agent routes.
//
// An unset or empty-returning APIBaseURL provider is a wiring bug, not a
// runtime condition: report it as a named error rather than dereferencing a
// nil func (which would panic the collector goroutine) or silently building a
// scheme-less relative URL that fails as a cryptic transport error forever.
func (d CollectorDeps) agentBase() (string, error) {
	if d.APIBaseURL == nil {
		return "", errors.New("unifi collector: APIBaseURL provider not set")
	}
	baseURL := d.APIBaseURL()
	if baseURL == "" {
		return "", errors.New("unifi collector: APIBaseURL provider returned an empty server URL")
	}
	return baseURL + "/api/v1/agents/" + d.AgentID, nil
}

func (d CollectorDeps) logf(format string, args ...any) {
	if d.Logf != nil {
		d.Logf(format, args...)
	}
}

// The upload DTOs match the API's camelCase ingest contract (telemetrySchema in
// routes/agents/unifiTelemetry.ts). They are deliberately separate from Device/
// Client: those decode the CONTROLLER's response, and the two vocabularies do
// not line up even where both are camelCase (the controller says macAddress /
// ipAddress / uplinkDeviceId, Breeze ingest says mac / ip / connectedDeviceId,
// and Breeze needs unifiDeviceId, which the controller calls id). Keep them
// separate — do not collapse one into the other.
type uploadDevice struct {
	UnifiDeviceID string `json:"unifiDeviceId"`
	UnifiSiteID   string `json:"unifiSiteId,omitempty"`
	Mac           string `json:"mac,omitempty"`
	Name          string `json:"name,omitempty"`
	// omitempty on the metric fields is load-bearing, not cosmetic. None of these
	// are readable from the device LIST endpoint (see Device in client.go), so
	// they are always zero today. The ingest column and the web UI both treat
	// null/absent as "not collected" (`d.numClients ?? "—"`), so sending a
	// literal 0 renders as a real measurement — the same "silent zero looks like
	// data" failure #5087 was about, one hop downstream.
	//
	// WHEN the statistics/latest fetch is implemented: omitempty can no longer
	// carry this meaning, because a genuine zero would be dropped too. Switch
	// these to pointers (nil = not collected, &0 = measured zero) at that point.
	UptimeSeconds int64           `json:"uptimeSeconds,omitempty"`
	CPUPct        float64         `json:"cpuPct,omitempty"`
	MemPct        float64         `json:"memPct,omitempty"`
	TxBytes       int64           `json:"txBytes,omitempty"`
	RxBytes       int64           `json:"rxBytes,omitempty"`
	NumClients    int             `json:"numClients,omitempty"`
	PoePorts      []PoePort       `json:"poePorts,omitempty"`
	Raw           json.RawMessage `json:"raw,omitempty"`
}

type uploadClient struct {
	Mac               string          `json:"mac"`
	UnifiSiteID       string          `json:"unifiSiteId,omitempty"`
	Hostname          string          `json:"hostname,omitempty"`
	IP                string          `json:"ip,omitempty"`
	ConnectedDeviceID string          `json:"connectedDeviceId,omitempty"`
	UplinkPortIdx     int             `json:"uplinkPortIdx"`
	IsWired           bool            `json:"isWired"`
	SSID              string          `json:"ssid,omitempty"`
	Vlan              int             `json:"vlan"`
	SignalDbm         int             `json:"signalDbm"`
	TxBytes           int64           `json:"txBytes"`
	RxBytes           int64           `json:"rxBytes"`
	UptimeSeconds     int64           `json:"uptimeSeconds"`
	Raw               json.RawMessage `json:"raw,omitempty"`
}

type uploadSite struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
}

type telemetryPayload struct {
	CollectorID string         `json:"collectorId"`
	PolledAt    string         `json:"polledAt"`
	FirmwareOK  bool           `json:"firmwareOk"`
	Devices     []uploadDevice `json:"devices"`
	Clients     []uploadClient `json:"clients"`
	Sites       []uploadSite   `json:"sites,omitempty"`
	Error       string         `json:"error,omitempty"`
	// TopologyV1 is the additive typed companion; absent unless negotiated.
	TopologyV1 *TopologyV1 `json:"topologyV1,omitempty"`
	// TopologyV2 is the Wi-Fi companion (spec §4.2). At most ONE of TopologyV1 /
	// TopologyV2 is ever set per poll; it carries no second channel for Wi-Fi
	// metrics (the legacy body shape above is unchanged).
	TopologyV2 *TopologyV2 `json:"topologyV2,omitempty"`
}

func toUploadDevices(in []Device) []uploadDevice {
	out := make([]uploadDevice, len(in))
	for i, d := range in {
		out[i] = uploadDevice{
			UnifiDeviceID: d.ID, UnifiSiteID: d.SiteID, Mac: d.Mac, Name: d.Name,
			UptimeSeconds: d.UptimeSeconds, CPUPct: d.CPUPct, MemPct: d.MemPct,
			TxBytes: d.TxBytes, RxBytes: d.RxBytes, NumClients: d.NumClients,
			PoePorts: d.PoePorts, Raw: d.Raw,
		}
	}
	return out
}

func toUploadClients(in []Client) []uploadClient {
	out := make([]uploadClient, len(in))
	for i, cl := range in {
		out[i] = uploadClient{
			Mac: cl.Mac, UnifiSiteID: cl.SiteID, Hostname: cl.Hostname, IP: cl.IP,
			ConnectedDeviceID: cl.ConnectedDeviceID, UplinkPortIdx: cl.UplinkPortIdx, IsWired: cl.IsWired(),
			SSID: cl.SSID, Vlan: cl.Vlan, SignalDbm: cl.SignalDbm,
			TxBytes: cl.TxBytes, RxBytes: cl.RxBytes, UptimeSeconds: cl.UptimeSeconds, Raw: cl.Raw,
		}
	}
	return out
}

// RunOnce polls one controller and uploads the snapshot. controllerHTTP may be nil
// (DefaultHTTPClient is used). Returns an error only on upload failure; controller-side
// failures are reported in the payload (FirmwareOK / Error).
func RunOnce(ctx context.Context, deps CollectorDeps, cfg CollectorConfig, controllerHTTP *http.Client) error {
	api := NewAPIClient(cfg.ControllerURL, cfg.APIKey, controllerHTTP)
	topo := prepareTopology(deps, cfg)
	opts := PollOptions{}
	var statsPlan StatisticsPlan
	if topo != nil {
		opts = PollOptions{DetailBudget: MaxDetailsPerPoll, DetailCursor: topo.state.Snapshot().DetailCursor}
		if topo.version == 2 {
			// §6.3: the budget uses the scheduling interval BEFORE the envelope's
			// 60 s clamp, and is bounded by the persisted token bucket.
			statsPlan = topo.state.PlanStatistics(time.Now(), maxInt(cfg.PollIntervalSeconds, 15))
			opts.Wifi, opts.StatisticsBudget, opts.StatisticsCursor = true, statsPlan.Budget, statsPlan.Cursor
		}
	}
	capturedAt := time.Now()
	snap, pollErr := api.PollWith(ctx, opts)
	sites := make([]uploadSite, len(snap.Sites))
	for i, s := range snap.Sites {
		sites[i] = uploadSite{ID: s.ID, Name: s.Name}
	}
	payload := telemetryPayload{
		CollectorID: cfg.CollectorID,
		PolledAt:    time.Now().UTC().Format(time.RFC3339),
		FirmwareOK:  snap.FirmwareOK,
		Devices:     toUploadDevices(snap.Devices),
		Clients:     toUploadClients(snap.Clients),
		Sites:       sites,
	}
	if pollErr != nil {
		payload.Error = pollErr.Error()
	}
	if topo != nil {
		if err := topo.state.SetDetailCursor(snap.NextDetailCursor); err != nil {
			deps.logf("[unifi] collector %s: topology state: %v", cfg.CollectorID, err)
		}
		if topo.version == 2 {
			if err := topo.state.CommitStatistics(statsPlan, snap.StatisticsAttempted, snap.NextStatisticsCursor); err != nil {
				deps.logf("[unifi] collector %s: topology state: %v", cfg.CollectorID, err)
			}
			if snap.DroppedCapabilityValues > 0 {
				// Bounded reason code only: never the raw controller text (§5.1).
				deps.logf("[unifi] collector %s: dropped %d undocumented capability values (reason=%s)", cfg.CollectorID, snap.DroppedCapabilityValues, reasonCapabilityValueDropped)
			}
			payload.TopologyV2 = topo.buildV2(deps, cfg, snap, capturedAt)
		} else {
			payload.TopologyV1 = topo.build(deps, cfg, snap, capturedAt)
		}
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	base, err := deps.agentBase()
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/unifi-telemetry", bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := deps.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusAccepted {
		return deps.statusError("telemetry upload", resp)
	}
	var sentSeq string
	sent := map[string]string{}
	switch {
	case payload.TopologyV1 != nil:
		sentSeq = payload.TopologyV1.Sequence
		for _, r := range payload.TopologyV1.Resources {
			sent[ResourceKey(r)] = r.ContentDigest
		}
	case payload.TopologyV2 != nil:
		sentSeq = payload.TopologyV2.Sequence
		for _, r := range payload.TopologyV2.Resources {
			sent[ResourceKeyV2(r)] = r.ContentDigest
		}
	}
	if sentSeq != "" {
		digests, reason := acceptedTopologyDigests(resp.Body, sentSeq, sent)
		if len(digests) == 0 {
			deps.logf("[unifi] collector %s: topology sequence %s not acknowledged: %s", cfg.CollectorID, sentSeq, reason)
		} else if err := topo.state.Acknowledge(sentSeq, digests); err != nil {
			deps.logf("[unifi] collector %s: topology state: %v", cfg.CollectorID, err)
		}
	}
	return nil
}

// maxTelemetryResponseBytes bounds the receipt body read (≤256 resources).
const maxTelemetryResponseBytes = 1 << 20

// telemetryResponse is the API's 202 body; `topology` is present only when the
// upload carried a companion (routes/agents/unifiTelemetry.ts).
type telemetryResponse struct {
	Topology *struct {
		Accepted       bool   `json:"accepted"`
		ReportSequence string `json:"reportSequence"`
		Reason         string `json:"reason"`
		Resources      []struct {
			ControllerSiteID string `json:"controllerSiteId"`
			Kind             string `json:"kind"`
			Accepted         bool   `json:"accepted"`
			ContentDigest    string `json:"contentDigest"`
			Reason           string `json:"reason"`
		} `json:"resources"`
	} `json:"topology"`
}

// acceptedTopologyDigests returns the resource digests the server's receipts
// accepted for exactly this report: same sequence, accepted, and the receipt
// digest equal to the digest that was sent. HTTP 202 alone acknowledges nothing
// (an older server that returns no receipts leaves the collector legacy-only).
func acceptedTopologyDigests(body io.Reader, sentSequence string, sentDigests map[string]string) (map[string]string, string) {
	var out telemetryResponse
	if err := json.NewDecoder(io.LimitReader(body, maxTelemetryResponseBytes)).Decode(&out); err != nil {
		return nil, "no receipts in response"
	}
	if out.Topology == nil {
		return nil, "no receipts in response"
	}
	if out.Topology.ReportSequence != sentSequence {
		return nil, "receipts name another sequence"
	}
	digests := make(map[string]string)
	for _, r := range out.Topology.Resources {
		key := ResourceKey(Resource{ControllerSiteID: r.ControllerSiteID, Kind: r.Kind})
		if want, ok := sentDigests[key]; ok && r.Accepted && r.ContentDigest == want {
			digests[key] = want
		}
	}
	if len(digests) == 0 {
		if out.Topology.Reason != "" {
			return nil, out.Topology.Reason
		}
		return nil, "no resource accepted"
	}
	return digests, ""
}

type topologyRun struct {
	state    *TopologyState
	sequence uint64
	version  int // negotiated: 1 or 2 (CollectorConfig.topologyVersion)
}

// prepareTopology opens state, installs the server epoch and allocates the
// sequence BEFORE collection. Any failure degrades to the legacy-only upload.
func prepareTopology(deps CollectorDeps, cfg CollectorConfig) *topologyRun {
	if cfg.topologyVersion() == 0 {
		return nil
	}
	if deps.StateDir == "" || !validKey(cfg.TopologyProducerEpoch) || !validKey(cfg.TopologySourceIdentity) {
		deps.logf("[unifi] collector %s: topology advertised without epoch/source identity/state dir; sending legacy telemetry only", cfg.CollectorID)
		return nil
	}
	st, err := OpenTopologyState(topologyStatePath(deps.StateDir, cfg.CollectorID))
	if err != nil {
		// Recovery-flagged handle: the epoch install below jumps the sequence.
		deps.logf("[unifi] collector %s: %v; restarting topology sequence from a time floor", cfg.CollectorID, err)
	}
	if err := st.InstallEpoch(cfg.TopologySourceIdentity, cfg.TopologyProducerEpoch); err != nil {
		deps.logf("[unifi] collector %s: topology epoch: %v", cfg.CollectorID, err)
		return nil
	}
	seq, err := st.AllocateSequence()
	if err != nil {
		deps.logf("[unifi] collector %s: topology sequence: %v", cfg.CollectorID, err)
		return nil
	}
	return &topologyRun{state: st, sequence: seq, version: cfg.topologyVersion()}
}

func (t *topologyRun) build(deps CollectorDeps, cfg CollectorConfig, snap Snapshot, capturedAt time.Time) *TopologyV1 {
	if !snap.FirmwareOK {
		return nil
	}
	report, err := BuildTopologyV1(snap, TopologyIdentity{SourceIdentity: cfg.TopologySourceIdentity, ProducerEpoch: cfg.TopologyProducerEpoch},
		t.sequence, capturedAt, time.Now(), maxInt(cfg.PollIntervalSeconds, 15))
	if err == nil {
		var b []byte
		if b, err = json.Marshal(report); err == nil && len(b) > UnifiTopologyV1MaxBytes {
			err = fmt.Errorf("companion is %d bytes (limit %d)", len(b), UnifiTopologyV1MaxBytes)
		}
	}
	if err != nil {
		deps.logf("[unifi] collector %s: topology v1 omitted: %v", cfg.CollectorID, err)
		return nil
	}
	return report
}

func (t *topologyRun) buildV2(deps CollectorDeps, cfg CollectorConfig, snap Snapshot, capturedAt time.Time) *TopologyV2 {
	if !snap.FirmwareOK {
		return nil
	}
	report, err := BuildTopologyV2(snap, TopologyIdentity{SourceIdentity: cfg.TopologySourceIdentity, ProducerEpoch: cfg.TopologyProducerEpoch},
		t.sequence, capturedAt, time.Now(), maxInt(cfg.PollIntervalSeconds, 15))
	if err == nil {
		var b []byte
		if b, err = json.Marshal(report); err == nil && len(b) > UnifiTopologyV2MaxBytes {
			err = fmt.Errorf("companion is %d bytes (limit %d)", len(b), UnifiTopologyV2MaxBytes)
		}
	}
	if err != nil {
		deps.logf("[unifi] collector %s: topology v2 omitted: %v", cfg.CollectorID, err)
		return nil
	}
	return report
}

// StartCollectorLoop fetches this agent's collector configs from
// GET /api/v1/agents/:id/unifi-collectors and runs each due collector. It
// fetches every ActiveFetchInterval while collectors are assigned and backs off
// to a jittered IdleFetchInterval after an empty list; deps.Wake ends an idle
// wait early (collector_schedule.go, #7970). It spawns its own goroutine and
// returns a channel that closes once the loop has exited (after ctx is
// cancelled), so shutdownAgent can wait for a clean teardown instead of
// leaking the loop across in-process restarts.
func StartCollectorLoop(ctx context.Context, deps CollectorDeps) <-chan struct{} {
	sched := defaultFetchSchedule
	if deps.schedule != nil {
		sched = *deps.schedule
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		// A panic in this loop must not take the whole agent down with it —
		// the sibling workspaceindex loop has carried this guard since it
		// shipped; the collector never did.
		defer observability.Recoverer("unifi.collector")
		timer := time.NewTimer(sched.first)
		defer timer.Stop()
		lastRun := map[string]time.Time{}
		// notBefore: collectors whose telemetry POST was told to back off
		// (429/503 + Retry-After). They are skipped (not run, not polled)
		// until the clock passes the mark; the config fetch keeps its own
		// cadence.
		notBefore := map[string]time.Time{}
		// fetchRetryAt: the config route asked us to hold off until then. A
		// Wake must not fetch before it.
		var fetchRetryAt time.Time
		// idle: the last successful fetch returned no collectors. A failed
		// fetch keeps the current cadence, as the fixed ticker did.
		idle := false
		var lastFetch time.Time
		for {
			select {
			case <-ctx.Done():
				return
			case <-deps.Wake.C():
				// Only an idle loop gains anything; an active one fetches
				// within ActiveFetchInterval anyway.
				if !idle || time.Since(lastFetch) < sched.wakeGap {
					continue
				}
				if deps.clock().Before(fetchRetryAt) {
					continue
				}
				timer.Stop()
			case <-timer.C:
			}
			configs, err := fetchConfigs(ctx, deps)
			lastFetch = time.Now()
			fetchRetryAt = time.Time{}
			if err != nil {
				deps.logf("[unifi] fetch configs: %v", err)
				if at, ok := httputil.RetryAtFrom(err); ok {
					fetchRetryAt = at
				}
			} else {
				idle = len(configs) == 0
				now := deps.clock()
				for _, cfg := range configs {
					interval := time.Duration(maxInt(cfg.PollIntervalSeconds, 15)) * time.Second
					if last, ok := lastRun[cfg.CollectorID]; ok && now.Sub(last) < interval {
						continue
					}
					if until, ok := notBefore[cfg.CollectorID]; ok {
						if now.Before(until) {
							continue
						}
						delete(notBefore, cfg.CollectorID)
					}
					lastRun[cfg.CollectorID] = now
					if err := RunOnce(ctx, deps, cfg, nil); err != nil {
						deps.logf("[unifi] collector %s: %v", cfg.CollectorID, err)
						if at, ok := httputil.RetryAtFrom(err); ok {
							notBefore[cfg.CollectorID] = at
							deps.logf("[unifi] collector %s deferred by server Retry-After until %s", cfg.CollectorID, at.UTC().Format(time.RFC3339))
						}
					}
				}
			}
			next := sched.active
			if idle {
				next = sched.idle()
			}
			if !fetchRetryAt.IsZero() {
				if d := fetchRetryAt.Sub(deps.clock()); d > next {
					next = d
					deps.logf("[unifi] fetch deferred by server Retry-After until %s", fetchRetryAt.UTC().Format(time.RFC3339))
				}
			}
			if deps.waitHook != nil {
				next = deps.waitHook(next)
			}
			timer.Reset(next)
		}
	}()
	return done
}

func fetchConfigs(ctx context.Context, deps CollectorDeps) ([]CollectorConfig, error) {
	base, err := deps.agentBase()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/unifi-collectors", nil)
	if err != nil {
		return nil, err
	}
	resp, err := deps.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, deps.statusError("fetch configs", resp)
	}
	var out struct {
		Collectors []CollectorConfig `json:"collectors"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	return out.Collectors, nil
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (d CollectorDeps) clock() time.Time {
	if d.now != nil {
		return d.now()
	}
	return time.Now()
}

func (d CollectorDeps) random() float64 {
	if d.rnd != nil {
		return d.rnd()
	}
	return rand.Float64()
}

// retryAfterMaxCap mirrors httputil's ceiling on a server-provided Retry-After
// (ParseRetryAfter already clamps the header; jitter must not push past it).
const retryAfterMaxCap = 300 * time.Second

// retryAfterJitterFraction spreads a fleet that was shed together across a
// window: RetryAt = now + RA x (1 + 0.3*U), matching httputil's default
// JitterFrac.
const retryAfterJitterFraction = 0.3

// jitterRetryAfter returns ra x (1 + 0.3*rnd), never less than ra and never
// more than retryAfterMaxCap.
func jitterRetryAfter(ra time.Duration, rnd float64) time.Duration {
	if ra <= 0 {
		return ra
	}
	out := time.Duration(float64(ra) * (1 + retryAfterJitterFraction*rnd))
	if out > retryAfterMaxCap {
		return retryAfterMaxCap
	}
	return out
}

// statusError builds the error for a non-success response. For a 429/503 that
// carries a usable Retry-After (and loop-level Retry-After is enabled) it wraps
// a *httputil.RetryableStatusError whose RetryAt tells the loop when to call
// this route again; otherwise it is the plain status error, as before.
func (d CollectorDeps) statusError(what string, resp *http.Response) error {
	base := fmt.Errorf("%s: status %d", what, resp.StatusCode)
	if resp.StatusCode != http.StatusTooManyRequests && resp.StatusCode != http.StatusServiceUnavailable {
		return base
	}
	if !httputil.LoopRetryAfterEnabled() {
		return base
	}
	now := d.clock()
	ra := httputil.ParseRetryAfter(resp.Header, now)
	if ra <= 0 {
		return base
	}
	url := ""
	if resp.Request != nil && resp.Request.URL != nil {
		url = resp.Request.URL.String()
	}
	return fmt.Errorf("%w: %w", base, &httputil.RetryableStatusError{
		StatusCode: resp.StatusCode,
		URL:        url,
		RetryAt:    now.Add(jitterRetryAfter(ra, d.random())),
	})
}
