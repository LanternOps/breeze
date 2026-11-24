package userhelper

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #12624: a helper whose process can no longer use DXGI asks to be replaced,
// but only while nothing would be interrupted.

func TestHelperRecycleSupported(t *testing.T) {
	for _, tc := range []struct {
		goos string
		role ipc.HelperRole
		want bool
	}{
		{"windows", ipc.HelperRoleSystem, true},
		{"windows", ipc.HelperRoleUser, false},
		{"darwin", ipc.HelperRoleSystem, false},
		{"linux", ipc.HelperRoleSystem, false},
	} {
		if got := helperRecycleSupported(tc.goos, tc.role); got != tc.want {
			t.Errorf("helperRecycleSupported(%s, %s) = %v, want %v", tc.goos, tc.role, got, tc.want)
		}
	}
}

type recycleWatchProbe struct {
	mu     sync.Mutex
	poison string
	busy   string
	sent   []string
}

func (p *recycleWatchProbe) set(poison, busy string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.poison, p.busy = poison, busy
}

func (p *recycleWatchProbe) count() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.sent)
}

func startRecycleWatch(t *testing.T, p *recycleWatchProbe, changed chan struct{}, minGap time.Duration) {
	t.Helper()
	done := make(chan struct{})
	exited := make(chan struct{})
	go func() {
		defer close(exited)
		runRecycleWatch(done, recycleWatchConfig{
			poisoned: func() string { p.mu.Lock(); defer p.mu.Unlock(); return p.poison },
			busy:     func() string { p.mu.Lock(); defer p.mu.Unlock(); return p.busy },
			send: func(reason string) error {
				p.mu.Lock()
				defer p.mu.Unlock()
				p.sent = append(p.sent, reason)
				return nil
			},
			changed: changed,
			settle:  time.Millisecond,
			poll:    5 * time.Millisecond,
			minGap:  minGap,
			maxGap:  time.Hour,
		})
	}()
	t.Cleanup(func() {
		close(done)
		select {
		case <-exited:
		case <-time.After(2 * time.Second):
			t.Error("recycle watch did not stop")
		}
	})
}

func TestRecycleWatchAsksOnlyWhenPoisonedAndIdle(t *testing.T) {
	p := &recycleWatchProbe{}
	startRecycleWatch(t, p, make(chan struct{}, 1), time.Hour)
	time.Sleep(40 * time.Millisecond)
	if n := p.count(); n != 0 {
		t.Fatalf("healthy helper asked %d times", n)
	}
	p.set("leaked", "remote desktop session active")
	time.Sleep(40 * time.Millisecond)
	if n := p.count(); n != 0 {
		t.Fatalf("a helper hosting a live session asked %d times", n)
	}
	p.set("leaked", "")
	waitFor(t, func() bool { return p.count() == 1 })
	time.Sleep(40 * time.Millisecond)
	if n := p.count(); n != 1 {
		t.Errorf("asked %d times inside the gap, want 1", n)
	}
}

func TestRecycleWatchActsOnTheSignalWithoutWaitingForThePoll(t *testing.T) {
	p := &recycleWatchProbe{}
	changed := make(chan struct{}, 1)
	done := make(chan struct{})
	defer close(done)
	go runRecycleWatch(done, recycleWatchConfig{
		poisoned: func() string { p.mu.Lock(); defer p.mu.Unlock(); return p.poison },
		busy:     func() string { return "" },
		send: func(reason string) error {
			p.mu.Lock()
			defer p.mu.Unlock()
			p.sent = append(p.sent, reason)
			return nil
		},
		changed: changed, settle: time.Millisecond, poll: time.Hour, minGap: time.Hour, maxGap: time.Hour,
	})
	p.set("abandoned", "")
	changed <- struct{}{}
	waitFor(t, func() bool { return p.count() == 1 })
}

func TestRecycleWatchRepeatsWithAGrowingGap(t *testing.T) {
	gap := time.Second
	for _, want := range []time.Duration{2 * time.Second, 4 * time.Second, 5 * time.Second, 5 * time.Second} {
		gap = nextRecycleGap(gap, 5*time.Second)
		if gap != want {
			t.Errorf("gap = %s, want %s", gap, want)
		}
	}
	p := &recycleWatchProbe{}
	p.set("leaked", "")
	startRecycleWatch(t, p, make(chan struct{}, 1), 10*time.Millisecond)
	waitFor(t, func() bool { return p.count() >= 3 })
}

func poisonForTest(t *testing.T, reason string) {
	t.Helper()
	prev := captureProcessPoisoned
	captureProcessPoisoned = func() string { return reason }
	t.Cleanup(func() { captureProcessPoisoned = prev })
}

func prepareRecycle(t *testing.T, agent *ipc.Conn) ipc.HelperRecyclePrepareResult {
	t.Helper()
	if err := agent.Send(&ipc.Envelope{ID: "recycle-1", Type: ipc.TypeHelperRecyclePrepare}); err != nil {
		t.Fatalf("send: %v", err)
	}
	_ = agent.SetReadDeadline(time.Now().Add(3 * time.Second))
	reply, err := agent.Recv()
	if err != nil {
		t.Fatalf("recv: %v", err)
	}
	if reply.ID != "recycle-1" || reply.Type != ipc.TypeHelperRecyclePrepare {
		t.Fatalf("reply = %s %s", reply.ID, reply.Type)
	}
	var res ipc.HelperRecyclePrepareResult
	if err := json.Unmarshal(reply.Payload, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func TestRecyclePrepareHoldsIntakeWhenIdle(t *testing.T) {
	poisonForTest(t, "leaked")
	c, agent, _ := pipedCommandLoop(t)
	if res := prepareRecycle(t, agent); !res.Ready {
		t.Fatalf("idle poisoned helper refused: %+v", res)
	}
	c.intakeMu.Lock()
	held := c.intakeHold != nil
	c.intakeMu.Unlock()
	if !held {
		t.Error("the helper answered ready but still takes work")
	}
}

func TestRecyclePrepareRefusesWhenBusy(t *testing.T) {
	poisonForTest(t, "leaked")
	c, agent, _ := pipedCommandLoop(t)
	c.desktopMgr.mgr.SetSessionActiveForTest("live", true)
	t.Cleanup(func() { c.desktopMgr.mgr.SetSessionActiveForTest("live", false) })
	res := prepareRecycle(t, agent)
	if res.Ready || res.Busy == "" {
		t.Fatalf("helper hosting a live session answered %+v", res)
	}
	c.intakeMu.Lock()
	held := c.intakeHold != nil
	c.intakeMu.Unlock()
	if held {
		t.Error("a refused prepare left intake held")
	}
	c.desktopMgr.mgr.SetSessionActiveForTest("live", false)
}

// The pipeline may have been released between the request and the prepare.
func TestRecyclePrepareRefusesWhenNoLongerPoisoned(t *testing.T) {
	poisonForTest(t, "")
	_, agent, _ := pipedCommandLoop(t)
	if res := prepareRecycle(t, agent); res.Ready {
		t.Fatalf("a healthy helper agreed to be replaced: %+v", res)
	}
}

// A stop that is still running, or has not replied yet, is work a replacement
// would interrupt: the service would see the stop fail.
func TestSelfRestartBusyCoversARunningStop(t *testing.T) {
	var stopping atomic.Bool
	prev := sessionTeardownInProgress
	sessionTeardownInProgress = stopping.Load
	t.Cleanup(func() { sessionTeardownInProgress = prev })

	c := NewWithOptions("/nonexistent.sock", ipc.HelperRoleSystem, "", "")
	if busy := c.selfRestartBusy(); busy != "" {
		t.Fatalf("idle client busy: %q", busy)
	}
	stopping.Store(true)
	if busy := c.selfRestartBusy(); busy == "" {
		t.Error("a running session stop did not count as busy")
	}
}

func TestDesktopStopIsTrackedUntilItsReplyIsSent(t *testing.T) {
	c, agent, _ := pipedCommandLoop(t)
	payload, _ := json.Marshal(ipc.DesktopStopRequest{SessionID: "desk-1"})
	if err := agent.Send(&ipc.Envelope{ID: "stop-1", Type: ipc.TypeDesktopStop, Payload: payload}); err != nil {
		t.Fatal(err)
	}
	// net.Pipe is synchronous: the reply is not sent until it is read.
	waitFor(t, func() bool { return c.selfRestartBusy() != "" })
	reply, err := agent.Recv()
	if err != nil || reply.ID != "stop-1" {
		t.Fatalf("reply %+v, %v", reply, err)
	}
	waitFor(t, func() bool { return c.selfRestartBusy() == "" })
}
