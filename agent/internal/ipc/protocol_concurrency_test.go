package ipc

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// Regression tests for issue #3007: Conn.Send assigned the sequence number
// outside c.mu, so two concurrent senders could acquire sequence numbers in one
// order and reach the socket in the opposite order. The receiver enforces
// strict monotonicity (Recv rejects seq <= last as a replay), so the frame that
// lost the race was discarded — silently dropping a legitimate, correctly
// HMAC'd message and logging it as if it were tampering.

// mustJSONString builds a valid JSON string payload of roughly n bytes. The
// payload has to be real JSON because json.Marshal compacts (and therefore
// validates) a json.RawMessage.
func mustJSONString(t *testing.T, n int) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(strings.Repeat("a", n))
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return raw
}

// TestConnSendSeqAssignedUnderWriteLock is the targeted, near-deterministic
// reproduction. It exploits the fact that the pre-fix race window is the HMAC
// computation plus the JSON marshal, which scales with payload size: a large
// message takes its sequence number and then spends milliseconds hashing and
// marshalling, while a small message that starts later takes the next sequence
// number and reaches the socket first.
//
// The spin-wait on sendSeq is what makes this deterministic rather than a
// coin flip — it starts the small send only once the large one has definitely
// claimed a sequence number. Under the fix that claim happens with c.mu held,
// so the small send blocks on the mutex and the wire order matches the
// sequence order; before the fix it happens with no lock held, so the small
// send overtakes and the receiver rejects the large frame as a replay.
func TestConnSendSeqAssignedUnderWriteLock(t *testing.T) {
	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	type received struct {
		seq uint64
		err error
	}
	recvCh := make(chan received, 2)
	go func() {
		for i := 0; i < 2; i++ {
			env, err := server.Recv()
			if err != nil {
				recvCh <- received{err: err}
				return
			}
			recvCh <- received{seq: env.Seq}
		}
	}()

	if err := server.SetReadDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}

	// 2 MiB: large enough that HMAC + marshal take milliseconds, which is
	// ~1000x the small send's whole code path.
	bigEnv := &Envelope{ID: "big", Type: TypePing, Payload: mustJSONString(t, 2<<20)}
	smallEnv := &Envelope{ID: "small", Type: TypePing, Payload: json.RawMessage(`"x"`)}

	bigErr := make(chan error, 1)
	go func() { bigErr <- client.Send(bigEnv) }()

	// Wait until the large send has claimed its sequence number.
	deadline := time.Now().Add(10 * time.Second)
	for client.sendSeq.Load() == 0 {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting for the large send to claim a sequence number")
		}
		time.Sleep(50 * time.Microsecond)
	}

	if err := client.Send(smallEnv); err != nil {
		t.Fatalf("small send: %v", err)
	}
	if err := <-bigErr; err != nil {
		t.Fatalf("large send: %v", err)
	}

	for i := 0; i < 2; i++ {
		got := <-recvCh
		if got.err != nil {
			t.Fatalf("frame %d rejected by receiver: %v "+
				"(sequence numbers must be assigned in the same order frames reach the socket — issue #3007)",
				i+1, got.err)
		}
		if want := uint64(i + 1); got.seq != want {
			t.Fatalf("frame %d: got seq %d, want %d", i+1, got.seq, want)
		}
	}
}

// TestConnSendConcurrentSendersAllAccepted is the broad -race guard: N
// goroutines sharing one Conn, every frame must be accepted by the receiver in
// strictly increasing sequence order. This models the production fan-out —
// concurrent backup run reporting, emitVaultAutoSyncResult, and progress or
// keepalive pings overlapping a terminal result all write to the same Conn.
func TestConnSendConcurrentSendersAllAccepted(t *testing.T) {
	const (
		senders          = 8
		msgsPerSender    = 25
		payloadBytes     = 64 << 10
		totalMessages    = senders * msgsPerSender
		receiveDeadlineS = 60
	)

	serverConn, clientConn := createSocketPair(t)
	defer serverConn.Close()
	defer clientConn.Close()

	server := NewConn(serverConn)
	client := NewConn(clientConn)

	if err := server.SetReadDeadline(time.Now().Add(receiveDeadlineS * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}

	recvErr := make(chan error, 1)
	go func() {
		// A receiver that stops draining leaves the senders blocked on a full
		// socket buffer until the 30s write deadline, turning a fast failure
		// into a multi-minute one. Close the read end so they fail immediately.
		fail := func(err error) {
			serverConn.Close()
			recvErr <- err
		}
		var prev uint64
		for i := 0; i < totalMessages; i++ {
			env, err := server.Recv()
			if err != nil {
				fail(fmt.Errorf("frame %d/%d rejected: %w", i+1, totalMessages, err))
				return
			}
			if env.Seq <= prev {
				fail(fmt.Errorf("frame %d/%d: seq %d not greater than previous %d", i+1, totalMessages, env.Seq, prev))
				return
			}
			prev = env.Seq
		}
		recvErr <- nil
	}()

	payload := mustJSONString(t, payloadBytes)

	var wg sync.WaitGroup
	sendErrs := make(chan error, totalMessages)
	for s := 0; s < senders; s++ {
		wg.Add(1)
		go func(sender int) {
			defer wg.Done()
			for m := 0; m < msgsPerSender; m++ {
				env := &Envelope{
					ID:      fmt.Sprintf("s%d-m%d", sender, m),
					Type:    TypePing,
					Payload: payload,
				}
				if err := client.Send(env); err != nil {
					sendErrs <- fmt.Errorf("sender %d msg %d: %w", sender, m, err)
					return
				}
			}
		}(s)
	}
	wg.Wait()
	close(sendErrs)

	// The receiver is the primary assertion: when it rejects a frame it also
	// closes its end, so the send errors that follow are downstream noise.
	if err := <-recvErr; err != nil {
		t.Fatalf("receiver rejected a legitimate frame (issue #3007): %v", err)
	}
	for err := range sendErrs {
		t.Errorf("send failed: %v", err)
	}
}

// BenchmarkConnSendConcurrent measures Send throughput with several goroutines
// sharing one Conn, at payload sizes spanning the range the agent actually
// uses. It exists to quantify the cost of moving the HMAC and the JSON marshal
// inside the write lock (issue #3007).
//
// Measured on an M4 Pro (14 procs), before vs. after that change:
//
//	              -cpu=1 (uncontended)        -cpu=14 (saturated)
//	 256 B        33.3 -> 30.7 us  (none)     39.4 -> 43.9 us  (~+11%)
//	64 KiB         294 ->  265 us  (none)      98 ->  304 us  (~3x)
//	 1 MiB        4.62 -> 4.37 ms  (none)     0.53 ->  4.30 ms (~8x)
//
// Uncontended cost is nil — the fix adds no work to a Send. The saturated
// large-payload column is the whole cost: the old code let N goroutines
// marshal on N cores and serialized only the write, so it beat the serial
// ceiling. That advantage is unreachable in production, because the two
// properties never co-occur on this transport: the large messages (script
// command_result, screenshots) are request/response seconds-to-minutes apart,
// while the high-rate messages (backup_restore per-file progress, keepalives)
// are 200-500 byte structs whose marshal is nanoseconds. Remote-desktop video,
// the one profile that would have made this expensive, does not use ipc.Conn
// at all — frames go over WebSocket/WebRTC and TypeDesktopFrame is unused.
func BenchmarkConnSendConcurrent(b *testing.B) {
	for _, size := range []int{256, 64 << 10, 1 << 20} {
		b.Run(fmt.Sprintf("payload-%d", size), func(b *testing.B) {
			serverConn, clientConn := createSocketPairTB(b)
			defer serverConn.Close()
			defer clientConn.Close()

			client := NewConn(clientConn)

			// Drain the raw socket rather than calling server.Recv(): this
			// benchmark measures send-side cost, and a validating receiver
			// would stop draining the moment it saw an out-of-order frame,
			// which is exactly what the pre-fix code produces — the senders
			// would then block on a full buffer until the write deadline
			// instead of being measured.
			done := make(chan struct{})
			go func() {
				defer close(done)
				_, _ = io.Copy(io.Discard, serverConn)
			}()

			raw, err := json.Marshal(strings.Repeat("a", size))
			if err != nil {
				b.Fatalf("marshal payload: %v", err)
			}

			b.SetBytes(int64(size))
			b.ResetTimer()
			b.RunParallel(func(pb *testing.PB) {
				for pb.Next() {
					if err := client.Send(&Envelope{ID: "bench", Type: TypePing, Payload: raw}); err != nil {
						b.Errorf("send: %v", err)
						return
					}
				}
			})
			b.StopTimer()
			clientConn.Close()
			<-done
		})
	}
}

// createSocketPairTB is createSocketPair widened to testing.TB so benchmarks
// can use it too.
func createSocketPairTB(tb testing.TB) (net.Conn, net.Conn) {
	tb.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	clientCh := make(chan net.Conn, 1)
	go func() {
		conn, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			tb.Errorf("dial: %v", err)
			return
		}
		clientCh <- conn
	}()

	serverConn, err := listener.Accept()
	if err != nil {
		tb.Fatalf("accept: %v", err)
	}

	return serverConn, <-clientCh
}
