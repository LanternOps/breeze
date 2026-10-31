package ipc

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// Regression tests for issues #10541 / #10423: the user helper's command loop
// (and breeze-backup's) arm a short read deadline before every Recv and treat a
// timeout as a harmless idle tick. Recv used to read the 4-byte header and the
// body with two io.ReadFull calls and keep no state between calls, so a
// deadline that fired after any part of a frame had been consumed threw those
// bytes away. The next Recv then started mid-frame and parsed the first four
// body bytes — `{"id` — as a length: "message too large: 2065852772".
//
// Each test hands the peer a frame in pieces, lets a Recv time out between the
// pieces, then delivers the rest. Ordering is enforced by the test itself (the
// late piece is written only after the timed-out Recv has returned), so the
// result does not depend on scheduling.

// rawFrame builds the exact bytes Send would put on the wire for an envelope
// with the given id and seq under the zero (pre-auth) key.
func rawFrame(t *testing.T, id string, seq uint64) []byte {
	t.Helper()
	env := &Envelope{ID: id, Type: TypePing, Seq: seq}
	env.HMAC = (&Conn{}).computeHMAC(env)
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal envelope: %v", err)
	}
	frame := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)
	return frame
}

// recvTimesOut arms a short read deadline and asserts Recv returns a timeout
// that callers recognise as one (the same net.Error / os.ErrDeadlineExceeded
// checks the helper and breeze-backup loops use).
func recvTimesOut(t *testing.T, c *Conn) {
	t.Helper()
	if err := c.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	env, err := c.Recv()
	if err == nil {
		t.Fatalf("Recv returned envelope %q before the frame was complete", env.ID)
	}
	var netErr net.Error
	if !errors.Is(err, os.ErrDeadlineExceeded) && !(errors.As(err, &netErr) && netErr.Timeout()) {
		t.Fatalf("Recv error = %v, want a timeout", err)
	}
}

// recvOK clears the deadline (as the next loop iteration's fresh deadline
// would) and asserts the next Recv yields the expected envelope.
func recvOK(t *testing.T, c *Conn, wantID string, wantSeq uint64) {
	t.Helper()
	if err := c.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	env, err := c.Recv()
	if err != nil {
		t.Fatalf("Recv after a mid-frame timeout: %v (stream desynced)", err)
	}
	if env.ID != wantID || env.Seq != wantSeq {
		t.Fatalf("Recv got id=%q seq=%d, want id=%q seq=%d", env.ID, env.Seq, wantID, wantSeq)
	}
}

func mustWrite(t *testing.T, c net.Conn, b []byte) {
	t.Helper()
	if _, err := c.Write(b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func TestRecvResumesFrameAfterReadDeadline(t *testing.T) {
	first := rawFrame(t, "first", 1)
	second := rawFrame(t, "second", 2)

	cases := []struct {
		name  string
		split int // bytes of `first` delivered before the timeout
	}{
		{"full header then late body", 4},
		{"partial header then rest", 2},
		{"header and partial body then rest", 4 + 5},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			readerRaw, writerRaw := createSocketPair(t)
			defer func() { _ = readerRaw.Close() }()
			defer func() { _ = writerRaw.Close() }()
			reader := NewConn(readerRaw)

			mustWrite(t, writerRaw, first[:tc.split])
			recvTimesOut(t, reader)

			// A second idle tick while still mid-frame must not lose state
			// either: the loops re-arm the deadline every iteration.
			recvTimesOut(t, reader)

			mustWrite(t, writerRaw, first[tc.split:])
			recvOK(t, reader, "first", 1)

			// The frame after the resumed one starts on a clean boundary.
			mustWrite(t, writerRaw, second)
			recvOK(t, reader, "second", 2)
		})
	}
}

// TestRecvTimeoutWithNoBytesStillIdle guards the common path the loops rely on:
// a deadline with nothing on the wire is a plain timeout and the next frame
// parses normally.
func TestRecvTimeoutWithNoBytesStillIdle(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)

	recvTimesOut(t, reader)
	mustWrite(t, writerRaw, rawFrame(t, "only", 1))
	recvOK(t, reader, "only", 1)
}

// TestRecvTimeoutsAcrossLargeFrame delivers a near-limit body in many slices,
// each separated by a timed-out Recv, the way a large frame trickles through a
// pipe whose writer is descheduled between chunks.
func TestRecvTimeoutsAcrossLargeFrame(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)

	env := &Envelope{ID: "big", Type: TypePing, Seq: 1, Payload: mustJSONString(t, 256*1024)}
	env.HMAC = (&Conn{}).computeHMAC(env)
	data, err := json.Marshal(env)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	frame := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)

	const slices = 6
	step := len(frame) / slices
	for i := 0; i < slices-1; i++ {
		mustWrite(t, writerRaw, frame[i*step:(i+1)*step])
		// Drain what was written so far, then time out waiting for the rest.
		recvTimesOut(t, reader)
	}
	mustWrite(t, writerRaw, frame[(slices-1)*step:])
	recvOK(t, reader, "big", 1)
}

// TestRecvTooLargeReportsHeaderBytes: when the stream is desynced anyway (an
// older peer, a corrupt writer), the error must carry the raw header bytes so
// the next occurrence is diagnosable from the shipped log line (#10423).
func TestRecvTooLargeReportsHeaderBytes(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)

	mustWrite(t, writerRaw, []byte(`{"id":"x"}`))
	if err := reader.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	_, err := reader.Recv()
	if err == nil {
		t.Fatal("Recv accepted a JSON body as a frame header")
	}
	if !strings.Contains(err.Error(), "message too large: 2065852772") {
		t.Fatalf("error = %v, want the too-large length", err)
	}
	if !strings.Contains(err.Error(), `7b226964`) {
		t.Fatalf("error = %v, want the raw header bytes in hex", err)
	}
}

// TestRecvResumesFrameAfterReadDeadlineNetPipe repeats the header-then-late-body
// case over net.Pipe, whose synchronous Write hands bytes straight to the
// reader with no kernel buffer.
func TestRecvResumesFrameAfterReadDeadlineNetPipe(t *testing.T) {
	readerRaw, writerRaw := net.Pipe()
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)
	frame := rawFrame(t, "piped", 1)

	// net.Pipe's Write blocks until the reader has consumed the bytes, so each
	// piece goes on its own goroutine and is awaited before moving on.
	writePiece := func(b []byte) chan error {
		done := make(chan error, 1)
		go func() { _, err := writerRaw.Write(b); done <- err }()
		return done
	}

	headerDone := writePiece(frame[:4])
	recvTimesOut(t, reader) // consumes the header, then times out on the body
	if err := <-headerDone; err != nil {
		t.Fatalf("write header: %v", err)
	}

	bodyDone := writePiece(frame[4:])
	recvOK(t, reader, "piped", 1)
	if err := <-bodyDone; err != nil {
		t.Fatalf("write body: %v", err)
	}
}
