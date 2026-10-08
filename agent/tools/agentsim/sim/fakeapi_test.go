package sim

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	gws "github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/heartbeat"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/pkg/api"
)

// fakeAPI is just enough of the Breeze API for the simulator's tests: bearer
// auth, enrollment, the steady-state routes, the agent WebSocket, admin login
// and command dispatch. Every request is counted by RouteKey.
type fakeAPI struct {
	srv *httptest.Server

	mu          sync.Mutex
	counts      map[string]int
	tokens      map[string]string // agentId -> bearer token
	devices     map[string]string // deviceId -> agentId
	sockets     map[string]*fakeSocket
	pending     map[string][]heartbeat.Command // agentId -> commands for the next heartbeat response
	results     map[string]string              // commandId -> "ws" | "http"
	pongCount   int
	enroll429   int
	rejectWS    bool
	pingEvery   time.Duration
	nextAgent   int
	nextCommand int
}

type fakeSocket struct {
	mu   sync.Mutex
	conn *gws.Conn
}

func (s *fakeSocket) write(v any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conn.WriteJSON(v)
}

var fakeUpgrader = gws.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

func newFakeAPI(t *testing.T) *fakeAPI {
	t.Helper()
	f := &fakeAPI{counts: map[string]int{}, tokens: map[string]string{}, devices: map[string]string{},
		sockets: map[string]*fakeSocket{}, pending: map[string][]heartbeat.Command{}, results: map[string]string{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(func() { f.dropSockets(); f.srv.Close() })
	return f
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// pathSegment returns segment i of /api/v1/<...>: 3 is the agent or device id.
func pathSegment(path string, i int) string {
	segs := strings.Split(strings.Trim(path, "/"), "/")
	if i < len(segs) {
		return segs[i]
	}
	return ""
}

func (f *fakeAPI) serve(w http.ResponseWriter, r *http.Request) {
	route := RouteKey(r.Method, r.URL.Path)
	f.mu.Lock()
	f.counts[route]++
	f.mu.Unlock()
	switch {
	case route == RouteEnroll:
		f.enroll(w, r)
	case route == "POST /auth/login":
		// The real API answers a login that carries no auth-binding cookie with
		// 428 auth_binding_rotation_required plus Set-Cookie; the client must
		// retry with the cookie (found against a live stack, not in the plan).
		if _, err := r.Cookie("breeze_binding"); err != nil {
			http.SetCookie(w, &http.Cookie{Name: "breeze_binding", Value: "b1", Path: "/"})
			writeJSON(w, http.StatusPreconditionRequired, map[string]any{"reason": "auth_binding_rotation_required"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"tokens": map[string]string{"accessToken": "admin-jwt"}})
	case strings.HasPrefix(route, "POST /devices/"):
		f.dispatch(w, r)
	case route == RouteCrawlConfig:
		http.NotFound(w, r) // workspace module not loaded
	case route == RouteWSUpgrade:
		f.upgrade(w, r)
	case !f.authorized(r):
		w.WriteHeader(http.StatusUnauthorized)
	case route == RouteHeartbeat:
		f.heartbeat(w, r)
	case route == RouteUnifi:
		writeJSON(w, http.StatusOK, map[string]any{"collectors": []any{}})
	case route == RouteCommandResult:
		f.mu.Lock()
		f.results[pathSegment(r.URL.Path, 5)] = "http"
		f.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	default:
		_, _ = io.Copy(io.Discard, r.Body)
		writeJSON(w, http.StatusOK, map[string]any{"success": true})
	}
}

func (f *fakeAPI) authorized(r *http.Request) bool {
	f.mu.Lock()
	tok, ok := f.tokens[pathSegment(r.URL.Path, 3)]
	f.mu.Unlock()
	return ok && r.Header.Get("Authorization") == "Bearer "+tok
}

func (f *fakeAPI) register() Identity { // caller holds f.mu
	f.nextAgent++
	n := f.nextAgent
	id := Identity{AgentID: fmt.Sprintf("agent-%04d", n), DeviceID: fmt.Sprintf("device-%04d", n),
		AuthToken: fmt.Sprintf("brz_token_%04d", n), OrgID: "org-1", SiteID: "site-1"}
	f.tokens[id.AgentID] = id.AuthToken
	f.devices[id.DeviceID] = id.AgentID
	return id
}

func (f *fakeAPI) enroll(w http.ResponseWriter, r *http.Request) {
	var req api.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.EnrollmentKey == "" || req.Hostname == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	f.mu.Lock()
	if f.enroll429 > 0 {
		f.enroll429--
		f.mu.Unlock()
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusTooManyRequests)
		return
	}
	id := f.register()
	f.mu.Unlock()
	writeJSON(w, http.StatusCreated, api.EnrollResponse{AgentID: id.AgentID, AuthToken: id.AuthToken,
		DeviceID: id.DeviceID, OrgID: id.OrgID, SiteID: id.SiteID})
}

func (f *fakeAPI) preEnroll(index int) Identity {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.register()
	id.Index = index
	id.Hostname = fmt.Sprintf("agentsim-test00-%05d", index)
	return id
}

func (f *fakeAPI) heartbeat(w http.ResponseWriter, r *http.Request) {
	var p heartbeat.HeartbeatPayload
	if err := json.NewDecoder(r.Body).Decode(&p); err != nil || p.Status == "" || p.AgentVersion == "" {
		w.WriteHeader(http.StatusBadRequest)
		return
	}
	agentID := pathSegment(r.URL.Path, 3)
	f.mu.Lock()
	cmds := f.pending[agentID]
	delete(f.pending, agentID)
	f.mu.Unlock()
	writeJSON(w, http.StatusOK, heartbeat.HeartbeatResponse{Commands: cmds})
}

func (f *fakeAPI) upgrade(w http.ResponseWriter, r *http.Request) {
	agentID := pathSegment(r.URL.Path, 3)
	f.mu.Lock()
	tok, ok := f.tokens[agentID]
	reject, ping := f.rejectWS, f.pingEvery
	f.mu.Unlock()
	if reject || !ok || r.Header.Get("Authorization") != "Bearer "+tok {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	conn, err := fakeUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	sock := &fakeSocket{conn: conn}
	f.mu.Lock()
	f.sockets[agentID] = sock
	f.mu.Unlock()
	_ = sock.write(map[string]any{"type": "connected", "agentId": agentID})
	done := make(chan struct{})
	if ping > 0 {
		go func() {
			t := time.NewTicker(ping)
			defer t.Stop()
			for {
				select {
				case <-done:
					return
				case <-t.C:
					if sock.write(map[string]any{"type": "ping", "timestamp": time.Now().UnixMilli()}) != nil {
						return
					}
				}
			}
		}()
	}
	go func() {
		defer close(done)
		defer func() { _ = conn.Close() }()
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				return
			}
			var frame struct {
				Type      string `json:"type"`
				CommandID string `json:"commandId"`
			}
			_ = json.Unmarshal(data, &frame)
			f.mu.Lock()
			switch frame.Type {
			case "pong":
				f.pongCount++
			case "command_result":
				f.results[frame.CommandID] = "ws"
			}
			f.mu.Unlock()
			if frame.Type == "command_result" {
				_ = sock.write(map[string]any{"type": "ack", "commandId": frame.CommandID})
			}
		}
	}()
}

func (f *fakeAPI) dispatch(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer admin-jwt" {
		w.WriteHeader(http.StatusUnauthorized)
		return
	}
	f.mu.Lock()
	agentID, ok := f.devices[pathSegment(r.URL.Path, 3)]
	f.nextCommand++
	cmdID := fmt.Sprintf("cmd-%04d", f.nextCommand)
	f.mu.Unlock()
	if !ok {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	if f.pushWS(agentID, cmdID) != nil {
		f.queueHeartbeatCommand(agentID, cmdID)
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": cmdID})
}

func (f *fakeAPI) pushWS(agentID, commandID string) error {
	f.mu.Lock()
	sock := f.sockets[agentID]
	f.mu.Unlock()
	if sock == nil {
		return fmt.Errorf("no socket for %s", agentID)
	}
	return sock.write(map[string]any{"id": commandID, "type": "refresh_inventory", "payload": map[string]any{}})
}

func (f *fakeAPI) queueHeartbeatCommand(agentID, commandID string) {
	f.mu.Lock()
	f.pending[agentID] = append(f.pending[agentID], heartbeat.Command{ID: commandID, Type: "refresh_inventory"})
	f.mu.Unlock()
}

func (f *fakeAPI) dropSockets() {
	f.mu.Lock()
	socks := f.sockets
	f.sockets = map[string]*fakeSocket{}
	f.mu.Unlock()
	for _, s := range socks {
		_ = s.conn.Close()
	}
}

func (f *fakeAPI) count(route string) int       { f.mu.Lock(); defer f.mu.Unlock(); return f.counts[route] }
func (f *fakeAPI) result(id string) string      { f.mu.Lock(); defer f.mu.Unlock(); return f.results[id] }
func (f *fakeAPI) pongs() int                   { f.mu.Lock(); defer f.mu.Unlock(); return f.pongCount }
func (f *fakeAPI) setRejectWS(v bool)           { f.mu.Lock(); f.rejectWS = v; f.mu.Unlock() }
func (f *fakeAPI) setPingEvery(d time.Duration) { f.mu.Lock(); f.pingEvery = d; f.mu.Unlock() }
func (f *fakeAPI) setEnroll429(n int)           { f.mu.Lock(); f.enroll429 = n; f.mu.Unlock() }
func (f *fakeAPI) socketFor(agentID string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.sockets[agentID] != nil
}

const ms = time.Millisecond

func fastCadence() Cadence {
	return Cadence{Heartbeat: 100 * ms, UnifiPoll: 50 * ms, CrawlConfig: 100 * ms, ProcessSample: 150 * ms,
		Security: 250 * ms, Sessions: 250 * ms, Inventory: 400 * ms, Posture: 400 * ms, EventLogs: 400 * ms, WSPing: 100 * ms}
}

func testConfig(f *fakeAPI, dir string) Config {
	cfg := DefaultConfig()
	cfg.ServerURL = f.srv.URL
	cfg.EnrollmentKey, cfg.EnrollmentSecret = "key", "secret"
	cfg.Cadence = fastCadence()
	cfg.StorePath = filepath.Join(dir, "tokens.json")
	cfg.ReportPath = filepath.Join(dir, "report.json")
	cfg.Retry = httputil.RetryConfig{MaxRetries: 0, InitialDelay: 10 * ms, MaxDelay: 10 * ms, BackoffFactor: 2}
	cfg.RequestTimeout = 2 * time.Second
	cfg.CommandDelay = 5 * ms
	return cfg
}

func newTestRecorder() *Recorder {
	now := time.Now()
	return NewRecorder("test", now, now, now.Add(time.Hour))
}

func eventually(t *testing.T, within time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(within)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * ms)
	}
	t.Fatal(msg)
}
