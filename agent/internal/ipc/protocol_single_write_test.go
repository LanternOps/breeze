package ipc

import (
	"bytes"
	"encoding/binary"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
)

// writeRecorder is a net.Conn that records every Write it is handed, so a test
// can see how a frame was split across writes. failAt makes the n-th Write
// (1-based) fail after taking its first `partial` bytes.
type writeRecorder struct {
	net.Conn
	mu      sync.Mutex
	writes  [][]byte
	failAt  int
	partial int // bytes the failing Write still takes
}

func (w *writeRecorder) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.failAt > 0 && len(w.writes)+1 == w.failAt {
		n := min(w.partial, len(p))
		w.writes = append(w.writes, append([]byte(nil), p[:n]...))
		return n, errors.New("pipe broken")
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

// A write that fails part-way (some bytes on the wire) still poisons the
// Conn: a later frame must never follow a partial one onto the wire.
func TestSendPartialWritePoisons(t *testing.T) {
	rec := newWriteRecorder(t)
	rec.failAt = 1
	rec.partial = 6 // the header and two body bytes went out, then the error
	c := NewConn(rec)
	if err := c.SendTyped("a", TypePing, nil); err == nil {
		t.Fatal("send over a broken pipe succeeded")
	}
	if err := c.SendTyped("b", TypePing, nil); err == nil {
		t.Fatal("send after a partial write was not refused")
	}
	if len(rec.writes) != 1 || len(rec.writes[0]) != 6 {
		t.Fatalf("writes = %d (first %d bytes), want only the failed partial one", len(rec.writes), len(rec.writes[0]))
	}
}

// #12808: PartialFrame tells a peer that hung up between frames from one that
// cut a frame, including when the cut falls in a later, resumed Recv (whose
// io.ReadFull then reads nothing and returns plain io.EOF).
func TestPartialFrameAfterAResumedRecvSeesEOF(t *testing.T) {
	reader, writer := net.Pipe()
	t.Cleanup(func() { _ = reader.Close(); _ = writer.Close() })
	c := NewConn(reader)
	frame := rawFrame(t, "cut", 1)
	go func() { _, _ = writer.Write(frame[:4]) }() // the header only
	recvTimesOut(t, c)
	if !c.PartialFrame() {
		t.Fatal("the header was read, but PartialFrame is false")
	}
	_ = writer.Close()
	_, err := c.Recv()
	if !errors.Is(err, io.EOF) {
		t.Fatalf("Recv after the cut = %v, want io.EOF (the resumed read saw no bytes)", err)
	}
	if !c.PartialFrame() {
		t.Fatal("a frame cut after its header reads as a clean hang-up")
	}

	idleR, idleW := net.Pipe()
	t.Cleanup(func() { _ = idleR.Close() })
	idle := NewConn(idleR)
	_ = idleW.Close()
	if _, err := idle.Recv(); !errors.Is(err, io.EOF) || idle.PartialFrame() {
		t.Fatalf("between frames: err=%v partial=%v, want io.EOF and false", err, idle.PartialFrame())
	}
}
