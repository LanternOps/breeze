package sessionbroker

import (
	"context"
	"net"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

type fakeOwnedPeerProcess struct {
	pid uint32

	mu         sync.Mutex
	alive      bool
	terminated int
	closed     int
	claimed    chan struct{}
	release    chan struct{}
}

func newFakeOwnedPeerProcess(pid uint32) *fakeOwnedPeerProcess {
	return &fakeOwnedPeerProcess{pid: pid, alive: true}
}

func (p *fakeOwnedPeerProcess) ProcessID() uint32 { return p.pid }
func (p *fakeOwnedPeerProcess) Alive() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.alive, nil
}
func (p *fakeOwnedPeerProcess) Terminate() error {
	if p.claimed != nil {
		close(p.claimed)
		<-p.release
	}
	p.mu.Lock()
	p.terminated++
	p.alive = false
	p.mu.Unlock()
	return nil
}
func (p *fakeOwnedPeerProcess) Close() error {
	p.mu.Lock()
	p.closed++
	p.mu.Unlock()
	return nil
}
func (p *fakeOwnedPeerProcess) counts() (terminated, closed int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.terminated, p.closed
}

func newOwnedSession(t *testing.T, broker *Broker, key HelperKey, process ownedPeerProcess) *Session {
	t.Helper()
	server, client := net.Pipe()
	t.Cleanup(func() { _ = client.Close() })
	session := NewSession(ipc.NewConn(server), 0, "sid", "user", "", "session", nil)
	session.PID = int(process.ProcessID())
	session.WinSessionID = "7"
	session.HelperRole = key.Role
	session.peerProcess = newOwnedPeerProcessRef(process)
	session.broker = broker
	broker.mu.Lock()
	broker.sessions[session.SessionID] = session
	broker.byIdentity[session.IdentityKey] = []*Session{session}
	broker.helperByKey[key] = session
	broker.publishSnapshotLocked()
	broker.mu.Unlock()
	return session
}

func TestLifecycleObserversAreAdditiveAndRunAfterUnlock(t *testing.T) {
	b := New("observer-"+t.Name(), nil)
	defer b.Close()
	session := &Session{SessionID: "s"}
	primary := make(chan struct{}, 1)
	observer := make(chan struct{}, 1)
	b.SetSessionAuthenticatedHandler(func(*Session) { primary <- struct{}{} })
	remove := b.AddSessionLifecycleObserver(func(*Session) {
		_ = b.SessionCount()
		observer <- struct{}{}
	}, nil)
	defer remove()

	b.fireSessionAuthenticated(session)
	select {
	case <-primary:
	case <-time.After(time.Second):
		t.Fatal("primary authentication handler did not run")
	}
	select {
	case <-observer:
	case <-time.After(time.Second):
		t.Fatal("lifecycle observer did not run")
	}
}

func TestSessionCloseReleasesOwnedPeerProcessOnce(t *testing.T) {
	b := New("peer-close-"+t.Name(), nil)
	proc := newFakeOwnedPeerProcess(5100)
	session := newOwnedSession(t, b, HelperKey{WindowsSessionID: 7, Role: "system"}, proc)

	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	if err := session.Close(); err != nil {
		t.Fatal(err)
	}
	terminated, closed := proc.counts()
	if terminated != 0 || closed != 1 {
		t.Fatalf("terminate=%d close=%d, want 0 and 1", terminated, closed)
	}
}

func TestUnexpectedDisconnectReleasesOwnedPeerProcess(t *testing.T) {
	b := New("peer-disconnect-"+t.Name(), nil)
	proc := newFakeOwnedPeerProcess(5200)
	session := newOwnedSession(t, b, HelperKey{WindowsSessionID: 7, Role: "user"}, proc)

	b.removeSession(session)
	terminated, closed := proc.counts()
	if terminated != 0 || closed != 1 {
		t.Fatalf("terminate=%d close=%d, want 0 and 1", terminated, closed)
	}
}

func TestConcurrentTerminateAndSessionCloseTerminatesAndConsumesPeerHandleOnce(t *testing.T) {
	b := New("peer-race-"+t.Name(), nil)
	proc := newFakeOwnedPeerProcess(5300)
	proc.claimed = make(chan struct{})
	proc.release = make(chan struct{})
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	session := newOwnedSession(t, b, key, proc)

	terminated := make(chan struct{})
	go func() {
		b.TerminateHelperKey(key)
		close(terminated)
	}()
	<-proc.claimed
	closed := make(chan struct{})
	go func() {
		_ = session.Close()
		close(closed)
	}()
	close(proc.release)
	<-terminated
	<-closed

	terminateCount, closeCount := proc.counts()
	if terminateCount != 1 || closeCount != 1 {
		t.Fatalf("terminate=%d close=%d, want 1 each", terminateCount, closeCount)
	}
}

func TestBrokerStopAcceptingAndWaitUnblocksStalledPreAuthConnection(t *testing.T) {
	b := New("preauth-"+t.Name(), nil)
	server, client := net.Pipe()
	defer client.Close()
	if !b.startAcceptedConnection(server) {
		t.Fatal("failed to register accepted connection")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := b.StopAcceptingAndWait(ctx); err != nil {
		t.Fatalf("StopAcceptingAndWait: %v", err)
	}
}

func TestLifecycleStopTerminatesScheduledLogicalHelperWithoutTrackedSpawn(t *testing.T) {
	b := New("scheduled-stop-"+t.Name(), nil)
	proc := newFakeOwnedPeerProcess(5400)
	key := HelperKey{WindowsSessionID: 7, Role: "system"}
	newOwnedSession(t, b, key, proc)
	m := newHelperLifecycleManager(b, fakeLifecycleDetector{}, nil, &fakeHelperSpawner{})
	m.gracePeriod = 0
	m.finalWait = 0

	m.Stop()

	terminateCount, closeCount := proc.counts()
	if terminateCount != 1 || closeCount != 1 {
		t.Fatalf("scheduled helper terminate=%d close=%d, want 1 each", terminateCount, closeCount)
	}
}

func TestBrokerStopAcceptingRetainsConnectionDuringAuthenticatedPublication(t *testing.T) {
	b := New("publishing-"+t.Name(), nil)
	server, client := net.Pipe()
	defer server.Close()
	defer client.Close()
	b.acceptMu.Lock()
	b.preAuthConns[server] = false
	b.preAuthHandlers.Add(1)
	b.acceptMu.Unlock()
	if !b.beginConnectionPublication(server) {
		t.Fatal("failed to enter authenticated publication state")
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	stopped := make(chan error, 1)
	go func() { stopped <- b.StopAcceptingAndWait(ctx) }()
	select {
	case err := <-stopped:
		t.Fatalf("StopAcceptingAndWait returned before publication finished: %v", err)
	case <-time.After(20 * time.Millisecond):
	}
	b.finishPreAuth(server)
	if err := <-stopped; err != nil {
		t.Fatal(err)
	}

	writeDone := make(chan error, 1)
	go func() {
		_, err := server.Write([]byte{1})
		writeDone <- err
	}()
	buffer := make([]byte, 1)
	if _, err := client.Read(buffer); err != nil {
		t.Fatalf("publishing connection was closed: %v", err)
	}
	if err := <-writeDone; err != nil {
		t.Fatalf("write after publication: %v", err)
	}
}
