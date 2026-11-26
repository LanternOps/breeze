package websocket

import (
	"bytes"
	"strings"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
)

// lockedBuffer lets the logger (any goroutine) and the test share one buffer.
type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func capturePlaintextWarnings(t *testing.T) *lockedBuffer {
	t.Helper()
	buf := &lockedBuffer{}
	logging.Init("text", "debug", buf)
	t.Cleanup(func() { logging.Init("text", "info", nil) })
	resetPlaintextWarningForTest(t)
	return buf
}

func countPlaintextWarnings(buf *lockedBuffer) int {
	return strings.Count(buf.String(), plaintextWarningMessage)
}

func TestPlaintextWarningOncePerProcess(t *testing.T) {
	buf := capturePlaintextWarnings(t)

	if warnPlaintextDial("wss://rmm.example.com/api/v1/agent-ws/a/ws") {
		t.Fatal("wss:// must not warn")
	}
	if warnPlaintextDial("ws://127.0.0.1:3001/api/v1/agent-ws/a/ws") {
		t.Fatal("ws:// to IPv4 loopback must not warn")
	}
	if warnPlaintextDial("ws://[::1]:3001/api/v1/agent-ws/a/ws") {
		t.Fatal("ws:// to IPv6 loopback must not warn")
	}
	if warnPlaintextDial("ws://localhost:3001/api/v1/agent-ws/a/ws") {
		t.Fatal("ws:// to localhost must not warn")
	}
	if n := countPlaintextWarnings(buf); n != 0 {
		t.Fatalf("got %d warnings before any plaintext remote dial, want 0", n)
	}

	// The first plaintext remote dial warns, and an encrypted or loopback dial
	// before it did not use up the once.
	if !warnPlaintextDial("ws://192.168.1.20:3001/api/v1/agent-ws/a/ws") {
		t.Fatal("first ws:// dial to a private LAN host must warn")
	}
	// Every later dial (a reconnect, or a different plaintext host) is silent.
	if warnPlaintextDial("ws://192.168.1.20:3001/api/v1/agent-ws/a/ws") {
		t.Fatal("reconnect must not warn again")
	}
	if warnPlaintextDial("ws://rmm.example.com/api/v1/agent-ws/a/ws") {
		t.Fatal("a second plaintext host in the same process must not warn again")
	}

	out := buf.String()
	if n := countPlaintextWarnings(buf); n != 1 {
		t.Fatalf("got %d warnings, want exactly 1; log:\n%s", n, out)
	}
	for _, want := range []string{"level=WARN", "host=192.168.1.20", "https://"} {
		if !strings.Contains(out, want) {
			t.Errorf("warning line missing %q; log:\n%s", want, out)
		}
	}
}

// connect is the only dial path (first connect and every reconnect), so the
// warning is wired there: the first connect warns, the next one does not.
// connect holds the agent's token when it warns, so this is also where the
// log is checked for it. Host names use the reserved .invalid TLD so a dial
// that does start never reaches a real resolver answer.
func TestConnectWarnsOnceForPlaintextServer(t *testing.T) {
	buf := capturePlaintextWarnings(t)

	c := newTestClient("http://rmm.example.invalid", noopHandler)
	token := c.config.AuthToken.Reveal()
	if !strings.HasPrefix(token, "brz_") {
		t.Fatalf("test client token %q does not look like an agent token; the leak check below would prove nothing", token)
	}
	// Stopped first so the dial is cancelled at once: this test is about the
	// warning, which is logged before the dial, not about the connection.
	c.Stop()

	for range 3 {
		if err := c.connect(); err == nil {
			t.Fatal("connect on a stopped client must fail")
		}
	}
	out := buf.String()
	if n := countPlaintextWarnings(buf); n != 1 {
		t.Fatalf("got %d warnings across 3 connects, want 1; log:\n%s", n, out)
	}
	if strings.Contains(out, token) || strings.Contains(out, "brz_") {
		t.Errorf("log must not carry the agent token; log:\n%s", out)
	}
}

func TestConnectDoesNotWarnForEncryptedServer(t *testing.T) {
	buf := capturePlaintextWarnings(t)

	c := newTestClient("https://rmm.example.invalid", noopHandler)
	c.Stop()
	_ = c.connect()

	if n := countPlaintextWarnings(buf); n != 0 {
		t.Fatalf("https server URL logged %d plaintext warnings, want 0", n)
	}
}

func resetPlaintextWarningForTest(t *testing.T) {
	t.Helper()
	plaintextWarned.Store(false)
	t.Cleanup(func() { plaintextWarned.Store(false) })
}
