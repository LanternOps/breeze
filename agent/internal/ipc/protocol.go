package ipc

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("ipc")

// zeroKey is used for pre-auth messages (auth_request).
var zeroKey = make([]byte, 32)

// writeTimeout bounds how long a single Send() may block on the underlying
// socket writes. Without a deadline, a stalled peer (kernel send buffer full
// because the reader isn't draining, or a wedged socket) blocks the write
// mutex forever, starving every other writer on the same Conn — notably the
// keepalive TypePong reply, whose absence gets the macOS user helper evicted
// by the session broker (issue #2273). It is deliberately generous — a
// legitimate MaxMessageSize (16 MiB) payload over a local socket is expected to
// complete in well under a second, so 30s never trips a healthy transfer — yet
// bounded so a genuinely wedged socket surfaces as an error instead of an
// indefinite mutex wedge. On such an error the Conn is poisoned (see
// writePoisoned) so the next Send fails fast and the caller reconnects.
//
// This is package-level so tests can shorten it; production never mutates it.
// A caller that needs a tighter bound on one connection (e.g. the broker's
// pre-auth reject path, which must fast-fail a stuck unauthenticated client)
// uses Conn.SetWriteTimeout rather than mutating this shared default.
var writeTimeout = 30 * time.Second

// Conn wraps a net.Conn with length-prefixed JSON framing, HMAC signing,
// and sequence number validation.
type Conn struct {
	conn       net.Conn
	sessionKey []byte
	keyMu      sync.RWMutex // protects sessionKey
	sendSeq    atomic.Uint64
	recvSeq    atomic.Uint64
	mu         sync.Mutex // serializes writes
	// writeTimeoutNanos, when > 0, overrides the package-level writeTimeout for
	// this Conn's Send() calls (see SetWriteTimeout). 0 means "use the default".
	writeTimeoutNanos atomic.Int64
	// writePoisoned is set once a Send() write fails partway. Framing is
	// length-prefixed, so a Write that reports an error (timeout or reset)
	// may have already put a partial [len][JSON] frame on the wire, leaving
	// the peer's stream desynced. Rather than let subsequent Sends write more
	// frames into a corrupted stream, we poison the Conn so every later Send
	// fails fast — forcing the caller onto its reconnect path deterministically
	// instead of relying on the read side to eventually notice (issue #2273).
	writePoisoned atomic.Bool
	// firstWriteErr records the concrete error from the write that first
	// poisoned this Conn (timeout vs. reset vs. broken pipe), so the generic
	// poison fast-path can surface the real root cause on the reconnect path
	// instead of an opaque "connection poisoned" message.
	firstWriteErr atomic.Pointer[error]
}

// NewConn wraps a raw connection. sessionKey should be nil for pre-auth;
// call SetSessionKey after auth completes.
func NewConn(conn net.Conn) *Conn {
	return &Conn{
		conn:       conn,
		sessionKey: nil,
	}
}

// SetSessionKey sets the HMAC key after auth handshake.
func (c *Conn) SetSessionKey(key []byte) {
	c.keyMu.Lock()
	c.sessionKey = key
	c.keyMu.Unlock()
}

// SessionKey returns the current session key.
func (c *Conn) SessionKey() []byte {
	c.keyMu.RLock()
	defer c.keyMu.RUnlock()
	return c.sessionKey
}

// Close closes the underlying connection.
func (c *Conn) Close() error {
	return c.conn.Close()
}

// RemoteAddr returns the remote address of the underlying connection.
func (c *Conn) RemoteAddr() net.Addr {
	return c.conn.RemoteAddr()
}

// LocalAddr returns the local address of the underlying connection.
func (c *Conn) LocalAddr() net.Addr {
	return c.conn.LocalAddr()
}

// SetDeadline sets the deadline on the underlying connection.
func (c *Conn) SetDeadline(t time.Time) error {
	return c.conn.SetDeadline(t)
}

// SetReadDeadline sets the read deadline on the underlying connection.
func (c *Conn) SetReadDeadline(t time.Time) error {
	return c.conn.SetReadDeadline(t)
}

// SetWriteDeadline sets the write deadline on the underlying connection.
func (c *Conn) SetWriteDeadline(t time.Time) error {
	return c.conn.SetWriteDeadline(t)
}

// Send marshals an Envelope and writes it as [4-byte BE length][JSON].
// It computes the HMAC and sets the sequence number automatically.
func (c *Conn) Send(env *Envelope) error {
	if c.writePoisoned.Load() {
		if cause := c.firstWriteErr.Load(); cause != nil {
			return fmt.Errorf("ipc: connection poisoned by prior write error: %w", *cause)
		}
		return fmt.Errorf("ipc: connection poisoned by prior write error")
	}

	env.Seq = c.sendSeq.Add(1)
	env.HMAC = c.computeHMAC(env)

	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("ipc: marshal envelope: %w", err)
	}

	if len(data) > MaxMessageSize {
		return fmt.Errorf("ipc: message too large: %d > %d", len(data), MaxMessageSize)
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// Bound the blocking writes so a stalled socket can never wedge c.mu
	// forever (issue #2273). Writes are serialized by c.mu, so clearing the
	// deadline afterwards can't race another writer; clearing prevents this
	// call's deadline from leaking onto the next Send on the same Conn.
	if err := c.conn.SetWriteDeadline(time.Now().Add(c.effectiveWriteTimeout())); err != nil {
		return fmt.Errorf("ipc: set write deadline: %w", err)
	}
	// The clear error is intentionally ignored: the next Send re-arms an
	// absolute deadline before it writes, so a failed clear here cannot leak a
	// stale deadline onto any later write.
	defer func() { _ = c.conn.SetWriteDeadline(time.Time{}) }()

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(data)))

	// A Write that errors (deadline exceeded, reset) may have already put a
	// partial frame on the wire, so poison the Conn — subsequent Sends fail
	// fast rather than piling more frames onto a desynced stream.
	if _, err := c.conn.Write(header); err != nil {
		return c.poison(fmt.Errorf("ipc: write header: %w", err))
	}
	if _, err := c.conn.Write(data); err != nil {
		return c.poison(fmt.Errorf("ipc: write payload: %w", err))
	}
	return nil
}

// poison latches this Conn as unusable after a write error and records the
// first such error as the root cause. Callers return its result directly. The
// cause is stored before the poisoned flag is set so a concurrent Send that
// observes writePoisoned==true is guaranteed to also observe the cause.
func (c *Conn) poison(cause error) error {
	c.firstWriteErr.CompareAndSwap(nil, &cause)
	c.writePoisoned.Store(true)
	return cause
}

// SetWriteTimeout overrides the package-level writeTimeout for this Conn's
// Send() calls. Used by callers that must fast-fail a stuck peer faster than the
// generous default — notably the broker's pre-auth reject path, which caps a
// stuck unauthenticated client at ~2s so it can't tie up a handler goroutine for
// the full default (issue #2273). A value <= 0 restores the default. Set before
// concurrent Sends begin on the Conn.
func (c *Conn) SetWriteTimeout(d time.Duration) {
	if d <= 0 {
		c.writeTimeoutNanos.Store(0)
		return
	}
	c.writeTimeoutNanos.Store(int64(d))
}

// effectiveWriteTimeout returns the per-Conn override if one is set, else the
// package-level default (read live so tests that shorten writeTimeout apply).
func (c *Conn) effectiveWriteTimeout() time.Duration {
	if n := c.writeTimeoutNanos.Load(); n > 0 {
		return time.Duration(n)
	}
	return writeTimeout
}

// Recv reads a length-prefixed JSON message, validates HMAC and sequence.
func (c *Conn) Recv() (*Envelope, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(c.conn, header); err != nil {
		return nil, fmt.Errorf("ipc: read header: %w", err)
	}

	length := binary.BigEndian.Uint32(header)
	if length > uint32(MaxMessageSize) {
		return nil, fmt.Errorf("ipc: message too large: %d > %d", length, MaxMessageSize)
	}
	if length == 0 {
		return nil, fmt.Errorf("ipc: zero-length message")
	}

	data := make([]byte, length)
	if _, err := io.ReadFull(c.conn, data); err != nil {
		return nil, fmt.Errorf("ipc: read payload: %w", err)
	}

	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return nil, fmt.Errorf("ipc: unmarshal envelope: %w", err)
	}

	// Validate HMAC
	expected := c.computeHMAC(&env)
	if env.HMAC != expected {
		return nil, fmt.Errorf("ipc: HMAC mismatch")
	}

	// Validate sequence number (must be > 0 and strictly increasing)
	if env.Seq == 0 {
		return nil, fmt.Errorf("ipc: invalid sequence number 0")
	}
	prevSeq := c.recvSeq.Load()
	if env.Seq <= prevSeq {
		return nil, fmt.Errorf("ipc: sequence number %d <= last %d (replay/duplicate)", env.Seq, prevSeq)
	}
	c.recvSeq.Store(env.Seq)

	return &env, nil
}

// SendTyped is a convenience that wraps a typed payload into an Envelope and sends it.
func (c *Conn) SendTyped(id, msgType string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("ipc: marshal payload: %w", err)
	}
	env := &Envelope{
		ID:      id,
		Type:    msgType,
		Payload: raw,
	}
	return c.Send(env)
}

// SendError sends an error envelope.
func (c *Conn) SendError(id, msgType, errMsg string) error {
	env := &Envelope{
		ID:    id,
		Type:  msgType,
		Error: errMsg,
	}
	return c.Send(env)
}

// jsonNull is the canonical JSON representation of null, used to normalise
// nil payloads so that the HMAC is identical before and after JSON round-trip.
// (encoding/json marshals a nil json.RawMessage as "null"; on unmarshal it
// becomes []byte("null"), not nil — without this normalisation the sender
// writes 0 bytes but the receiver writes 4, causing HMAC mismatch.)
var jsonNull = json.RawMessage("null")

// computeHMAC calculates HMAC-SHA256(key, id||seq||type||payload).
func (c *Conn) computeHMAC(env *Envelope) string {
	c.keyMu.RLock()
	key := c.sessionKey
	c.keyMu.RUnlock()
	if key == nil {
		key = zeroKey
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(env.ID))
	mac.Write([]byte(strconv.FormatUint(env.Seq, 10)))
	mac.Write([]byte(env.Type))
	payload := env.Payload
	if payload == nil {
		payload = jsonNull
	}
	mac.Write(payload)
	return hex.EncodeToString(mac.Sum(nil))
}

// GenerateSessionKey creates a cryptographically random 256-bit key.
func GenerateSessionKey() ([]byte, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("ipc: generate session key: %w", err)
	}
	return key, nil
}
