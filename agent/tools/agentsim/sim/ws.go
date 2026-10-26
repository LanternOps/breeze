package sim

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand/v2"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	gws "github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/httputil"
	agentws "github.com/breeze-rmm/agent/internal/websocket"
)

// Mirrors of internal/websocket/client.go, where they are unexported. The
// simulator keeps its own thin client so it can count connects and reconnects
// per agent and hold thousands of sockets without the agent's per-client
// logging and ordered-command pump. Reconnect PACING is not mirrored: each
// session asks the agent's own agentws.ReconnectPacer (W09, #8148).
const (
	wsWriteWait  = 10 * time.Second // writeWait
	wsPongWait   = 60 * time.Second // pongWait
	wsHandshake  = 10 * time.Second // connect(): Dialer.HandshakeTimeout
	wsMaxMessage = 16 << 20         // maxMessageSize
)

// drainHintGrace is how long past its window a drain hint stays live
// (internal/websocket/drain.go drainHintGrace).
const drainHintGrace = 30 * time.Second

// closeGoingAway is the close code a draining server sends.
const closeGoingAway = gws.CloseGoingAway

// Test seams for the session's clock and sleep; production values only.
var (
	nowFn   = time.Now
	sleepFn = sleepCtx
)

var errNoSocket = errors.New("agent socket not connected")

type wsSession struct {
	agent     *Agent
	mu        sync.Mutex // gorilla allows one concurrent writer
	conn      *gws.Conn
	connected atomic.Bool

	// Reconnect pacing. The pacer is used only from Run's goroutine.
	pacer    *agentws.ReconnectPacer
	preW09   bool // the #9145 agent: no start jitter, drain hints ignored
	ignoreRA bool // legacy-retry cohort: ignores Retry-After
	simClose atomic.Int32

	drainMu   sync.Mutex
	drainSet  bool
	drainWith time.Duration
	drainEnds time.Time
}

// newPacerRand is the deterministic per-agent source behind the pacer, so a
// run with the same agent indexes paces identically.
func newPacerRand(index int) *rand.Rand {
	return rand.New(rand.NewPCG(uint64(index)+1, 0xbace))
}

func newWSSession(a *Agent) *wsSession {
	idx := a.id.Index
	s := &wsSession{agent: a, preW09: isPreW09(a.cfg, idx), ignoreRA: isLegacy(a.cfg, idx)}
	window := agentws.DefaultFirstReconnectWindow
	if s.preW09 {
		window = 0 // #9145: U(1 s, 5 s) after any server close
	}
	s.pacer = agentws.NewReconnectPacer(newPacerRand(idx).Float64, window)
	return s
}

// setDrain stores a drain hint for the live socket. Pre-W09 agents skip the
// frame; the first hint on a socket wins; it lapses within + 30 s later.
func (s *wsSession) setDrain(within time.Duration) {
	if s.preW09 {
		return
	}
	within = min(max(within, 0), agentws.MaxDrainWithin)
	s.drainMu.Lock()
	defer s.drainMu.Unlock()
	if s.drainSet {
		return
	}
	s.drainSet, s.drainWith, s.drainEnds = true, within, nowFn().Add(within+drainHintGrace)
}

// takeDrain returns the live hint and clears it; -1 when there is none.
func (s *wsSession) takeDrain() time.Duration {
	s.drainMu.Lock()
	defer s.drainMu.Unlock()
	set, within, ends := s.drainSet, s.drainWith, s.drainEnds
	s.drainSet = false
	if !set || nowFn().After(ends) {
		return -1
	}
	return within
}

// waitAfterDisconnect is the pause before redialling an established socket
// that ended with closeCode (0 = no close frame).
func (s *wsSession) waitAfterDisconnect(closeCode int, local bool, lasted time.Duration) time.Duration {
	return s.pacer.AfterDisconnect(closeCode, local, lasted, s.takeDrain())
}

func (s *wsSession) startWait() time.Duration {
	if s.preW09 {
		return 0
	}
	return s.pacer.AtStart(agentws.DefaultStartDialWindow)
}

func (s *wsSession) sleep(ctx context.Context, d time.Duration) bool {
	if sc := s.agent.cfg.wsPaceScale; sc > 0 {
		d = time.Duration(float64(d) * sc)
	}
	return sleepFn(ctx, d)
}

func (s *wsSession) Connected() bool { return s.connected.Load() }

func (s *wsSession) url() string {
	base := s.agent.cfg.ServerURL
	switch {
	case strings.HasPrefix(base, "https://"):
		base = "wss://" + strings.TrimPrefix(base, "https://")
	case strings.HasPrefix(base, "http://"):
		base = "ws://" + strings.TrimPrefix(base, "http://")
	}
	return base + "/api/v1/agent-ws/" + s.agent.identity().AgentID + "/ws"
}

// Run is client.go reconnectLoop: every path back to dial waits for the
// agent's ReconnectPacer.
func (s *wsSession) Run(ctx context.Context) {
	rec := s.agent.rec
	if !s.sleep(ctx, s.startWait()) {
		return
	}
	established := 0
	for ctx.Err() == nil {
		started := time.Now()
		conn, status, retryAfter, err := s.dial(ctx)
		if err != nil {
			rec.WSConnectFailed()
			if s.ignoreRA {
				retryAfter = 0
			}
			if !s.sleep(ctx, s.pacer.AfterDialFailure(status, retryAfter)) {
				return
			}
			continue
		}
		rec.WSConnected(established > 0, time.Since(started))
		established++
		connStart := nowFn()
		code := s.serve(ctx, conn)
		rec.WSDisconnected()
		// A socket the simulator drops itself (drop-sockets) models a
		// client-side network drop: no close frame, so abnormal, not local.
		if !s.sleep(ctx, s.waitAfterDisconnect(code, false, nowFn().Sub(connStart))) {
			return
		}
	}
}

func (s *wsSession) dial(ctx context.Context) (*gws.Conn, int, time.Duration, error) {
	d := gws.Dialer{HandshakeTimeout: wsHandshake, Proxy: http.ProxyFromEnvironment}
	header := http.Header{"Authorization": {"Bearer " + s.agent.identity().AuthToken}}
	start := time.Now()
	conn, resp, err := d.DialContext(ctx, s.url(), header)
	status := 0
	var retryAfter time.Duration
	if resp != nil {
		status = resp.StatusCode
		retryAfter = httputil.ParseRetryAfter(resp.Header, time.Now())
		if resp.Body != nil {
			_ = resp.Body.Close()
		}
	}
	s.agent.rec.ObserveHTTP(RouteWSUpgrade, true, start, time.Since(start), status, err)
	return conn, status, retryAfter, err
}

// serve runs one socket until it ends and returns the close code the pacer
// should see: the server's close frame, the code the simulator stood in for
// (drain-sockets), or 0 when the socket dropped without a close frame.
func (s *wsSession) serve(ctx context.Context, conn *gws.Conn) int {
	s.simClose.Store(0)
	s.drainMu.Lock()
	s.drainSet = false // a hint belongs to one socket
	s.drainMu.Unlock()
	rec := s.agent.rec
	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()
	s.connected.Store(true)
	rec.SocketUp()
	s.agent.hub.add(conn, s)
	stop := make(chan struct{})
	defer func() {
		s.agent.hub.remove(conn)
		rec.SocketDown()
		close(stop)
		s.connected.Store(false)
		s.mu.Lock()
		s.conn = nil
		s.mu.Unlock()
		_ = conn.Close()
	}()

	conn.SetReadLimit(wsMaxMessage)
	_ = conn.SetReadDeadline(time.Now().Add(wsPongWait))
	conn.SetPongHandler(func(string) error {
		rec.WSControlPong()
		return conn.SetReadDeadline(time.Now().Add(wsPongWait))
	})
	go s.pinger(ctx, conn, stop)
	go func() { // unblock ReadMessage when the run ends
		select {
		case <-ctx.Done():
			_ = conn.WriteControl(gws.CloseMessage, gws.FormatCloseMessage(gws.CloseNormalClosure, ""), time.Now().Add(time.Second))
			_ = conn.Close()
		case <-stop:
		}
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			if c := int(s.simClose.Load()); c != 0 {
				return c
			}
			var ce *gws.CloseError
			if errors.As(err, &ce) {
				return ce.Code
			}
			return 0
		}
		s.handle(data)
	}
}

func (s *wsSession) pinger(ctx context.Context, conn *gws.Conn, stop <-chan struct{}) {
	period := s.agent.cfg.Cadence.WSPing
	if period <= 0 {
		return
	}
	t := time.NewTicker(period)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ctx.Done():
			return
		case <-t.C:
			// WriteControl may run concurrently with other writers (gorilla docs).
			if err := conn.WriteControl(gws.PingMessage, nil, time.Now().Add(wsWriteWait)); err != nil {
				_ = conn.Close()
				return
			}
			s.agent.rec.WSControlPing()
		}
	}
}

// handle follows client.go readPump's order: ping, then id-bearing commands.
func (s *wsSession) handle(data []byte) {
	var probe struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if json.Unmarshal(data, &probe) != nil {
		s.agent.rec.WSFrame("unparseable")
		return
	}
	switch {
	case probe.Type == "ping":
		s.agent.rec.WSFrame("ping")
		_ = s.writeJSON(map[string]any{"type": "pong", "timestamp": time.Now().UnixMilli()})
	case probe.ID != "":
		var cmd agentws.Command
		if json.Unmarshal(data, &cmd) == nil {
			s.agent.enqueue(cmd, "ws")
		}
	default:
		kind := probe.Type
		if kind == "" {
			kind = "untyped"
		}
		s.agent.rec.WSFrame(kind)
	}
}

func (s *wsSession) writeJSON(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.conn == nil {
		return errNoSocket
	}
	_ = s.conn.SetWriteDeadline(time.Now().Add(wsWriteWait))
	return s.conn.WriteMessage(gws.TextMessage, data)
}

// SendResult writes a command_result frame (client.go sets Type the same way).
func (s *wsSession) SendResult(r agentws.CommandResult) error {
	r.Type = "command_result"
	return s.writeJSON(r)
}
