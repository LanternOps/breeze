package ipc

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// writeObserverConn wraps a net.Conn so a test can observe two things about
// Send() without measuring wall-clock time (issue #4322):
//
//   - firstWrite closes the instant a Send enters its socket write. Send calls
//     conn.Write under c.mu with the deadline already armed, so a receive on
//     that channel is proof the writer holds the mutex and is stalled on the
//     peer — replacing a slept guess at how long that takes.
//   - writes counts every write that actually reached the socket, which is the
//     exact property the old `elapsed < writeTimeout` assertions were using
//     duration as a proxy for ("this Send did not stall on the socket again").
//     A count has no margin to tune, so it cannot flake under -race on a loaded
//     runner the way a 20ms-of-100ms budget did.
type writeObserverConn struct {
	net.Conn
	writes     atomic.Int64
	firstWrite chan struct{}
	once       sync.Once
}

func newWriteObserverConn(c net.Conn) *writeObserverConn {
	return &writeObserverConn{Conn: c, firstWrite: make(chan struct{})}
}

func (c *writeObserverConn) Write(b []byte) (int, error) {
	c.writes.Add(1)
	c.once.Do(func() { close(c.firstWrite) })
	return c.Conn.Write(b)
}

func TestConnSendRecv(t *testing.T) {
	// Create a pair of connected Unix sockets (or TCP for portability)
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	// Send from client to server
	payload, _ := json.Marshal(map[string]string{"hello": "world"})
	env := &Envelope{
		ID:      "test-1",
		Type:    TypePing,
		Payload: payload,
	}

	done := make(chan error, 1)
	go func() {
		done <- client.Send(env)
	}()

	// Receive on server
	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	recv, err := server.Recv()
	if err != nil {
		t.Fatalf("recv: %v", err)
	}

	if err := <-done; err != nil {
		t.Fatalf("send: %v", err)
	}

	if recv.ID != "test-1" {
		t.Errorf("expected ID test-1, got %s", recv.ID)
	}
	if recv.Type != TypePing {
		t.Errorf("expected type %s, got %s", TypePing, recv.Type)
	}
	if recv.Seq != 1 {
		t.Errorf("expected seq 1, got %d", recv.Seq)
	}
}

func TestConnHMAC(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	key, err := GenerateSessionKey()
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	server := NewConn(serverConn)
	server.SetSessionKey(key)

	client := NewConn(clientConn)
	client.SetSessionKey(key)

	payload, _ := json.Marshal("test")
	env := &Envelope{
		ID:      "hmac-test",
		Type:    TypePong,
		Payload: payload,
	}

	done := make(chan error, 1)
	go func() {
		done <- client.Send(env)
	}()

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	recv, err := server.Recv()
	if err != nil {
		t.Fatalf("recv with HMAC: %v", err)
	}

	if err := <-done; err != nil {
		t.Fatalf("send: %v", err)
	}

	if recv.HMAC == "" {
		t.Error("expected non-empty HMAC")
	}
}

func TestConnHMACMismatch(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	key1, _ := GenerateSessionKey()
	key2, _ := GenerateSessionKey()

	server := NewConn(serverConn)
	server.SetSessionKey(key1)

	client := NewConn(clientConn)
	client.SetSessionKey(key2) // Different key

	payload, _ := json.Marshal("test")
	env := &Envelope{
		ID:      "hmac-mismatch",
		Type:    TypePong,
		Payload: payload,
	}

	go client.Send(env)

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := server.Recv()
	if err == nil {
		t.Fatal("expected HMAC mismatch error, got nil")
	}
}

func TestConnSequenceReplay(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	// Send first message
	payload, _ := json.Marshal("first")
	go client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload})

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := server.Recv()
	if err != nil {
		t.Fatalf("first recv: %v", err)
	}

	// Send second message (should have seq=2)
	payload2, _ := json.Marshal("second")
	go client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload2})

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	recv2, err := server.Recv()
	if err != nil {
		t.Fatalf("second recv: %v", err)
	}
	if recv2.Seq != 2 {
		t.Errorf("expected seq 2, got %d", recv2.Seq)
	}
}

func TestConnSequenceReplayRejection(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	// Send first legitimate message (seq=1)
	payload, _ := json.Marshal("first")
	go client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload})

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := server.Recv()
	if err != nil {
		t.Fatalf("first recv: %v", err)
	}

	// Send second legitimate message (seq=2)
	payload2, _ := json.Marshal("second")
	go client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload2})

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err = server.Recv()
	if err != nil {
		t.Fatalf("second recv: %v", err)
	}

	// Now craft a raw message with seq=1 (replay) and write it directly
	replayEnv := Envelope{ID: "replay", Seq: 1, Type: TypePing, Payload: payload}
	// Compute HMAC with zero key (no session key set)
	replayEnv.HMAC = server.computeHMAC(&replayEnv)
	rawBytes, _ := json.Marshal(replayEnv)

	// Write directly to the raw connection (bypass Conn.Send which auto-increments seq)
	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(rawBytes)))
	go func() {
		clientConn.Write(header)
		clientConn.Write(rawBytes)
	}()

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err = server.Recv()
	if err == nil {
		t.Fatal("expected replay rejection error, got nil")
	}
}

func TestConnSequenceZeroRejection(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)

	// Craft a message with seq=0 and write directly
	payload, _ := json.Marshal("zero")
	env := Envelope{ID: "zero", Seq: 0, Type: TypePing, Payload: payload}
	env.HMAC = server.computeHMAC(&env)
	rawBytes, _ := json.Marshal(env)

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(rawBytes)))
	go func() {
		clientConn.Write(header)
		clientConn.Write(rawBytes)
	}()

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, err := server.Recv()
	if err == nil {
		t.Fatal("expected seq=0 rejection, got nil")
	}
}

func TestConnMaxMessageSize(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	client := NewConn(clientConn)

	// Create an oversized payload
	bigPayload := make(json.RawMessage, MaxMessageSize+1)
	for i := range bigPayload {
		bigPayload[i] = 'A'
	}

	env := &Envelope{
		ID:      "big",
		Type:    TypePing,
		Payload: bigPayload,
	}

	err := client.Send(env)
	if err == nil {
		t.Fatal("expected error for oversized message")
	}
}

func TestSendTyped(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	done := make(chan error, 1)
	go func() {
		done <- client.SendTyped("typed-1", TypeCapabilities, Capabilities{
			CanNotify:     true,
			CanCapture:    false,
			DisplayServer: "x11",
		})
	}()

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	recv, err := server.Recv()
	if err != nil {
		t.Fatalf("recv: %v", err)
	}

	if recv.Type != TypeCapabilities {
		t.Errorf("expected type %s, got %s", TypeCapabilities, recv.Type)
	}

	var caps Capabilities
	if err := json.Unmarshal(recv.Payload, &caps); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !caps.CanNotify {
		t.Error("expected CanNotify=true")
	}
	if caps.DisplayServer != "x11" {
		t.Errorf("expected displayServer=x11, got %s", caps.DisplayServer)
	}
}

func TestGenerateSessionKey(t *testing.T) {
	key1, err := GenerateSessionKey()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}
	if len(key1) != 32 {
		t.Errorf("expected 32 bytes, got %d", len(key1))
	}

	key2, err := GenerateSessionKey()
	if err != nil {
		t.Fatalf("generate: %v", err)
	}

	// Keys should be different
	same := true
	for i := range key1 {
		if key1[i] != key2[i] {
			same = false
			break
		}
	}
	if same {
		t.Error("two generated keys should not be identical")
	}
}

// TestConnSendWriteDeadline proves that a Send() whose underlying socket write
// stalls returns a *timeout* error within the write deadline instead of
// blocking forever holding the write mutex (issue #2273). net.Pipe is fully
// synchronous and has no internal buffer, so a Write blocks until the peer
// Reads — here the peer never reads, so without the deadline Send would block
// indefinitely.
func TestConnSendWriteDeadline(t *testing.T) {
	// Shorten the deadline so the test is fast; restore afterwards.
	orig := writeTimeout
	writeTimeout = 100 * time.Millisecond
	defer func() { writeTimeout = orig }()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()
	// Deliberately never read from serverConn so the write stalls.

	client := NewConn(clientConn)

	payload, _ := json.Marshal(map[string]string{"hello": "world"})
	env := &Envelope{ID: "stalled", Type: TypePing, Payload: payload}

	done := make(chan error, 1)
	go func() { done <- client.Send(env) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected write-deadline error from stalled Send, got nil")
		}
		// Pin the failure to the deadline path, not some unrelated error.
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("expected a deadline-exceeded error, got: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send blocked past the write deadline — mutex wedge not prevented")
	}
}

// TestConnSendPoisonedAfterWriteError proves that once a Send() write fails
// (here via the deadline), the Conn is poisoned so the *next* Send returns
// immediately rather than piling another frame onto a stream whose framing may
// already be desynced by a partial write (issue #2273).
func TestConnSendPoisonedAfterWriteError(t *testing.T) {
	orig := writeTimeout
	writeTimeout = 100 * time.Millisecond
	defer func() { writeTimeout = orig }()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()
	// Never read from serverConn so the first write stalls out.

	observed := newWriteObserverConn(clientConn)
	client := NewConn(observed)
	payload, _ := json.Marshal("x")

	// First send stalls and errors at the deadline, poisoning the Conn.
	if err := client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}); err == nil {
		t.Fatal("expected first send to fail at the write deadline")
	}
	writesAfterFirstSend := observed.writes.Load()

	// Second send must fail fast (poison fast-path) — i.e. it does not stall on
	// the socket again. Stated as "reached the socket zero more times" rather
	// than "returned in under a writeTimeout": the count is what the duration
	// was standing in for, and it carries no margin to flake on (issue #4322).
	err := client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload})
	if err == nil {
		t.Fatal("expected second send to fail fast on a poisoned Conn, got nil")
	}
	if extra := observed.writes.Load() - writesAfterFirstSend; extra != 0 {
		t.Fatalf("second send performed %d additional socket write(s) — did not use the poison fast-path", extra)
	}
	// Pin the reason to the poison fast-path (not some other incidental error)
	// and confirm the original write cause is surfaced through it.
	if !strings.Contains(err.Error(), "poisoned") {
		t.Fatalf("expected a poison error, got: %v", err)
	}
	if !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("expected poison error to wrap the original deadline cause, got: %v", err)
	}
}

// TestConnSendOversizedDoesNotPoison proves that a Send rejected *before* any
// bytes reach the wire (oversized payload — and by the same early-return path, a
// marshal failure) does NOT poison the Conn: a transient bad message must not
// permanently kill an otherwise healthy connection (issue #2273 review).
func TestConnSendOversizedDoesNotPoison(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	// Rejected before any Write. Note this payload is not valid JSON, so it is
	// json.Marshal that rejects it, not a size check — see
	// TestConnSendOversizedPayloadRejectedBeforeLock for the size paths.
	big := make(json.RawMessage, MaxMessageSize+1)
	for i := range big {
		big[i] = 'A'
	}
	if err := client.Send(&Envelope{ID: "big", Type: TypePing, Payload: big}); err == nil {
		t.Fatal("expected oversized send to error")
	}

	// The Conn must still be usable end-to-end: a normal send now succeeds.
	done := make(chan error, 1)
	go func() { done <- client.SendTyped("ok", TypePing, map[string]string{"a": "b"}) }()

	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := server.Recv(); err != nil {
		t.Fatalf("healthy send after oversized reject failed — Conn was wrongly poisoned: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("send after oversized reject: %v", err)
	}
}

// TestConnSendPoisonsOnPayloadWriteError exercises the payload-write branch
// specifically: the reader consumes the 4-byte length header (so that Write
// succeeds and the frame is already partly on the wire) then stops, stalling the
// payload Write to its deadline. That is exactly the desync scenario the poison
// latch exists for, and the branch it protects (issue #2273).
func TestConnSendPoisonsOnPayloadWriteError(t *testing.T) {
	orig := writeTimeout
	writeTimeout = 150 * time.Millisecond
	defer func() { writeTimeout = orig }()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()

	// Reader drains exactly the length header, then reads no further — so the
	// header Write completes but the payload Write stalls out at the deadline.
	go func() {
		hdr := make([]byte, 4)
		_, _ = io.ReadFull(serverConn, hdr)
	}()

	observed := newWriteObserverConn(clientConn)
	client := NewConn(observed)
	payload, _ := json.Marshal("x")
	if err := client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}); err == nil {
		t.Fatal("expected payload write to fail at the deadline")
	}
	// Two writes so far: the header (drained by the reader above) and the
	// payload (stalled to its deadline).
	writesAfterFirstSend := observed.writes.Load()

	// The payload branch must have latched poison: the next send fails fast,
	// i.e. it adds no further writes to the desynced stream. Counted rather
	// than timed so there is no margin to flake on (issue #4322).
	err := client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload})
	if err == nil {
		t.Fatal("expected poisoned Conn to reject the next send")
	}
	if extra := observed.writes.Load() - writesAfterFirstSend; extra != 0 {
		t.Fatalf("second send performed %d additional socket write(s) — payload branch did not poison", extra)
	}
	if !strings.Contains(err.Error(), "poisoned") {
		t.Fatalf("expected a poison error, got: %v", err)
	}
}

// TestConnSetWriteTimeout proves the per-Conn override tightens Send's write
// bound below the package default — the mechanism the broker's pre-auth reject
// path relies on to keep its ~2s hostile-peer cap after ipc.Conn.Send took
// ownership of the underlying write deadline (issue #2273 review).
func TestConnSetWriteTimeout(t *testing.T) {
	orig := writeTimeout
	writeTimeout = 10 * time.Second // default long enough that it can't be why we return fast
	defer func() { writeTimeout = orig }()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()
	// No reader: the write stalls until the (short) per-Conn deadline fires.

	client := NewConn(clientConn)
	client.SetWriteTimeout(100 * time.Millisecond)

	payload, _ := json.Marshal("x")
	done := make(chan error, 1)
	go func() { done <- client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected the per-Conn write timeout to error the stalled send")
		}
		if !errors.Is(err, os.ErrDeadlineExceeded) {
			t.Fatalf("expected a deadline-exceeded error, got: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Send ignored the per-Conn write timeout and used the long default")
	}
}

// TestConnSendStalledDoesNotStarveOtherWriter models the exact #2273 failure:
// a stalled writer must not hold the write mutex forever and starve a second
// writer on the same Conn (the keepalive TypePong path). Run under -race, it
// also validates that the deadline set/clear stays inside c.mu.
func TestConnSendStalledDoesNotStarveOtherWriter(t *testing.T) {
	orig := writeTimeout
	writeTimeout = 100 * time.Millisecond
	defer func() { writeTimeout = orig }()

	clientConn, serverConn := net.Pipe()
	defer clientConn.Close()
	defer serverConn.Close()
	// No reader on serverConn: every write stalls until its deadline.

	observed := newWriteObserverConn(clientConn)
	client := NewConn(observed)
	payload, _ := json.Marshal("x")

	// Writer 1 grabs the mutex and stalls.
	w1 := make(chan error, 1)
	go func() { w1 <- client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}) }()

	// Wait for writer 1 to actually be inside its socket write instead of
	// sleeping a guess at how long that takes. Send calls conn.Write under c.mu
	// with the deadline already armed, so this receive proves writer 1 holds the
	// mutex and is stalled on the dead peer. The old 20ms sleep was not just a
	// guess — it doubled as the entire margin of a `time.Since(start)` assertion
	// against a 100ms writeTimeout, which is why this test flaked under -race on
	// a loaded runner (issue #4322).
	select {
	case <-observed.firstWrite:
	case <-time.After(5 * time.Second):
		t.Fatal("writer 1 never reached its socket write")
	}

	// Writer 2 (the "keepalive pong") must not block forever: once writer 1's
	// deadline fires and releases c.mu, writer 2 proceeds. Before the #2273 fix
	// it would block on Lock() indefinitely.
	//
	// Writer 2 also pins the under-lock poison re-check (issue #3007). It
	// cleared the pre-lock fast path while the Conn was still healthy, so only
	// the re-check inside the critical section can stop it: writer 1 calls
	// poison() while still holding c.mu, so writer 2 is guaranteed to observe
	// writePoisoned the instant it acquires the lock. Without the re-check it
	// would instead append a frame to a stream writer 1's partial write already
	// desynced — which is what the socket-write count below detects.
	w2 := make(chan error, 1)
	go func() { w2 <- client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload}) }()

	for i, ch := range []chan error{w1, w2} {
		select {
		case err := <-ch:
			if err == nil {
				t.Fatalf("writer %d unexpectedly succeeded against a dead peer", i+1)
			}
			if i == 1 && !strings.Contains(err.Error(), "poisoned") {
				t.Fatalf("writer 2 wrote into a poisoned stream instead of failing on the "+
					"under-lock re-check (issue #3007): %v", err)
			}
		// A liveness bound, not a margin: a correct run settles in one
		// writeTimeout (100ms) while a starved writer never returns at all.
		case <-time.After(2 * time.Second):
			t.Fatalf("writer %d blocked — stalled writer starved the mutex", i+1)
		}
	}

	// The decisive, timing-free replacement for the old elapsed-time check
	// (issue #4322). Exactly one write may ever reach the socket: writer 1's
	// header, which stalls until its deadline. Writer 2 failing on the
	// under-lock poison re-check happens strictly before any write of its own,
	// so a count of 2 means the #3007 regression is back. Unlike a duration
	// threshold this separates the regression from a merely slow run — the old
	// assertion could not, since a correct run measured ~80ms and a regressed
	// one ~180ms against a 100ms line.
	if got := observed.writes.Load(); got != 1 {
		t.Fatalf("expected exactly 1 socket write (writer 1's stalled header), got %d — "+
			"writer 2 attempted its own write rather than failing fast on the poison re-check", got)
	}
}

// TestConnSendOversizedPayloadRejectedBeforeLock covers the pre-lock payload
// guard (issue #3007): an oversized payload must be rejected without holding
// c.mu across its marshal, and must not consume a sequence number or poison the
// Conn. It uses a VALID oversized JSON payload deliberately — the older
// oversize test fills the payload with 'A', which is not JSON, so it errors in
// json.Marshal and never exercises a size check at all.
func TestConnSendOversizedPayloadRejectedBeforeLock(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer func() { _ = serverConn.Close() }()
	defer func() { _ = clientConn.Close() }()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	big, err := json.Marshal(strings.Repeat("a", MaxMessageSize+1))
	if err != nil {
		t.Fatalf("build oversized payload: %v", err)
	}
	if err := client.Send(&Envelope{ID: "big", Type: TypePing, Payload: big}); err == nil {
		t.Fatal("expected oversized payload to be rejected")
	} else if !strings.Contains(err.Error(), "payload too large") {
		t.Fatalf("expected the pre-lock payload guard to reject it, got: %v", err)
	}

	// No sequence number was consumed, so the next frame is still seq 1.
	if got := client.sendSeq.Load(); got != 0 {
		t.Errorf("rejected payload consumed a sequence number: sendSeq=%d, want 0", got)
	}

	// The Conn is not poisoned and remains usable end-to-end.
	done := make(chan error, 1)
	go func() { done <- client.SendTyped("ok", TypePing, map[string]string{"a": "b"}) }()

	if err := server.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	env, err := server.Recv()
	if err != nil {
		t.Fatalf("recv after rejected oversized payload: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("send after rejected oversized payload: %v", err)
	}
	if env.Seq != 1 {
		t.Errorf("expected the next frame to carry seq 1, got %d", env.Seq)
	}
}

func createSocketPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()
	return createSocketPairTB(t)
}
