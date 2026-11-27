package ipc

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	// sendSeq is the outbound sequence counter and the canonical statement of
	// this type's ordering invariant: it must be advanced ONLY with mu held.
	// The receiver enforces strict ordering, not just uniqueness, so a number
	// handed out without the write lock can reach the socket after a higher one
	// and be discarded as a replay (issue #3007). Atomicity alone does not buy
	// that ordering — the type is atomic only so TestConnSendSeqAssignedUnder-
	// WriteLock can observe the counter without racing it.
	sendSeq atomic.Uint64
	// recvSeq is the inbound counter. Recv load-then-stores it non-atomically
	// with respect to other Recv calls, so a Conn must have a single reader;
	// every caller today runs one Recv loop.
	recvSeq atomic.Uint64
	// Partial-frame read state, owned by the single reader (see recvSeq).
	// Callers arm a short read deadline before each Recv and treat a timeout as
	// an idle tick (the user helper every 5s, breeze-backup every 1s), so a
	// deadline can fire after part of a frame has been consumed. These fields
	// keep those bytes so the next Recv resumes the same frame instead of
	// parsing body bytes as a length header (issue #10541).
	rhdr   [4]byte
	rhdrN  int    // header bytes read so far
	rbody  []byte // non-nil once the header is complete and valid
	rbodyN int    // body bytes read so far
	// recvErr makes a framing failure sticky: once the stream has lost sync
	// (oversize length, frame deadline) every later Recv returns it.
	recvErr error
	// frameDeadlineAt is the absolute time by which the frame in progress
	// must complete; zero when no frame deadline is armed. Reader-owned.
	frameDeadlineAt time.Time
	// lastFrameLen is the body length of the most recent frame Recv
	// returned. Reader-owned; see LastRecvFrameSize.
	lastFrameLen int
	// maxRecv caps the body length Recv accepts, checked against the header
	// before any allocation; 0 means MaxMessageSize (see SetMaxRecvSize).
	maxRecv atomic.Uint32
	// frameDeadlineNanos, when > 0, bounds how long one frame may take from
	// its first header byte to its last body byte (see SetFrameDeadline).
	frameDeadlineNanos atomic.Int64
	mu                 sync.Mutex // serializes writes
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
//
// Send mutates env (Seq and HMAC), so a caller must not share one *Envelope
// across concurrent Sends — build a fresh envelope per call, as SendTyped and
// SendError do.
func (c *Conn) Send(env *Envelope) error {
	// Fast path so an already-poisoned Conn fails without contending for the
	// write lock. The authoritative check is repeated under c.mu below.
	if err := c.poisonedErr(); err != nil {
		return err
	}

	// Reject an oversized payload before taking the lock. The authoritative
	// check is on the marshalled frame below, but that one runs inside the
	// critical section, so without this a caller could hold c.mu across the
	// hashing and marshalling of an arbitrarily large payload only to have it
	// rejected — starving every other writer, including the keepalive pong
	// whose absence gets the macOS user helper evicted (issue #2273). This
	// bounds the in-lock work to roughly MaxMessageSize.
	if len(env.Payload) > MaxMessageSize {
		return fmt.Errorf("ipc: payload too large: %d > %d", len(env.Payload), MaxMessageSize)
	}

	// The sequence number, the HMAC that covers it, the marshal and the socket
	// write all happen under c.mu. That is what makes the number a frame
	// carries agree with the order it reaches the socket: Recv enforces strict
	// monotonicity, so a number handed out before the lock let two concurrent
	// senders take seq 1 and 2 and arrive as 2 then 1 (issue #3007). The loser
	// is not merely dropped — every Recv caller treats the error as fatal, so
	// one reordered frame tears down the whole IPC session, which is how a
	// backup's terminal result goes missing.
	//
	// This widens the critical section to cover computeHMAC and json.Marshal.
	// Both are pure CPU proportional to payload size and are now bounded by the
	// pre-lock check above, against a lock that already covers two blocking
	// socket writes sharing a 30s deadline. It does not reintroduce the #2273
	// wedge, which was about *unbounded* blocking on a stalled peer: the only
	// blocking call inside the lock is still the deadline-bounded write, and
	// keyMu (taken by computeHMAC) is held only across a pointer read.
	//
	// An ordered handoff — seq under the lock, marshal outside, write in seq
	// order via a ticket — was considered and rejected; see the commit message
	// and PR for #3007. In short: writes are totally ordered anyway, so it only
	// pipelines CPU against a single write, and it pays with an unbounded
	// ticket wait that no deadline bounds.
	c.mu.Lock()
	defer c.mu.Unlock()

	// Re-check under the lock. A Send that cleared the fast path may have
	// queued behind a writer that poisoned the Conn in the meantime, and
	// framing is length-prefixed, so appending a frame after a partial one
	// desyncs the peer's stream.
	if err := c.poisonedErr(); err != nil {
		return err
	}

	env.Seq = c.sendSeq.Add(1)
	env.HMAC = c.computeHMAC(env)

	data, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("ipc: marshal envelope: %w", err)
	}

	// Catches an envelope whose framing overhead pushes a just-under-limit
	// payload over. A rejected message still consumed a sequence number, which
	// is fine: Recv requires each Seq to be greater than the last, not
	// contiguous, so gaps are legal.
	if len(data) > MaxMessageSize {
		return fmt.Errorf("ipc: message too large: %d > %d", len(data), MaxMessageSize)
	}

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

	// Header and body go out as ONE write (#12808). Two writes put the header
	// on a named pipe on its own, and a peer that reads it apart from the
	// body is exposed to any reader bug that drops a half-read frame — Assist
	// lost the header that way when a timer cancelled its read between the
	// two. c.mu already keeps frames from interleaving; this keeps each one
	// whole in a single delivery wherever the transport allows. The copy is
	// bounded by MaxMessageSize, like the marshal above.
	frame := make([]byte, 4+len(data))
	binary.BigEndian.PutUint32(frame, uint32(len(data)))
	copy(frame[4:], data)

	// A Write that errors (deadline exceeded, reset) may have already put a
	// partial frame on the wire, so poison the Conn — subsequent Sends fail
	// fast rather than piling more frames onto a desynced stream.
	if _, err := c.conn.Write(frame); err != nil {
		return c.poison(fmt.Errorf("ipc: write frame: %w", err))
	}
	return nil
}

// poisonedErr reports the latched cause if a prior write poisoned this Conn,
// or nil if it is still usable.
func (c *Conn) poisonedErr() error {
	if !c.writePoisoned.Load() {
		return nil
	}
	if cause := c.firstWriteErr.Load(); cause != nil {
		return fmt.Errorf("ipc: connection poisoned by prior write error: %w", *cause)
	}
	return fmt.Errorf("ipc: connection poisoned by prior write error")
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
//
// Recv is resumable across read-deadline timeouts. If the deadline fires
// partway through a frame, Recv returns the (wrapped) timeout error and keeps
// the bytes already read; the next call continues the same frame. Without
// this, the bytes consumed before the timeout were lost and the next Recv
// started mid-frame, reading `{"id` as a length — the "message too large:
// 2065852772" desync of issue #10541. The wire format is unchanged.
//
// A framing error (impossible length) is sticky: the stream has lost sync and
// cannot recover, so every later Recv reports the same error rather than
// guessing at a frame boundary. Callers already treat it as fatal.
func (c *Conn) Recv() (*Envelope, error) {
	if c.recvErr != nil {
		return nil, c.recvErr
	}
	if c.rbody == nil {
		if c.rhdrN == 0 {
			if err := c.beginFrame(); err != nil {
				return nil, err
			}
		}
		n, err := io.ReadFull(c.conn, c.rhdr[c.rhdrN:])
		c.rhdrN += n
		if err != nil {
			return nil, c.frameReadError("header", err)
		}

		length := binary.BigEndian.Uint32(c.rhdr[:])
		if limit := c.maxRecvSize(); length > uint32(limit) {
			// Checked before make(): a peer cannot make the reader allocate
			// more than the cap by announcing it. The raw header bytes make
			// a desync diagnosable from the shipped log line: ASCII here
			// means the reader is inside a JSON body.
			c.recvErr = fmt.Errorf("ipc: message too large: %d > %d (header %x)", length, limit, c.rhdr[:])
			return nil, c.recvErr
		}
		if length == 0 {
			c.recvErr = fmt.Errorf("ipc: zero-length message")
			return nil, c.recvErr
		}
		c.rbody = make([]byte, length)
		c.rbodyN = 0
	}

	n, err := io.ReadFull(c.conn, c.rbody[c.rbodyN:])
	c.rbodyN += n
	if err != nil {
		return nil, c.frameReadError("payload", err)
	}

	// Frame complete: reset for the next one before validating, so a frame
	// that fails HMAC or sequence checks is not re-read.
	data := c.rbody
	c.rhdrN, c.rbody, c.rbodyN = 0, nil, 0
	c.lastFrameLen = len(data)
	if !c.frameDeadlineAt.IsZero() {
		c.frameDeadlineAt = time.Time{}
		// Waiting for the next frame to begin is unbounded again (the
		// keepalive owns idleness). A failed clear surfaces on the next read.
		_ = c.conn.SetReadDeadline(time.Time{})
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

// PreAuthMaxMessageSize is the largest frame the broker accepts from a peer
// it has not admitted yet. An auth request is a few KiB at most.
const PreAuthMaxMessageSize = 64 << 10

// SetMaxRecvSize caps the body length Recv will accept on this Conn. The cap
// is compared with the 4-byte length header before the body buffer is
// allocated, so an unauthenticated or hostile peer cannot make the reader
// allocate more than n by announcing a large frame. 0 (or anything above
// MaxMessageSize) means MaxMessageSize. Safe to call between Recvs.
func (c *Conn) SetMaxRecvSize(n uint32) {
	if n > MaxMessageSize {
		n = 0
	}
	c.maxRecv.Store(n)
}

func (c *Conn) maxRecvSize() int {
	if n := c.maxRecv.Load(); n > 0 {
		return int(n)
	}
	return MaxMessageSize
}

// SetFrameDeadline bounds how long one frame may take, measured from its
// first header byte to its last body byte; 0 turns it off. Waiting for a
// frame to begin stays unbounded. A frame that misses the deadline fails Recv
// permanently (the peer is trickling, and the stream cannot be trusted to
// resynchronise). While it is on, Recv owns the connection's read deadline:
// callers must not arm their own with SetReadDeadline.
func (c *Conn) SetFrameDeadline(d time.Duration) {
	if d < 0 {
		d = 0
	}
	c.frameDeadlineNanos.Store(int64(d))
}

// LastRecvFrameSize is the body length, in bytes, of the frame behind the
// envelope Recv most recently returned. Like Recv it belongs to the single
// reader.
func (c *Conn) LastRecvFrameSize() int {
	return c.lastFrameLen
}

// beginFrame runs before the first header byte of a frame is read. With a
// frame deadline armed it waits (unbounded) for that first byte, then sets
// the absolute deadline the rest of the frame must meet.
func (c *Conn) beginFrame() error {
	d := time.Duration(c.frameDeadlineNanos.Load())
	if d <= 0 {
		return nil
	}
	n, err := io.ReadFull(c.conn, c.rhdr[:1])
	c.rhdrN += n
	if err != nil {
		return fmt.Errorf("ipc: read header: %w", err)
	}
	c.frameDeadlineAt = time.Now().Add(d)
	if err := c.conn.SetReadDeadline(c.frameDeadlineAt); err != nil {
		c.recvErr = fmt.Errorf("ipc: arm frame deadline: %w", err)
		return c.recvErr
	}
	return nil
}

// frameReadError wraps a read failure. A timeout while a frame deadline is
// armed means the peer did not finish its frame in time: sticky.
func (c *Conn) frameReadError(part string, err error) error {
	var netErr net.Error
	if !c.frameDeadlineAt.IsZero() && errors.As(err, &netErr) && netErr.Timeout() {
		c.recvErr = fmt.Errorf("ipc: frame deadline exceeded reading %s (%d header, %d body bytes received): %w",
			part, c.rhdrN, c.rbodyN, err)
		return c.recvErr
	}
	return fmt.Errorf("ipc: read %s: %w", part, err)
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
