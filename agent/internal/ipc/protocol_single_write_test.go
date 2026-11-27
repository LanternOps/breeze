package ipc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"net"
	"sync"
	"testing"
)

// writeRecorder is a net.Conn that records every Write it is handed, so a test
// can see how a frame was split across writes. failAt makes the n-th Write
// (1-based) fail without writing anything.
type writeRecorder struct {
	net.Conn
	mu     sync.Mutex
	writes [][]byte
	failAt int
}

func (w *writeRecorder) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.failAt > 0 && len(w.writes)+1 == w.failAt {
		w.writes = append(w.writes, nil)
		return 0, errors.New("pipe broken")
	}
	w.writes = append(w.writes, append([]byte(nil), p...))
	return len(p), nil
}

func newWriteRecorder(t *testing.T) *writeRecorder {
	t.Helper()
	a, b := net.Pipe()
	t.Cleanup(func() { _ = a.Close(); _ = b.Close() })
	return &writeRecorder{Conn: a}
}

// #12808: Send hands the transport one buffer per frame, header and body
// together. Two writes put the header on a named pipe alone; Assist's reader,
// which raced each read against a 250 ms tick, could be cancelled between the
// two and lose the header, desyncing the stream. One write gives a peer the
// whole frame in one delivery wherever the transport allows it.
func TestSendWritesEachFrameInOneWrite(t *testing.T) {
	rec := newWriteRecorder(t)
	c := NewConn(rec)
	for i, id := range []string{"a", "b"} {
		if err := c.SendTyped(id, TypePing, nil); err != nil {
			t.Fatalf("send %d: %v", i, err)
		}
	}
	if len(rec.writes) != 2 {
		t.Fatalf("%d writes for 2 frames, want 2 (one per frame)", len(rec.writes))
	}
	for i, w := range rec.writes {
		if len(w) < 4 {
			t.Fatalf("write %d is %d bytes: not a whole frame", i, len(w))
		}
		if n := binary.BigEndian.Uint32(w[:4]); int(n) != len(w)-4 {
			t.Fatalf("write %d: header says %d, body is %d", i, n, len(w)-4)
		}
		if !bytes.HasPrefix(w[4:], []byte(`{"id"`)) {
			t.Fatalf("write %d body = %q", i, w[4:])
		}
	}
}

// A failed write still poisons the Conn: a later frame must never follow a
// partial one onto the wire.
func TestSendFailedSingleWritePoisons(t *testing.T) {
	rec := newWriteRecorder(t)
	rec.failAt = 1
	c := NewConn(rec)
	if err := c.SendTyped("a", TypePing, nil); err == nil {
		t.Fatal("send over a broken pipe succeeded")
	}
	if err := c.SendTyped("b", TypePing, nil); err == nil {
		t.Fatal("send after a failed write was not refused")
	}
	if len(rec.writes) != 1 {
		t.Fatalf("%d writes reached the transport, want only the failed one", len(rec.writes))
	}
}
