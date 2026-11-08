package sessionbroker

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// Issue #6106: after a verification times out, nothing may keep waiting for
// its reply. The old late-response goroutine waited for the reply or session
// close, so a helper that hung with its session still connected parked that
// goroutine (and its registration) for the rest of the session.

// goroutinesInFunction counts live goroutines whose stack mentions fn.
func goroutinesInFunction(fn string) int {
	buf := make([]byte, 1<<22)
	n := runtime.Stack(buf, true)
	count := 0
	for _, g := range strings.Split(string(buf[:n]), "\n\n") {
		if strings.Contains(g, fn) {
			count++
		}
	}
	return count
}

func newVerifyTestBroker(t *testing.T) (*Broker, *Session, *ipc.Conn, chan *ipc.Envelope) {
	t.Helper()
	serverConn, clientConn := net.Pipe()
	t.Cleanup(func() {
		_ = serverConn.Close()
		_ = clientConn.Close()
	})
	unsolicited := make(chan *ipc.Envelope, 4)
	session := &Session{
		SessionID: "backup-verify-late-reply-test",
		conn:      ipc.NewConn(serverConn),
		pending:   make(map[string]pendingResponse),
		done:      make(chan struct{}),
	}
	go session.RecvLoop(func(_ *Session, env *ipc.Envelope) { unsolicited <- env })
	broker := &Broker{
		sessions:   make(map[string]*Session),
		byIdentity: make(map[string][]*Session),
	}
	broker.SetBackupSession(session)
	return broker, session, ipc.NewConn(clientConn), unsolicited
}

func pendingEntry(s *Session, id string) (pendingResponse, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.pending[id]
	return p, ok
}

func TestBackupVerificationTimeoutLeavesNoLateReplyWaiter(t *testing.T) {
	for _, commandType := range []string{"backup_verify", "backup_test_restore"} {
		t.Run(commandType, func(t *testing.T) {
			broker, session, helper, unsolicited := newVerifyTestBroker(t)
			const waiter = "sendCommandWithQuiescence"
			baseline := goroutinesInFunction(waiter)

			// The helper takes the verification and the targeted backup_stop but
			// answers only the stop: the verification is wedged while the
			// session stays connected.
			originalSeen := make(chan *ipc.Envelope, 1)
			helperErr := make(chan error, 1)
			go func() {
				originalEnv, err := helper.Recv()
				if err != nil {
					helperErr <- fmt.Errorf("recv original command: %w", err)
					return
				}
				originalSeen <- originalEnv
				stopEnv, err := helper.Recv()
				if err != nil {
					helperErr <- fmt.Errorf("recv stop command: %w", err)
					return
				}
				var stopReq backupipc.BackupCommandRequest
				if err := json.Unmarshal(stopEnv.Payload, &stopReq); err != nil {
					helperErr <- fmt.Errorf("decode stop command: %w", err)
					return
				}
				helperErr <- helper.SendTyped(stopEnv.ID, backupipc.TypeBackupResult, backupipc.BackupCommandResult{
					CommandID: stopReq.CommandID,
					Success:   true,
					Stdout:    `{"stopped":true,"drained":false}`,
				})
			}()

			commandID := "verify-wedged-" + commandType
			if _, err := broker.ForwardBackupCommand(commandID, commandType, nil, 25*time.Millisecond, false); !errors.Is(err, ErrCommandTimeout) {
				t.Fatalf("ForwardBackupCommand error = %v, want ErrCommandTimeout", err)
			}
			var originalEnv *ipc.Envelope
			select {
			case originalEnv = <-originalSeen:
			case <-time.After(2 * time.Second):
				t.Fatal("helper never received the verification")
			}
			select {
			case err := <-helperErr:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("timed out waiting for the backup_stop exchange")
			}

			// Give a lingering waiter time to show up in the stack dump; a
			// correct build has none from the start.
			deadline := time.Now().Add(500 * time.Millisecond)
			for {
				extra := goroutinesInFunction(waiter) - baseline
				if extra <= 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("%d goroutine(s) still waiting for the timed-out %s's reply", extra, commandType)
				}
				time.Sleep(10 * time.Millisecond)
			}

			entry, ok := pendingEntry(session, commandID)
			if !ok || !entry.discard || entry.ch != nil {
				t.Fatalf("registration after timeout = %+v (present=%v), want a discard-only tombstone", entry, ok)
			}

			// The reply that finally arrives is consumed, not forwarded as a
			// second terminal result, and it releases the tombstone.
			if err := helper.SendTyped(originalEnv.ID, backupipc.TypeBackupResult, backupipc.BackupCommandResult{
				CommandID: commandID,
				Success:   false,
				Stderr:    "context canceled",
			}); err != nil {
				t.Fatalf("send late reply: %v", err)
			}
			select {
			case env := <-unsolicited:
				t.Fatalf("late verification reply escaped as unsolicited: type=%s id=%s", env.Type, env.ID)
			case <-time.After(100 * time.Millisecond):
			}
			deadline = time.Now().Add(2 * time.Second)
			for {
				if _, still := pendingEntry(session, commandID); !still {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("tombstone not released after its late reply was consumed")
				}
				time.Sleep(5 * time.Millisecond)
			}
		})
	}
}

// A tombstone whose reply never comes is dropped with the session.
func TestAbandonedReplyTombstoneClearedOnSessionClose(t *testing.T) {
	s := newAbandonTestSession(t, nil)
	if _, err := s.sendCommandAbandoningLateReply("cmd-abandon", backupipc.TypeBackupCommand, nil, time.Millisecond); !errors.Is(err, ErrCommandTimeout) {
		t.Fatalf("error = %v, want ErrCommandTimeout", err)
	}
	if entry, ok := pendingEntry(s, "cmd-abandon"); !ok || !entry.discard {
		t.Fatalf("registration = %+v (present=%v), want a tombstone", entry, ok)
	}
	// The id stays reserved while its tombstone exists, as it did while the
	// old waiter held it: a reused id must not inherit the stale reply.
	if _, err := s.sendCommandAbandoningLateReply("cmd-abandon", backupipc.TypeBackupCommand, nil, time.Millisecond); !errors.Is(err, ErrDuplicateCommand) {
		t.Fatalf("reusing an abandoned id: error = %v, want ErrDuplicateCommand", err)
	}
	_ = s.closeTransport()
	if _, ok := pendingEntry(s, "cmd-abandon"); ok {
		t.Fatal("tombstone survived session close")
	}
}

// replyOnWriteConn hands the outgoing frame to onWrite synchronously, so the
// reply is already delivered when the sender starts waiting.
type replyOnWriteConn struct {
	net.Conn
	once    sync.Once
	onWrite func()
}

func (c *replyOnWriteConn) Write(p []byte) (int, error) {
	if c.onWrite != nil {
		c.once.Do(c.onWrite)
	}
	return len(p), nil
}

func (c *replyOnWriteConn) Close() error { return nil }

func newAbandonTestSession(t *testing.T, onWrite func(s *Session)) *Session {
	t.Helper()
	brokerSide, peer := net.Pipe()
	t.Cleanup(func() {
		_ = brokerSide.Close()
		_ = peer.Close()
	})
	conn := &replyOnWriteConn{Conn: brokerSide}
	s := &Session{
		SessionID: "abandon-test",
		conn:      ipc.NewConn(conn),
		pending:   make(map[string]pendingResponse),
		done:      make(chan struct{}),
	}
	if onWrite != nil {
		conn.onWrite = func() { onWrite(s) }
	}
	return s
}

// A reply delivered by the time the wait expires is the command's result, not
// a timeout. Reporting a timeout would discard a finished verification's
// counts and cancel a command that already ended.
func TestAbandoningSendPrefersDeliveredReplyOverTimeout(t *testing.T) {
	for i := 0; i < 200; i++ {
		s := newAbandonTestSession(t, func(s *Session) {
			if !s.HandleResponse(&ipc.Envelope{ID: "cmd-race", Type: backupipc.TypeBackupResult}) {
				t.Errorf("reply for cmd-race was not matched")
			}
		})
		resp, err := s.sendCommandAbandoningLateReply("cmd-race", backupipc.TypeBackupCommand, nil, time.Nanosecond)
		if err != nil {
			t.Fatalf("iteration %d: delivered reply lost to the timeout: %v", i, err)
		}
		if resp == nil || resp.ID != "cmd-race" {
			t.Fatalf("iteration %d: got %+v, want the delivered reply", i, resp)
		}
		if _, ok := pendingEntry(s, "cmd-race"); ok {
			t.Fatalf("iteration %d: registration left behind after a delivered reply", i)
		}
	}
}
