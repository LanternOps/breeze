package sessionbroker

import (
	"net"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// respondThenCloseConn is a net.Conn whose first Write (the outgoing command
// frame) synchronously runs onWrite before returning. The test uses it to make
// the helper's response land in the pending channel AND the session close
// before the sending goroutine reaches its select — the exact interleaving a
// helper produces when it answers and then exits while the forwarder is still
// descheduled (issue #6918).
type respondThenCloseConn struct {
	net.Conn
	once    sync.Once
	onWrite func()
}

func (c *respondThenCloseConn) Write(p []byte) (int, error) {
	c.once.Do(c.onWrite)
	return len(p), nil
}

func (c *respondThenCloseConn) Close() error { return nil }

func newRespondThenCloseSession(t *testing.T, id string) *Session {
	t.Helper()
	brokerSide, peer := net.Pipe()
	t.Cleanup(func() {
		_ = brokerSide.Close()
		_ = peer.Close()
	})
	conn := &respondThenCloseConn{Conn: brokerSide}
	s := &Session{
		SessionID: "response-close-race",
		conn:      ipc.NewConn(conn),
		pending:   make(map[string]pendingResponse),
		done:      make(chan struct{}),
	}
	conn.onWrite = func() {
		// What RecvLoop does with the helper's reply, then what
		// finishHelperSession does when the helper's socket hits EOF.
		if !s.HandleResponse(&ipc.Envelope{ID: id, Type: "race_result"}) {
			t.Errorf("response for %q was not matched to a pending command", id)
		}
		_ = s.closeTransport()
	}
	return s
}

// A response that was already delivered must win over a session close that
// happened after it. Go's select picks uniformly among ready cases, so without
// an explicit preference half of these iterations report "session closed while
// waiting for response" for a command the helper actually answered.
func TestSendCommand_DeliveredResponseBeatsLaterSessionClose(t *testing.T) {
	for i := 0; i < 200; i++ {
		s := newRespondThenCloseSession(t, "cmd-race")
		resp, err := s.SendCommand("cmd-race", "race_cmd", nil, 5*time.Second)
		if err != nil {
			t.Fatalf("iteration %d: delivered response discarded: %v", i, err)
		}
		if resp == nil || resp.ID != "cmd-race" {
			t.Fatalf("iteration %d: expected the delivered response, got %+v", i, resp)
		}
	}
}

func TestSendCommandWithQuiescence_DeliveredResponseBeatsLaterSessionClose(t *testing.T) {
	for i := 0; i < 200; i++ {
		s := newRespondThenCloseSession(t, "cmd-race")
		resp, quiesced, err := s.sendCommandWithQuiescence("cmd-race", "race_cmd", nil, 5*time.Second)
		if err != nil {
			t.Fatalf("iteration %d: delivered response discarded: %v", i, err)
		}
		if resp == nil || resp.ID != "cmd-race" {
			t.Fatalf("iteration %d: expected the delivered response, got %+v", i, resp)
		}
		if quiesced != nil {
			t.Fatalf("iteration %d: a proven-complete command returned a quiescence channel", i)
		}
	}
}
