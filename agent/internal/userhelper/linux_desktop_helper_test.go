//go:build !windows

package userhelper

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// fakeLinuxBroker accepts helper connections on a short unix socket, counts
// them, and answers the first auth request as configured.
type fakeLinuxBroker struct {
	ln       net.Listener
	sock     string
	accepts  atomic.Int32
	authReq  chan ipc.AuthRequest
	release  chan struct{} // closed by the test to drop the server side
	response ipc.AuthResponse
}

func newFakeLinuxBroker(t *testing.T, resp ipc.AuthResponse) *fakeLinuxBroker {
	t.Helper()
	// Not t.TempDir(): its path blows past the ~104-byte sun_path limit on
	// macOS and bind fails with EINVAL.
	dir, err := os.MkdirTemp("", "ldh")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "d.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	b := &fakeLinuxBroker{
		ln:       ln,
		sock:     sock,
		authReq:  make(chan ipc.AuthRequest, 4),
		release:  make(chan struct{}),
		response: resp,
	}
	go b.serve()
	return b
}

func (b *fakeLinuxBroker) serve() {
	for {
		conn, err := b.ln.Accept()
		if err != nil {
			return
		}
		b.accepts.Add(1)
		go b.handle(conn)
	}
}

func (b *fakeLinuxBroker) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	srv := ipc.NewConn(conn)
	env, err := srv.Recv()
	if err != nil {
		return
	}
	var req ipc.AuthRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		return
	}
	b.authReq <- req

	resp := b.response
	var key []byte
	if resp.Accepted {
		key = make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return
		}
		resp.SessionKey = hex.EncodeToString(key)
	}
	payload, err := json.Marshal(resp)
	if err != nil {
		return
	}
	if err := srv.Send(&ipc.Envelope{Type: ipc.TypeAuthResponse, ID: "auth", Payload: payload}); err != nil {
		return
	}
	if key != nil {
		srv.SetSessionKey(key)
	}
	// Answer keepalive pings until the test releases the connection, so an
	// idle-exit test is not ended by the connection instead.
	go func() {
		for {
			env, err := srv.Recv()
			if err != nil {
				return
			}
			if env.Type == ipc.TypePing {
				_ = srv.SendTyped(env.ID, ipc.TypePong, nil)
			}
		}
	}()
	<-b.release
}

func acceptedAuth() ipc.AuthResponse {
	return ipc.AuthResponse{Accepted: true, AgentID: "agent-under-test", AllowedScopes: []string{"desktop"}}
}

// stubLinuxDesktopRunSeams keeps Run from touching real platform probes on
// the test host.
//
// Run reads runTCCCheckLoop from a goroutine it starts after authenticating,
// so a test whose helper authenticated must wait for that read before the
// seams are restored: call the returned function before the test ends.
func stubLinuxDesktopRunSeams(t *testing.T) (awaitTCCLoop func()) {
	t.Helper()
	restoreTCC, restoreDetect, restoreGOOS := runTCCCheckLoop, detectCapabilitiesFn, captureReprobeGOOS
	t.Cleanup(func() {
		runTCCCheckLoop, detectCapabilitiesFn, captureReprobeGOOS = restoreTCC, restoreDetect, restoreGOOS
	})
	entered := make(chan struct{}, 1)
	runTCCCheckLoop = func(_ *ipc.Conn, stop chan struct{}, _, _ string, _ bool, _ selfRestartGuard) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-stop
	}
	awaitTCCLoop = func() {
		select {
		case <-entered:
		case <-time.After(5 * time.Second):
			t.Fatal("Run never started its per-run TCC goroutine")
		}
	}
	detectCapabilitiesFn = func(string, string) ipc.Capabilities { return ipc.Capabilities{} }
	captureReprobeGOOS = "linux"
	return awaitTCCLoop
}

func testLinuxDesktopClient(t *testing.T, sock string) (*Client, LinuxDesktopEnv) {
	t.Helper()
	env := LinuxDesktopEnv{LogindSessionID: "c7", SpawnTicket: testSpawnTicket(t), SocketPath: sock}
	return trustTestServer(NewLinuxDesktopClient(env, ipc.DesktopContextUserSession)), env
}

func TestNewLinuxDesktopClient_Identity(t *testing.T) {
	env := LinuxDesktopEnv{LogindSessionID: "c7", SpawnTicket: testSpawnTicket(t), SocketPath: "/run/breeze/desktop/1000.sock"}
	c := NewLinuxDesktopClient(env, ipc.DesktopContextUserSession)
	if c.role != ipc.HelperRoleUser || c.binaryKind != ipc.HelperBinaryDesktopHelper {
		t.Fatalf("role/kind = %q/%q, want user/desktop_helper", c.role, c.binaryKind)
	}
	if c.socketPath != env.SocketPath {
		t.Fatalf("socketPath = %q, want the env's %q", c.socketPath, env.SocketPath)
	}
	if c.logindSessionID != "c7" || c.spawnTicket != env.SpawnTicket {
		t.Fatal("client must carry the env's logind session id and spawn ticket")
	}
	if c.serverVerifier == nil {
		t.Fatal("the Linux desktop client must verify its server")
	}
}

func TestLinuxDesktopHelper_DisconnectIsFinal(t *testing.T) {
	awaitTCC := stubLinuxDesktopRunSeams(t)
	defer awaitTCC()
	broker := newFakeLinuxBroker(t, acceptedAuth())
	client, env := testLinuxDesktopClient(t, broker.sock)

	type result struct {
		code int
		err  error
	}
	done := make(chan struct{})
	got := make(chan result, 1)
	go func() {
		code, err := RunLinuxDesktopHelper(client, done, time.Hour)
		got <- result{code, err}
	}()

	select {
	case req := <-broker.authReq:
		if req.SpawnTicket != env.SpawnTicket {
			t.Error("auth request does not carry the spawn ticket")
		}
		if req.LogindSessionID != env.LogindSessionID {
			t.Errorf("auth request logind session = %q, want %q", req.LogindSessionID, env.LogindSessionID)
		}
		if req.HelperRole != ipc.HelperRoleUser || req.BinaryKind != ipc.HelperBinaryDesktopHelper {
			t.Errorf("auth request role/kind = %q/%q, want user/desktop_helper", req.HelperRole, req.BinaryKind)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("helper never sent its auth request")
	}
	waitForCondition(t, 5*time.Second, func() bool { return !client.AuthenticatedAt().IsZero() })

	close(broker.release) // the broker drops the helper

	select {
	case r := <-got:
		if r.code != 0 {
			t.Errorf("exit code after a disconnect = %d (err %v), want 0", r.code, r.err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("RunLinuxDesktopHelper did not return after the broker disconnected")
	}

	// No redial: the ticket is single-use, so a second connection is never
	// attempted.
	time.Sleep(300 * time.Millisecond)
	if n := broker.accepts.Load(); n != 1 {
		t.Fatalf("broker saw %d connections, want exactly 1 (no redial)", n)
	}
	if client.spawnTicket != "" {
		t.Fatal("spawn ticket must be cleared from the client after the auth attempt")
	}
	if client.desktopMgr.hasActiveSessions() {
		t.Fatal("no desktop session may outlive the run")
	}
}

func TestLinuxDesktopHelper_IdleExit(t *testing.T) {
	awaitTCC := stubLinuxDesktopRunSeams(t)
	defer awaitTCC()
	broker := newFakeLinuxBroker(t, acceptedAuth())
	t.Cleanup(func() { close(broker.release) })
	client, _ := testLinuxDesktopClient(t, broker.sock)

	// Report a live desktop session until the helper has authenticated, so
	// the idle period starts after admission however slow the handshake is.
	const idleExit = 300 * time.Millisecond
	// lastLive is the start of the run, then the last poll that saw a
	// session; the helper may exit no sooner than idleExit after it.
	var lastLive atomic.Int64
	lastLive.Store(time.Now().UnixNano())
	got := make(chan int, 1)
	go func() {
		code, _ := runLinuxDesktopHelper(client, make(chan struct{}), linuxDesktopRunConfig{
			idleExit: idleExit,
			poll:     linuxDesktopIdlePoll(idleExit),
			now:      time.Now,
			hasActiveSessions: func() bool {
				if client.AuthenticatedAt().IsZero() {
					lastLive.Store(time.Now().UnixNano())
					return true
				}
				return false
			},
		})
		got <- code
	}()

	select {
	case code := <-got:
		if code != 0 {
			t.Fatalf("idle exit code = %d, want 0", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("helper with no desktop session did not exit on its own")
	}
	if client.AuthenticatedAt().IsZero() {
		t.Fatal("test precondition: the helper should have authenticated before idling out")
	}
	if idle := time.Since(time.Unix(0, lastLive.Load())); idle < idleExit {
		t.Fatalf("helper exited after %v without a desktop session, want at least %v", idle, idleExit)
	}
	if n := broker.accepts.Load(); n != 1 {
		t.Fatalf("broker saw %d connections, want 1", n)
	}
}

// A live desktop session keeps the helper up past the idle period.
func TestLinuxDesktopHelper_LiveSessionHoldsOffIdleExit(t *testing.T) {
	awaitTCC := stubLinuxDesktopRunSeams(t)
	defer awaitTCC()
	broker := newFakeLinuxBroker(t, acceptedAuth())
	t.Cleanup(func() { close(broker.release) })
	client, _ := testLinuxDesktopClient(t, broker.sock)

	const idleExit = 50 * time.Millisecond
	done := make(chan struct{})
	got := make(chan int, 1)
	go func() {
		code, _ := runLinuxDesktopHelper(client, done, linuxDesktopRunConfig{
			idleExit:          idleExit,
			poll:              linuxDesktopIdlePoll(idleExit),
			now:               time.Now,
			hasActiveSessions: func() bool { return true },
		})
		got <- code
	}()
	waitForCondition(t, 5*time.Second, func() bool { return !client.AuthenticatedAt().IsZero() })
	select {
	case <-got:
		t.Fatal("helper exited for idleness while a desktop session was live")
	case <-time.After(10 * idleExit):
	}
	close(done)
	select {
	case <-got:
	case <-time.After(10 * time.Second):
		t.Fatal("RunLinuxDesktopHelper did not return after shutdown")
	}
}

func TestLinuxDesktopIdlePoll_Bounds(t *testing.T) {
	if got := linuxDesktopIdlePoll(LinuxDesktopHelperIdleExit); got != maxLinuxDesktopIdlePoll {
		t.Errorf("poll for the shipped idle exit = %v, want %v", got, maxLinuxDesktopIdlePoll)
	}
	if got := linuxDesktopIdlePoll(time.Millisecond); got != minLinuxDesktopIdlePoll {
		t.Errorf("poll for 1ms = %v, want %v", got, minLinuxDesktopIdlePoll)
	}
	if LinuxDesktopHelperIdleExit != 5*time.Minute {
		t.Errorf("LinuxDesktopHelperIdleExit = %v, want 5m", LinuxDesktopHelperIdleExit)
	}
}

func TestLinuxDesktopHelper_ShutdownStopsRun(t *testing.T) {
	awaitTCC := stubLinuxDesktopRunSeams(t)
	defer awaitTCC()
	broker := newFakeLinuxBroker(t, acceptedAuth())
	t.Cleanup(func() { close(broker.release) })
	client, _ := testLinuxDesktopClient(t, broker.sock)

	done := make(chan struct{})
	got := make(chan int, 1)
	go func() {
		code, _ := RunLinuxDesktopHelper(client, done, time.Hour)
		got <- code
	}()
	waitForCondition(t, 5*time.Second, func() bool { return !client.AuthenticatedAt().IsZero() })
	close(done)
	select {
	case code := <-got:
		if code != 0 {
			t.Fatalf("shutdown exit code = %d, want 0", code)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("RunLinuxDesktopHelper did not return after shutdown")
	}
}

func TestLinuxDesktopHelper_PermanentRejectExits2(t *testing.T) {
	stubLinuxDesktopRunSeams(t)
	broker := newFakeLinuxBroker(t, ipc.AuthResponse{Accepted: false, Permanent: true, Code: "auth_rejected", Reason: "refused"})
	t.Cleanup(func() { close(broker.release) })
	client, _ := testLinuxDesktopClient(t, broker.sock)

	code, err := RunLinuxDesktopHelper(client, make(chan struct{}), time.Hour)
	if _, ok := errors.AsType[*PermanentRejectError](err); !ok {
		t.Fatalf("err = %v, want a *PermanentRejectError", err)
	}
	if code != 2 {
		t.Fatalf("exit code = %d, want 2", code)
	}
	if client.spawnTicket != "" {
		t.Fatal("spawn ticket must be cleared after a rejected auth attempt")
	}
	time.Sleep(200 * time.Millisecond)
	if n := broker.accepts.Load(); n != 1 {
		t.Fatalf("broker saw %d connections, want 1 (no retry)", n)
	}
}

func TestLinuxDesktopHelper_NoBrokerExits1(t *testing.T) {
	stubLinuxDesktopRunSeams(t)
	dir, err := os.MkdirTemp("", "ldh")
	if err != nil {
		t.Fatalf("temp dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	client, _ := testLinuxDesktopClient(t, filepath.Join(dir, "missing.sock"))
	code, err := RunLinuxDesktopHelper(client, make(chan struct{}), time.Hour)
	if err == nil || code != 1 {
		t.Fatalf("code=%d err=%v, want exit 1 with an error when the broker is unreachable", code, err)
	}
}

func TestAuthenticate_LinuxDesktopSendsTicket(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer func() { _ = clientConn.Close() }()
	defer func() { _ = serverConn.Close() }()

	env := LinuxDesktopEnv{LogindSessionID: "c7", SpawnTicket: testSpawnTicket(t), SocketPath: "/run/breeze/desktop/1000.sock"}
	c := NewLinuxDesktopClient(env, ipc.DesktopContextUserSession)
	c.conn = ipc.NewConn(clientConn)

	gotReq := make(chan ipc.AuthRequest, 1)
	go func() {
		srv := ipc.NewConn(serverConn)
		e, err := srv.Recv()
		if err != nil {
			return
		}
		var req ipc.AuthRequest
		_ = json.Unmarshal(e.Payload, &req)
		gotReq <- req
		payload, _ := json.Marshal(ipc.AuthResponse{Accepted: true, SessionKey: hex.EncodeToString(make([]byte, 32))})
		_ = srv.Send(&ipc.Envelope{Type: ipc.TypeAuthResponse, ID: "auth", Payload: payload})
	}()

	if err := c.authenticate(); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	req := <-gotReq
	if req.SpawnTicket != env.SpawnTicket || req.LogindSessionID != "c7" {
		t.Fatalf("auth request ticketSent=%v logindSession=%q", req.SpawnTicket == env.SpawnTicket, req.LogindSessionID)
	}
	if c.spawnTicket != "" {
		t.Fatal("spawn ticket must be cleared after authenticate")
	}
}

// Every other helper keeps sending neither field: the broker rejects a
// ticket on any other role or binary kind.
func TestAuthenticate_OtherHelpersSendNoTicket(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer func() { _ = clientConn.Close() }()
	defer func() { _ = serverConn.Close() }()

	c := NewWithOptions("/unused", ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession)
	c.conn = ipc.NewConn(clientConn)

	gotReq := make(chan ipc.AuthRequest, 1)
	go func() {
		srv := ipc.NewConn(serverConn)
		e, err := srv.Recv()
		if err != nil {
			return
		}
		var req ipc.AuthRequest
		_ = json.Unmarshal(e.Payload, &req)
		gotReq <- req
		payload, _ := json.Marshal(ipc.AuthResponse{Accepted: true, SessionKey: hex.EncodeToString(make([]byte, 32))})
		_ = srv.Send(&ipc.Envelope{Type: ipc.TypeAuthResponse, ID: "auth", Payload: payload})
	}()
	if err := c.authenticate(); err != nil {
		t.Fatalf("authenticate: %v", err)
	}
	if req := <-gotReq; req.SpawnTicket != "" || req.LogindSessionID != "" {
		t.Fatalf("plain helper sent ticket=%v logindSession=%q", req.SpawnTicket != "", req.LogindSessionID)
	}
}
