package ipc

import (
	"encoding/binary"
	"encoding/json"
	"net"
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
// stalls returns an error within the write deadline instead of blocking
// forever holding the write mutex (issue #2273). net.Pipe is fully synchronous
// and has no internal buffer, so a Write blocks until the peer Reads — here the
// peer never reads, so without the deadline Send would block indefinitely.
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
	case <-time.After(2 * time.Second):
		t.Fatal("Send blocked past the write deadline — mutex wedge not prevented")
	}
}

// TestConnSendClearsWriteDeadline verifies that after one Send the write
// deadline is cleared, so a subsequent Send on the same Conn isn't killed by
// the previous call's (now-elapsed) deadline.
func TestConnSendClearsWriteDeadline(t *testing.T) {
	orig := writeTimeout
	writeTimeout = 50 * time.Millisecond
	defer func() { writeTimeout = orig }()

	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	// First send succeeds.
	payload, _ := json.Marshal("first")
	if err := client.Send(&Envelope{ID: "1", Type: TypePing, Payload: payload}); err != nil {
		t.Fatalf("first send: %v", err)
	}
	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := server.Recv(); err != nil {
		t.Fatalf("first recv: %v", err)
	}

	// Wait past the (short) write timeout, then send again. If the deadline
	// leaked, this write would fail with a stale-deadline timeout.
	time.Sleep(2 * writeTimeout)

	done := make(chan error, 1)
	go func() { done <- client.Send(&Envelope{ID: "2", Type: TypePing, Payload: payload}) }()
	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, err := server.Recv(); err != nil {
		t.Fatalf("second recv: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("second send failed — write deadline leaked across sends: %v", err)
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
