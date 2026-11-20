package userhelper

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// pipedCommandLoop runs c's command loop over an in-memory pipe and returns
// the agent's end. net.Pipe is synchronous, so a handler's reply blocks until
// the test reads it: that is what keeps a handler observably in flight.
func pipedCommandLoop(t *testing.T) (*Client, *ipc.Conn, <-chan struct{}) {
	t.Helper()
	c := NewWithOptions("/nonexistent.sock", ipc.HelperRoleUser, ipc.HelperBinaryDesktopHelper, ipc.DesktopContextUserSession)
	clientEnd, agentEnd := net.Pipe()
	c.conn = ipc.NewConn(clientEnd)
	agent := ipc.NewConn(agentEnd)
	done := make(chan struct{})
	go func() { _ = c.commandLoop(); close(done) }()
	t.Cleanup(func() {
		_ = agentEnd.Close() // unblocks any send, so Stop cannot hang
		c.Stop()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("command loop did not stop")
		}
	})
	return c, agent, done
}

// A payload no handler can parse: each tracked handler answers it with an
// error reply, which is enough to hold it in flight on the pipe.
var unparseablePayload = json.RawMessage(`"not an object"`)

// #11292 review: the self-restart must see every handler it must not
// interrupt. Each of these message types is dispatched through goTracked; a
// plain safeGo would leave the helper "idle" while the handler runs.
func TestCommandLoopTracksHandlersTheHelperMustNotRestartUnder(t *testing.T) {
	for _, typ := range []string{
		ipc.TypeCommand,
		ipc.TypeNotify,
		ipc.TypePamRequestDialog,
		ipc.TypeConsentRequest,
		ipc.TypeDesktopStart,
		ipc.TypeLaunchProcess,
	} {
		t.Run(typ, func(t *testing.T) {
			c, agent, _ := pipedCommandLoop(t)
			id := "msg-" + typ
			if err := agent.Send(&ipc.Envelope{ID: id, Type: typ, Payload: unparseablePayload}); err != nil {
				t.Fatalf("send: %v", err)
			}
			waitFor(t, func() bool { return c.selfRestartBusy() != "" })

			reply, err := agent.Recv()
			if err != nil {
				t.Fatalf("recv: %v", err)
			}
			if reply.ID != id {
				t.Fatalf("reply id = %q, want %q", reply.ID, id)
			}
			waitFor(t, func() bool { return c.selfRestartBusy() == "" })
		})
	}
}

// Once the final check before a self-restart passes, the helper takes no new
// work: a message that arrives then is not started (the process is about to
// exit and the agent sees the connection drop). If the exit does not happen
// within selfRestartIntakeHoldLimit, intake resumes and the message runs.
func TestHoldForSelfRestartStopsIntake(t *testing.T) {
	restore := selfRestartIntakeHoldLimit
	selfRestartIntakeHoldLimit = 400 * time.Millisecond
	t.Cleanup(func() { selfRestartIntakeHoldLimit = restore })

	c, agent, _ := pipedCommandLoop(t)
	if busy := c.holdForSelfRestart(); busy != "" {
		t.Fatalf("idle client reported busy %q", busy)
	}
	heldAt := time.Now()
	if err := agent.Send(&ipc.Envelope{ID: "late", Type: ipc.TypeCommand, Payload: unparseablePayload}); err != nil {
		t.Fatalf("send: %v", err)
	}
	time.Sleep(100 * time.Millisecond)
	if busy := c.selfRestartBusy(); busy != "" {
		t.Fatalf("a command started while intake was held (busy %q)", busy)
	}

	reply, err := agent.Recv()
	if err != nil {
		t.Fatalf("recv: %v", err)
	}
	if reply.ID != "late" {
		t.Fatalf("reply id = %q, want late", reply.ID)
	}
	if waited := time.Since(heldAt); waited < 300*time.Millisecond {
		t.Fatalf("command ran after %v, before the hold limit", waited)
	}
}

// A hold that finds work still running is released at once, so the command
// that follows runs normally.
func TestHoldForSelfRestartReleasesWhenBusy(t *testing.T) {
	c, agent, _ := pipedCommandLoop(t)
	release := make(chan struct{})
	c.goTracked("consent_request", func() { <-release })
	waitFor(t, func() bool { return c.selfRestartBusy() != "" })

	if busy := c.holdForSelfRestart(); busy == "" {
		t.Fatal("hold reported idle with a handler running")
	}
	close(release)
	waitFor(t, func() bool { return c.selfRestartBusy() == "" })

	if err := agent.Send(&ipc.Envelope{ID: "next", Type: ipc.TypeCommand, Payload: unparseablePayload}); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := agent.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	if reply, err := agent.Recv(); err != nil || reply.ID != "next" {
		t.Fatalf("command after a released hold: reply %+v, %v", reply, err)
	}
}

// Stopping the client while intake is held ends the command loop instead of
// leaving it waiting for the hold limit.
func TestHoldForSelfRestartYieldsToStop(t *testing.T) {
	restore := selfRestartIntakeHoldLimit
	selfRestartIntakeHoldLimit = time.Hour
	t.Cleanup(func() { selfRestartIntakeHoldLimit = restore })

	c, agent, done := pipedCommandLoop(t)
	if busy := c.holdForSelfRestart(); busy != "" {
		t.Fatalf("idle client reported busy %q", busy)
	}
	if err := agent.Send(&ipc.Envelope{ID: "late", Type: ipc.TypeCommand, Payload: unparseablePayload}); err != nil {
		t.Fatalf("send: %v", err)
	}
	go func() {
		for {
			if _, err := agent.Recv(); err != nil {
				return
			}
		}
	}()
	c.Stop()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("command loop still waiting on the hold after Stop")
	}
	if busy := c.selfRestartBusy(); busy != "" {
		t.Fatalf("the held command ran after Stop (busy %q)", busy)
	}
}
