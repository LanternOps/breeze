package sim

import (
	"context"
	"encoding/json"
	"io"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	agentws "github.com/breeze-rmm/agent/internal/websocket"
	"github.com/breeze-rmm/agent/internal/workspaceindex"
)

// crawlConfigAbsentBackoff mirrors workspaceindex/loop.go moduleAbsentBackoff.
const crawlConfigAbsentBackoff = 6 * time.Hour

// simulatedUptime is added to run time for the heartbeat's uptime field.
const simulatedUptime = 72 * time.Hour

// socket is the agent WebSocket session (ws.go).
type socket interface {
	Run(ctx context.Context)
	Connected() bool
	SendResult(r agentws.CommandResult) error
}

// Agent is one simulated device.
type Agent struct {
	cfg      *Config
	rec      *Recorder
	payloads *Payloads
	client   *http.Client
	reenroll func(context.Context, Identity) (Identity, error)
	started  time.Time
	ws       socket

	mu sync.Mutex
	id Identity

	rngMu sync.Mutex
	rng   *rand.Rand

	commands chan agentws.Command
	seenMu   sync.Mutex
	seen     map[string]struct{}
	inflight sync.WaitGroup
}

// NewAgent builds one agent. reenroll, when set, replaces an identity the
// server rejects with 401 on its first heartbeat (a re-created stack).
func NewAgent(cfg *Config, rec *Recorder, id Identity, reenroll func(context.Context, Identity) (Identity, error)) *Agent {
	seed := uint64(id.Index) + 1
	a := &Agent{
		cfg: cfg, rec: rec, id: id, reenroll: reenroll,
		client:   newAgentHTTPClient(rec, cfg.RequestTimeout),
		rng:      rand.New(rand.NewPCG(seed, 0x5eed)),
		commands: make(chan agentws.Command, 16),
		seen:     map[string]struct{}{},
	}
	a.payloads = NewPayloads(cfg, rand.New(rand.NewPCG(seed, 0xfeed)))
	if cfg.WSEnabled {
		a.ws = newWSSession(a)
	}
	return a
}

// newAgentHTTPClient clones http.DefaultTransport per agent, as heartbeat.go
// newHeartbeatHTTPClient does, so each simulated agent holds its own
// keep-alive connection the way a real one does.
func newAgentHTTPClient(rec *Recorder, timeout time.Duration) *http.Client {
	base := http.DefaultTransport.(*http.Transport).Clone()
	return &http.Client{Timeout: timeout, Transport: &recordingTransport{base: base, rec: rec}}
}

func (a *Agent) identity() Identity {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.id
}

// randDuration is uniform in [0, max).
func (a *Agent) randDuration(max time.Duration) time.Duration {
	if max <= 0 {
		return 0
	}
	a.rngMu.Lock()
	defer a.rngMu.Unlock()
	return time.Duration(a.rng.Int64N(int64(max)))
}

// jitter is d ± frac·d, the way the agent's reconnect and poll loops compute it.
func (a *Agent) jitter(d time.Duration, frac float64) time.Duration {
	a.rngMu.Lock()
	f := a.rng.Float64()
	a.rngMu.Unlock()
	out := d + time.Duration(float64(d)*frac*(f*2-1))
	if out < 0 {
		return d
	}
	return out
}

func (a *Agent) agentPath(action string) string {
	return "/api/v1/agents/" + a.identity().AgentID + "/" + action
}

// send is one agent HTTP call through the agent's own retry wrapper.
func (a *Agent) send(ctx context.Context, method, path string, payload any) (*http.Response, []byte, error) {
	headers := http.Header{"Authorization": {"Bearer " + a.identity().AuthToken}}
	var body []byte
	if payload != nil {
		b, err := json.Marshal(payload)
		if err != nil {
			return nil, nil, err
		}
		body = b
		headers.Set("Content-Type", "application/json")
	}
	resp, err := httputil.Do(withLogicalRequest(ctx), a.client, method, a.cfg.ServerURL+path, body, headers, a.cfg.Retry)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	return resp, data, err
}

func (a *Agent) sendAsync(ctx context.Context, method, action string, payload any) {
	path := a.agentPath(action)
	a.inflight.Add(1)
	go func() {
		defer a.inflight.Done()
		_, _, _ = a.send(ctx, method, path, payload)
	}()
}

// Run drives the agent until ctx ends.
func (a *Agent) Run(ctx context.Context) {
	a.started = time.Now()
	index := a.identity().Index
	a.rec.AgentOnline(index, a.started)
	defer func() {
		a.inflight.Wait()
		a.rec.AgentOffline(index, time.Now())
	}()

	// heartbeat.go Start(): the first beat waits a random fraction of one
	// interval — the per-agent start jitter that spreads a fleet's phases.
	if !sleepCtx(ctx, a.randDuration(a.cfg.Cadence.Heartbeat)) {
		return
	}
	if !a.firstHeartbeat(ctx) {
		return
	}
	if a.cfg.StartMode == StartCold {
		a.sendInventoryBatch(ctx)
	}

	var loops sync.WaitGroup
	start := func(f func(context.Context)) {
		loops.Add(1)
		go func() { defer loops.Done(); f(ctx) }()
	}
	start(a.commandWorker)
	start(a.unifiLoop)
	start(a.crawlConfigLoop)
	start(a.processSampleLoop)
	if a.ws != nil {
		start(a.ws.Run)
	}
	a.tickLoop(ctx)
	loops.Wait()
}

// firstHeartbeat validates a stored identity: a 401 means the stack no longer
// knows this device, so it is re-enrolled once instead of 401-ing all run.
func (a *Agent) firstHeartbeat(ctx context.Context) bool {
	if a.heartbeat(ctx) == http.StatusUnauthorized && a.reenroll != nil {
		fresh, err := a.reenroll(ctx, a.identity())
		if err != nil {
			return false
		}
		a.mu.Lock()
		a.id = fresh
		a.mu.Unlock()
		a.heartbeat(ctx)
	}
	return ctx.Err() == nil
}

// heartbeat sends one beat and queues any commands in the response.
func (a *Agent) heartbeat(ctx context.Context) int {
	payload := a.payloads.Heartbeat(a.identity(), simulatedUptime+time.Since(a.started))
	resp, body, err := a.send(ctx, http.MethodPost, a.agentPath("heartbeat"), payload)
	if err != nil {
		return 0
	}
	if resp.StatusCode == http.StatusOK {
		var hr heartbeat.HeartbeatResponse
		if json.Unmarshal(body, &hr) == nil {
			for _, c := range hr.Commands {
				a.enqueue(agentws.Command{ID: c.ID, Type: c.Type, Payload: c.Payload}, "http")
			}
		}
	}
	return resp.StatusCode
}

func (a *Agent) tickLoop(ctx context.Context) {
	g := newGates(a.cfg.Cadence, a.cfg.StartMode, time.Now(), a.randDuration)
	ticker := time.NewTicker(a.cfg.Cadence.Heartbeat)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.heartbeat(ctx)
			now := time.Now() // read AFTER the beat returns, as heartbeat.go Start() does
			if g.inventory.due(now) {
				a.sendInventoryBatch(ctx)
			}
			if g.eventlogs.due(now) {
				a.sendAsync(ctx, http.MethodPut, "eventlogs", a.payloads.EventLogs(now))
			}
			if g.security.due(now) {
				a.sendAsync(ctx, http.MethodPut, "security/status", a.payloads.Security(a.identity()))
			}
			if g.sessions.due(now) {
				a.sendAsync(ctx, http.MethodPut, "sessions", a.payloads.Sessions(now))
			}
			if g.posture.due(now) {
				a.sendAsync(ctx, http.MethodPut, "management/posture", a.payloads.Posture(now))
			}
		}
	}
}

// sendInventoryBatch is heartbeat.go sendInventory(): concurrent PUTs.
func (a *Agent) sendInventoryBatch(ctx context.Context) {
	now := time.Now()
	id := a.identity()
	a.sendAsync(ctx, http.MethodPut, "software", a.payloads.Software(now))
	a.sendAsync(ctx, http.MethodPut, "disks", a.payloads.Disks())
	a.sendAsync(ctx, http.MethodPut, "network", a.payloads.Network(id))
	a.sendAsync(ctx, http.MethodPut, "connections", a.payloads.Connections(id))
	a.sendAsync(ctx, http.MethodPut, "registry-state", a.payloads.RegistryState())
	a.sendAsync(ctx, http.MethodPut, "config-state", a.payloads.ConfigState())
}

// periodic runs f on its own ticker, as the agent's independent loops do.
// Warm agents start at a random phase.
func (a *Agent) periodic(ctx context.Context, period time.Duration, f func()) {
	if period <= 0 {
		return
	}
	if a.cfg.StartMode == StartWarm && !sleepCtx(ctx, a.randDuration(period)) {
		return
	}
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			f()
		}
	}
}

func (a *Agent) unifiLoop(ctx context.Context) {
	a.periodic(ctx, a.cfg.Cadence.UnifiPoll, func() {
		// unifi/collector.go fetchConfigs: one plain GET, no retry wrapper.
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, a.cfg.ServerURL+a.agentPath("unifi-collectors"), nil)
		if err != nil {
			return
		}
		req.Header.Set("Authorization", "Bearer "+a.identity().AuthToken)
		if resp, err := a.client.Do(req); err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
		}
	})
}

func (a *Agent) processSampleLoop(ctx context.Context) {
	a.periodic(ctx, a.cfg.Cadence.ProcessSample, func() {
		_, _, _ = a.send(ctx, http.MethodPost, a.agentPath("process-sample"), a.payloads.ProcessSample(time.Now()))
	})
}

func (a *Agent) crawlConfigLoop(ctx context.Context) {
	period := a.cfg.Cadence.CrawlConfig
	if period <= 0 {
		return
	}
	wait := a.randDuration(period)
	for {
		if !sleepCtx(ctx, wait) {
			return
		}
		resp, _, err := a.send(ctx, http.MethodGet, workspaceindex.DefaultEndpointBase+"/crawl-config", nil)
		if err == nil && resp.StatusCode == http.StatusNotFound {
			wait = crawlConfigAbsentBackoff
			continue
		}
		wait = a.jitter(period, 0.10)
	}
}

// enqueue de-duplicates by command id (a command can arrive over both paths).
func (a *Agent) enqueue(cmd agentws.Command, via string) {
	a.seenMu.Lock()
	if _, dup := a.seen[cmd.ID]; dup {
		a.seenMu.Unlock()
		a.rec.CommandDuplicate()
		return
	}
	if len(a.seen) > 1024 {
		a.seen = map[string]struct{}{}
	}
	a.seen[cmd.ID] = struct{}{}
	a.seenMu.Unlock()
	a.rec.CommandReceived(via)
	select {
	case a.commands <- cmd:
	default:
		a.rec.CommandDropped()
	}
}

func (a *Agent) commandWorker(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case cmd := <-a.commands:
			if !sleepCtx(ctx, a.cfg.CommandDelay) {
				return
			}
			a.reply(ctx, cmd)
		}
	}
}

// reply answers over the socket when connected, else over HTTP — the
// fallback heartbeat.go processCommand uses without a socket.
func (a *Agent) reply(ctx context.Context, cmd agentws.Command) {
	if a.ws != nil && a.ws.Connected() {
		err := a.ws.SendResult(agentws.CommandResult{CommandID: cmd.ID, Status: "completed", ExitCode: 0, Stdout: "agentsim"})
		if err == nil {
			a.rec.CommandResultSent("ws")
			return
		}
	}
	resp, _, err := a.send(ctx, http.MethodPost, a.agentPath("commands/"+cmd.ID+"/result"),
		tools.CommandResult{Status: "completed", ExitCode: 0, Stdout: "agentsim"})
	if err == nil && resp.StatusCode < 300 {
		a.rec.CommandResultSent("http")
	}
}
