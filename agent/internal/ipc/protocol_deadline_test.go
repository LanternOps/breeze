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

// idleDeadline is how long recvTimesOut waits. The bytes under test are already
// in the socket buffer when Recv starts, so the deadline only has to outlast the
// gap between arming it and the first Read; a generous value keeps a stalled CI
// host from timing out before those bytes are consumed (which would make the
// test pass without exercising the resume path).
const idleDeadline = 300 * time.Millisecond

// recvTimesOut arms a read deadline and asserts Recv returns a timeout that
// callers recognise as one (the same net.Error / os.ErrDeadlineExceeded checks
// the helper and breeze-backup loops use).
func recvTimesOut(t *testing.T, c *Conn) {
	t.Helper()
	if err := c.SetReadDeadline(time.Now().Add(idleDeadline)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	_, err := c.Recv()
	assertTimeout(t, err)
}

func assertTimeout(t *testing.T, err error) {
	t.Helper()
	if err == nil {
		t.Fatal("Recv returned an envelope before the frame was complete")
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

// TestRecvTimeoutsAcrossLargeFrame delivers a 256 KiB body in several slices,
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
// reader with no kernel buffer. net.Pipe's Write returns only once the reader
// has consumed the bytes, so the header write completing proves Recv holds the
// header; only then is the deadline forced. No step depends on timing.
func TestRecvResumesFrameAfterReadDeadlineNetPipe(t *testing.T) {
	readerRaw, writerRaw := net.Pipe()
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)
	frame := rawFrame(t, "piped", 1)

	if err := reader.SetReadDeadline(time.Now().Add(10 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	recvErr := make(chan error, 1)
	go func() { _, err := reader.Recv(); recvErr <- err }()

	if _, err := writerRaw.Write(frame[:4]); err != nil {
		t.Fatalf("write header: %v", err)
	}
	// Header consumed; Recv is now blocked on the body. Fire the deadline.
	if err := reader.SetReadDeadline(time.Now()); err != nil {
		t.Fatalf("force deadline: %v", err)
	}
	assertTimeout(t, <-recvErr)

	bodyDone := make(chan error, 1)
	go func() { _, err := writerRaw.Write(frame[4:]); bodyDone <- err }()
	recvOK(t, reader, "piped", 1)
	if err := <-bodyDone; err != nil {
		t.Fatalf("write body: %v", err)
	}
}

// TestRecvBadFrameAfterResumeIsConsumedOnce: a resumed frame that fails HMAC
// validation is reported once and dropped; the next Recv reads the following
// frame rather than re-parsing the bad one.
func TestRecvBadFrameAfterResumeIsConsumedOnce(t *testing.T) {
	readerRaw, writerRaw := createSocketPair(t)
	defer func() { _ = readerRaw.Close() }()
	defer func() { _ = writerRaw.Close() }()
	reader := NewConn(readerRaw)

	bad := rawFrame(t, "bad", 1)
	// Corrupt one hex digit of the HMAC; length and JSON stay valid.
	i := strings.Index(string(bad), `"hmac":"`) + len(`"hmac":"`)
	if bad[i] == '0' {
		bad[i] = '1'
	} else {
		bad[i] = '0'
	}

	mustWrite(t, writerRaw, bad[:4])
	recvTimesOut(t, reader)
	mustWrite(t, writerRaw, bad[4:])
	if err := reader.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	if _, err := reader.Recv(); err == nil || !strings.Contains(err.Error(), "HMAC mismatch") {
		t.Fatalf("Recv error = %v, want HMAC mismatch", err)
	}

	mustWrite(t, writerRaw, rawFrame(t, "good", 2))
	recvOK(t, reader, "good", 2)
}

// TestRecvFramingErrorIsSticky: once the stream has lost sync, every later
// Recv reports the same error without consuming more bytes or blocking.
func TestRecvFramingErrorIsSticky(t *testing.T) {
	cases := []struct {
		name   string
		header []byte
		want   string
	}{
		{"too large", []byte(`{"id`), "message too large: 2065852772"},
		{"zero length", []byte{0, 0, 0, 0}, "zero-length message"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			readerRaw, writerRaw := createSocketPair(t)
			defer func() { _ = readerRaw.Close() }()
			defer func() { _ = writerRaw.Close() }()
			reader := NewConn(readerRaw)

			// Deliver the bad header across a timeout, then a valid frame that
			// must not be mistaken for a fresh boundary.
			mustWrite(t, writerRaw, tc.header[:2])
			recvTimesOut(t, reader)
			mustWrite(t, writerRaw, tc.header[2:])
			mustWrite(t, writerRaw, rawFrame(t, "later", 1))

			for attempt := 0; attempt < 2; attempt++ {
				if err := reader.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
					t.Fatalf("set read deadline: %v", err)
				}
				_, err := reader.Recv()
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("attempt %d: Recv error = %v, want %q", attempt, err, tc.want)
				}
			}
		})
	}
}
