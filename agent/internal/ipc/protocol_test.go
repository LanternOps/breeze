package ipc

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

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

	client := NewConn(clientConn)
	payload, _ := json.Marshal("x")

	// First send stalls and errors at the deadline, poisoning the Conn.
	if err := client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}); err == nil {
		t.Fatal("expected first send to fail at the write deadline")
	}

	// Second send must fail fast (poison fast-path), well under a fresh
	// writeTimeout — i.e. it does not stall on the socket again.
	start := time.Now()
	err := client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload})
	if err == nil {
		t.Fatal("expected second send to fail fast on a poisoned Conn, got nil")
	}
	if elapsed := time.Since(start); elapsed >= writeTimeout {
		t.Fatalf("second send took %v — did not use the poison fast-path", elapsed)
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

	// Oversized payload is rejected by the size check, before c.mu / any Write.
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

	client := NewConn(clientConn)
	payload, _ := json.Marshal("x")
	if err := client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}); err == nil {
		t.Fatal("expected payload write to fail at the deadline")
	}

	// The payload branch must have latched poison: the next send fails fast.
	start := time.Now()
	err := client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload})
	if err == nil {
		t.Fatal("expected poisoned Conn to reject the next send")
	}
	if elapsed := time.Since(start); elapsed >= writeTimeout {
		t.Fatalf("second send took %v — payload branch did not poison", elapsed)
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

	client := NewConn(clientConn)
	payload, _ := json.Marshal("x")

	// Writer 1 grabs the mutex and stalls.
	w1 := make(chan error, 1)
	go func() { w1 <- client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}) }()

	// Give writer 1 time to acquire c.mu and begin its stalled write.
	time.Sleep(20 * time.Millisecond)

	// Writer 2 (the "keepalive pong") must not block forever: once writer 1's
	// deadline fires and releases c.mu, writer 2 proceeds and returns an error
	// (either its own deadline or the poison fast-path). Before the fix it
	// would block on Lock() indefinitely.
	w2 := make(chan error, 1)
	go func() { w2 <- client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload}) }()

	for i, ch := range []chan error{w1, w2} {
		select {
		case err := <-ch:
			if err == nil {
				t.Fatalf("writer %d unexpectedly succeeded against a dead peer", i+1)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("writer %d blocked — stalled writer starved the mutex", i+1)
		}
	}
}

func createSocketPair(t *testing.T) (net.Conn, net.Conn) {
	t.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	clientCh := make(chan net.Conn, 1)
	go func() {
		conn, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			t.Errorf("dial: %v", err)
			return
		}
		clientCh <- conn
	}()

	serverConn, err := listener.Accept()
	if err != nil {
		t.Fatalf("accept: %v", err)
	}

	clientConn := <-clientCh
	return serverConn, clientConn
}
