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

// TestConnSendSeqAssignedUnderWriteLock is the targeted, fast reproduction. It
// exploits the fact that the pre-fix window is the HMAC computation plus the
// JSON marshal, which scales with payload size: a large message takes its
// sequence number and then spends milliseconds hashing and marshalling, while a
// small message that starts later takes the next number and reaches the socket
// first. The spin-wait on sendSeq starts the small send only once the large one
// has claimed a number, so this reproduces reliably rather than by luck.
//
// Its validity depends on sendSeq being published where it is claimed, which is
// an implementation detail. That holds for the bug as filed and for a verbatim
// re-introduction, but a variant that reserves the number outside the lock and
// publishes sendSeq only after the write would make this test pass while still
// being broken. TestConnSendConcurrentSendersAllAccepted below is the
// authoritative guard — it asserts only receiver-observable behaviour and
// catches that variant too. Demoting sendSeq to a plain uint64 fails loudly
// here (compile error), which is intentional.
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

	// 2 MiB: large enough that HMAC + marshal take milliseconds, two orders of
	// magnitude more than the small send's whole code path.
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

// TestConnSendConcurrentSendersAllAccepted is the authoritative guard: N
// goroutines sharing one Conn, every frame must be accepted by the receiver in
// strictly increasing sequence order. Note the assertion is the receiver's, not
// the race detector's — #3007 was an ordering bug in race-free code (sendSeq
// was already atomic), so this fails with or without -race. This models the
// production fan-out —
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

	// Report send failures FIRST. t.Fatalf runs runtime.Goexit, so draining
	// after the recvErr check would never execute — and if a sender is what
	// failed first (a stalled runner tripping the write deadline), the receiver
	// then starves and reports a misleading "the fix regressed" message with
	// the real cause discarded.
	for err := range sendErrs {
		t.Errorf("send failed: %v", err)
	}
	if err := <-recvErr; err != nil {
		t.Fatalf("receiver rejected a legitimate frame (issue #3007): %v", err)
	}
}

// BenchmarkConnSendConcurrent measures Send throughput with several goroutines
// sharing one Conn, at payload sizes spanning the range the agent actually
// uses. It exists to quantify the cost of moving the HMAC and the JSON marshal
// inside the write lock (issue #3007); the before/after figures that justified
// that choice are recorded in the PR for #3007, not here, since the "before"
// column describes a code state no longer in the tree.
//
// The summary that stays true: the change costs nothing on an uncontended Send,
// and shows up only when several goroutines push large payloads simultaneously,
// because the old code let them marshal on N cores while serializing just the
// write. That profile does not occur on this transport — its large messages are
// request/response, its high-rate messages are a few hundred bytes, and
// remote-desktop video (the one profile that would have made this expensive)
// does not use ipc.Conn at all: frames go over WebSocket/WebRTC and
// TypeDesktopFrame has no sender.
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

// createSocketPairTB returns a connected pair of loopback TCP conns. It is the
// single implementation behind createSocketPair, widened to testing.TB so
// benchmarks can use it too.
func createSocketPairTB(tb testing.TB) (net.Conn, net.Conn) {
	tb.Helper()

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		tb.Fatalf("listen: %v", err)
	}
	defer listener.Close()

	// Buffered and always sent to, including on the error path: a bare return
	// here would leave the receive below blocked until the whole test binary
	// times out instead of failing immediately.
	clientCh := make(chan net.Conn, 1)
	go func() {
		conn, err := net.Dial("tcp", listener.Addr().String())
		if err != nil {
			tb.Errorf("dial: %v", err)
		}
		clientCh <- conn
	}()

	serverConn, err := listener.Accept()
	if err != nil {
		tb.Fatalf("accept: %v", err)
	}

	clientConn := <-clientCh
	if clientConn == nil {
		tb.Fatal("dial failed; see error above")
	}
	return serverConn, clientConn
}
