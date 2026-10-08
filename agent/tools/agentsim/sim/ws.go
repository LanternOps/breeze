package sim

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	gws "github.com/gorilla/websocket"

	agentws "github.com/breeze-rmm/agent/internal/websocket"
)

// Mirrors of internal/websocket/client.go, where they are unexported. The
// simulator keeps its own thin client so it can count connects and reconnects
// per agent and hold thousands of sockets without the agent's per-client
// logging and ordered-command pump.
const (
	wsWriteWait      = 10 * time.Second // writeWait
	wsPongWait       = 60 * time.Second // pongWait
	wsHandshake      = 10 * time.Second // connect(): Dialer.HandshakeTimeout
	wsInitialBackoff = 1 * time.Second  // initialBackoff
	wsMaxBackoff     = 60 * time.Second // maxBackoff
	wsBackoffFactor  = 2.0              // backoffFactor
	wsJitterFrac     = 0.3              // jitterFactor
	wsStableAfter    = 30 * time.Second // reconnectLoop: reset backoff after a connection this long
	wsMaxMessage     = 16 << 20         // maxMessageSize
)

var errNoSocket = errors.New("agent socket not connected")

type wsSession struct {
	agent     *Agent
	mu        sync.Mutex // gorilla allows one concurrent writer
	conn      *gws.Conn
	connected atomic.Bool
}

func newWSSession(a *Agent) *wsSession { return &wsSession{agent: a} }

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

// Run is client.go reconnectLoop.
func (s *wsSession) Run(ctx context.Context) {
	rec := s.agent.rec
	backoff := wsInitialBackoff
	established := 0
	for ctx.Err() == nil {
		started := time.Now()
		conn, err := s.dial(ctx)
		if err != nil {
			rec.WSConnectFailed()
			if !sleepCtx(ctx, s.agent.jitter(backoff, wsJitterFrac)) {
				return
			}
			backoff = time.Duration(float64(backoff) * wsBackoffFactor)
			if backoff > wsMaxBackoff {
				backoff = wsMaxBackoff
			}
			continue
		}
		rec.WSConnected(established > 0, time.Since(started))
		established++
		connStart := time.Now()
		s.serve(ctx, conn)
		rec.WSDisconnected()
		if time.Since(connStart) > wsStableAfter {
			backoff = wsInitialBackoff
		}
		// An established socket that drops is redialled at once, with no delay
		// (spec §1, failure-spiral step 3).
	}
}

func (s *wsSession) dial(ctx context.Context) (*gws.Conn, error) {
	d := gws.Dialer{HandshakeTimeout: wsHandshake, Proxy: http.ProxyFromEnvironment}
	header := http.Header{"Authorization": {"Bearer " + s.agent.identity().AuthToken}}
	start := time.Now()
	conn, resp, err := d.DialContext(ctx, s.url(), header)
	status := 0
	if resp != nil {
		status = resp.StatusCode
		if resp.Body != nil {
			resp.Body.Close()
		}
	}
	s.agent.rec.ObserveHTTP(RouteWSUpgrade, true, start, time.Since(start), status, err)
	return conn, err
}

func (s *wsSession) serve(ctx context.Context, conn *gws.Conn) {
	rec := s.agent.rec
	s.mu.Lock()
	s.conn = conn
	s.mu.Unlock()
	s.connected.Store(true)
	stop := make(chan struct{})
	defer func() {
		close(stop)
		s.connected.Store(false)
		s.mu.Lock()
		s.conn = nil
		s.mu.Unlock()
		conn.Close()
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
			conn.Close()
		case <-stop:
		}
	}()
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return
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
				conn.Close()
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
