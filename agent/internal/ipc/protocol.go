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

// Conn wraps a net.Conn with length-prefixed JSON framing, HMAC signing,
// and sequence number validation.
type Conn struct {
	conn       net.Conn
	sessionKey []byte
	sendSeq    atomic.Uint64
	recvSeq    atomic.Uint64
	mu         sync.Mutex // serializes writes
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
	c.sessionKey = key
}

// SessionKey returns the current session key.
func (c *Conn) SessionKey() []byte {
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

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, uint32(len(data)))

	if _, err := c.conn.Write(header); err != nil {
		return fmt.Errorf("ipc: write header: %w", err)
	}
	if _, err := c.conn.Write(data); err != nil {
		return fmt.Errorf("ipc: write payload: %w", err)
	}
	return nil
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

	// Validate sequence number (must be strictly increasing)
	prevSeq := c.recvSeq.Load()
	if env.Seq <= prevSeq && prevSeq > 0 {
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

// computeHMAC calculates HMAC-SHA256(key, id||seq||type||payload).
func (c *Conn) computeHMAC(env *Envelope) string {
	key := c.sessionKey
	if key == nil {
		key = zeroKey
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(env.ID))
	mac.Write([]byte(strconv.FormatUint(env.Seq, 10)))
	mac.Write([]byte(env.Type))
	mac.Write(env.Payload)
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
