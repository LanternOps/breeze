package websocket

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// Real Client + httptest WS server + fake clock (W09, #8148). The loop's waits
// run on the fake clock, so each test asserts the exact wait the loop chose.
// The connection itself runs on real sockets and real deadlines.

// scriptedWSServer accepts every upgrade (unless refuse says otherwise) and
// hands each server-side conn to the test, which decides when and how it
// ends.
type scriptedWSServer struct {
	srv   *httptest.Server
	conns chan *websocket.Conn
	dials atomic.Int32
}

func newScriptedWSServer(t *testing.T, refuse func(attempt int, w http.ResponseWriter) bool) *scriptedWSServer {
	t.Helper()
	s := &scriptedWSServer{conns: make(chan *websocket.Conn, 16)}
	s.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		attempt := int(s.dials.Add(1))
		if refuse != nil && refuse(attempt, w) {
			return
		}
		conn, err := testUpgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		s.conns <- conn
	}))
	t.Cleanup(s.srv.Close)
	return s
}

// next returns the server side of the next accepted socket.
func (s *scriptedWSServer) next(t *testing.T) *websocket.Conn {
	t.Helper()
	select {
	case c := <-s.conns:
		t.Cleanup(func() { _ = c.Close() })
		return c
	case <-time.After(5 * time.Second):
		t.Fatal("server accepted no socket within 5s")
		return nil
	}
}

func closeWith(t *testing.T, sc *websocket.Conn, code int) {
	t.Helper()
	_ = sc.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(code, ""), time.Now().Add(time.Second))
	_ = sc.Close()
}

// dropTCP ends the socket with no close frame: the agent reads 1006.
func dropTCP(sc *websocket.Conn) { _ = sc.UnderlyingConn().Close() }

// newWindowTestClient builds a client with the test hooks wired. The start
// window is 0 (newTestClient) unless a test sets it.
func newWindowTestClient(srvURL string) (*Client, chan struct{}) {
	c := newTestClient(srvURL, noopHandler)
	connected := make(chan struct{}, 16)
	c.testHooks.connected = connected
	return c, connected
}

func waitConnected(t *testing.T, connected <-chan struct{}) {
	t.Helper()
	select {
	case <-connected:
	case <-time.After(5 * time.Second):
		t.Fatal("client did not install a socket within 5s")
	}
}

// startLoop runs c.Start on a goroutine and returns a channel closed when it
// returns. The cleanup stops the client and waits for Start to return, so the
// fake clock/rand restores (registered earlier) run after the loop is gone.
func startLoop(t *testing.T, c *Client) <-chan struct{} {
	t.Helper()
	done := make(chan struct{})
	go func() {
		c.Start()
		close(done)
	}()
	t.Cleanup(func() {
		c.Stop()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("reconnectLoop did not exit after Stop")
		}
	})
	return done
}

func ptrDuration(d time.Duration) *time.Duration { return &d }

func TestStableRemoteDropWaitsFirstWindow(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected := newWindowTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	closeWith(t, sc, websocket.CloseGoingAway)

	if d := clk.NextWait(t); d != 15500*time.Millisecond {
		t.Fatalf("wait after a stable 1001 = %v, want 15.5s", d)
	}
	clk.Advance(15 * time.Second)
	if n := s.dials.Load(); n != 1 {
		t.Fatalf("dials before the wait elapsed = %d, want 1", n)
	}
	clk.Advance(500 * time.Millisecond)
	s.next(t)
	waitConnected(t, connected)
	if n := s.dials.Load(); n != 2 {
		t.Fatalf("dials after the wait = %d, want exactly 2", n)
	}
}

func TestStableAbnormalDropWaitsFirstWindow(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected := newWindowTestClient(s.srv.URL)
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	dropTCP(sc)

	if d := clk.NextWait(t); d != 15500*time.Millisecond {
		t.Fatalf("wait after a stable 1006 = %v, want 15.5s", d)
	}
}

func TestFirstReconnectWindowZeroIsPreW09(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	cfg := &Config{
		ServerURL:            s.srv.URL,
		AgentID:              "test-agent-001",
		AuthToken:            newTestClient(s.srv.URL, noopHandler).config.AuthToken,
		FirstReconnectWindow: ptrDuration(0),
	}
	c := New(cfg, noopHandler)
	c.startWindow = 0
	connected := make(chan struct{}, 16)
	c.testHooks.connected = connected
	startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	closeWith(t, sc, websocket.CloseGoingAway)

	if d := clk.NextWait(t); d != 3*time.Second {
		t.Fatalf("wait after a stable 1001 with window 0 = %v, want 3s (#9145)", d)
	}
}

func TestFirstReconnectWindowUnsetIsDefault(t *testing.T) {
	c := New(&Config{ServerURL: "http://127.0.0.1:1", AgentID: "a"}, noopHandler)
	if c.firstWindow != defaultFirstReconnectWindow {
		t.Fatalf("firstWindow with nil config = %v, want %v", c.firstWindow, defaultFirstReconnectWindow)
	}
	if c.startWindow != defaultStartDialWindow {
		t.Fatalf("startWindow = %v, want %v", c.startWindow, defaultStartDialWindow)
	}
	c = New(&Config{ServerURL: "http://127.0.0.1:1", AgentID: "a", FirstReconnectWindow: ptrDuration(time.Hour)}, noopHandler)
	if c.firstWindow != maxFirstReconnectWindow {
		t.Fatalf("firstWindow with 1h = %v, want clamped to %v", c.firstWindow, maxFirstReconnectWindow)
	}
	for _, tc := range []struct{ in, want time.Duration }{{0, 0}, {-time.Second, 0}, {3 * time.Second, 3 * time.Second}, {time.Hour, defaultStartDialWindow}} {
		c = New(&Config{ServerURL: "http://127.0.0.1:1", AgentID: "a", StartDialWindow: ptrDuration(tc.in)}, noopHandler)
		if c.startWindow != tc.want {
			t.Fatalf("StartDialWindow %v → startWindow %v, want %v", tc.in, c.startWindow, tc.want)
		}
	}
}

func TestWSStartDialJittered(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected := newWindowTestClient(s.srv.URL)
	c.startWindow = defaultStartDialWindow
	startLoop(t, c)

	if d := clk.NextWait(t); d != 5*time.Second {
		t.Fatalf("wait before the first dial = %v, want 5s", d)
	}
	clk.Advance(4 * time.Second)
	if n := s.dials.Load(); n != 0 {
		t.Fatalf("dials before the start wait elapsed = %d, want 0", n)
	}
	clk.Advance(time.Second)
	s.next(t)
	waitConnected(t, connected)
}

func TestStopDuringStartWait(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, _ := newWindowTestClient(s.srv.URL)
	c.startWindow = defaultStartDialWindow
	done := startLoop(t, c)

	clk.NextWait(t)
	c.Stop()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not return after Stop during the start wait")
	}
	if n := s.dials.Load(); n != 0 {
		t.Fatalf("dials after Stop = %d, want 0", n)
	}
}

func TestStopDuringFirstReconnectWait(t *testing.T) {
	clk := installFakeWSClock(t)
	installWSRand(t, 0.5)
	s := newScriptedWSServer(t, nil)
	c, connected := newWindowTestClient(s.srv.URL)
	done := startLoop(t, c)

	sc := s.next(t)
	waitConnected(t, connected)
	clk.Advance(31 * time.Second)
	closeWith(t, sc, websocket.CloseGoingAway)
	clk.NextWait(t)

	c.Stop()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Start did not return after Stop during the first-reconnect wait")
	}
	if n := s.dials.Load(); n != 1 {
		t.Fatalf("dials after Stop = %d, want 1", n)
	}
}

func TestDialAfterStopIsDiscarded(t *testing.T) {
	s := newScriptedWSServer(t, nil)
	c := newTestClient(s.srv.URL, noopHandler)
	entered := make(chan struct{})
	release := make(chan struct{})
	c.testHooks.beforeInstall = func() {
		close(entered)
		<-release
	}

	errCh := make(chan error, 1)
	go func() { errCh <- c.connect() }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("dial never completed")
	}
	sc := s.next(t)
	c.Stop()
	close(release)

	var err error
	select {
	case err = <-errCh:
	case <-time.After(5 * time.Second):
		t.Fatal("connect did not return")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("connect after Stop = %v, want context.Canceled", err)
	}
	if c.IsConnected() {
		t.Fatal("a socket dialled before Stop was installed after it")
	}
	_ = sc.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, _, rerr := sc.ReadMessage(); rerr == nil {
		t.Fatal("server read a message; want the discarded socket closed")
	} else if ne, ok := rerr.(interface{ Timeout() bool }); ok && ne.Timeout() {
		t.Fatal("server socket still open 5s after Stop; want it closed")
	}
}
