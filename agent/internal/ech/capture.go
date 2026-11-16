package ech

import (
	"bytes"
	"context"
	"errors"
	"net"
	"os"
	"sync"
	"time"
)

// captureLimit caps how many plaintext bytes a captureConn keeps (#8868).
const captureLimit = 4096

// filterDrainBudget caps how long a dial waits for the rest of a filter's
// plaintext reply after the TLS layer gave up on it.
const filterDrainBudget = time.Second

// headerEnd terminates an HTTP/1.x header block.
var headerEnd = []byte("\r\n\r\n")

// captureConn wraps the raw TCP connection of a plain TLS attempt and keeps a
// copy of what was read, but only when the first byte is not a TLS record type
// (0x14-0x17). crypto/tls reads ahead into its own buffer, so without this the
// bytes after a filter's 5-byte "HTTP/" header are lost. A real TLS server's
// first byte stops capture for good, so a healthy connection buffers nothing.
// It never writes, so the bytes on the wire are unchanged.
type captureConn struct {
	net.Conn

	mu        sync.Mutex
	decided   bool
	capturing bool
	buf       []byte
}

func newCaptureConn(c net.Conn) *captureConn { return &captureConn{Conn: c} }

// Read reads from the wrapped conn, teeing up to captureLimit bytes while
// capturing. The first non-empty read decides whether to capture.
func (c *captureConn) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if n > 0 {
		c.mu.Lock()
		if !c.decided {
			c.decided = true
			c.capturing = !isTLSRecordType(p[0])
		}
		if c.capturing {
			if room := captureLimit - len(c.buf); room > 0 {
				take := n
				if take > room {
					take = room
				}
				c.buf = append(c.buf, p[:take]...)
			}
		}
		c.mu.Unlock()
	}
	return n, err
}

// isTLSRecordType reports whether b is a TLS record content type:
// change_cipher_spec, alert, handshake or application_data.
func isTLSRecordType(b byte) bool { return b >= 0x14 && b <= 0x17 }

// Captured returns a copy of the captured bytes (nil when none).
func (c *captureConn) Captured() []byte {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.buf) == 0 {
		return nil
	}
	return append([]byte(nil), c.buf...)
}

// complete reports whether no more bytes are worth reading: capture is off,
// the cap is reached, or the header block has ended.
func (c *captureConn) complete() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return (c.decided && !c.capturing) || len(c.buf) >= captureLimit || bytes.Contains(c.buf, headerEnd)
}

// drainHeaders reads the rest of a plaintext reply through c (so it is
// captured) until the header block ends, the cap is reached, the peer closes
// or errors, or min(max, ctx's deadline) passes. It never resumes TLS: the
// caller closes the connection afterwards. The read deadline is reset on
// return.
func (c *captureConn) drainHeaders(ctx context.Context, max time.Duration) {
	if ctx.Err() != nil || c.complete() {
		return
	}
	deadline := time.Now().Add(max)
	if dl, ok := ctx.Deadline(); ok && dl.Before(deadline) {
		deadline = dl
	}
	if err := c.Conn.SetReadDeadline(deadline); err != nil {
		return
	}
	defer func() { _ = c.Conn.SetReadDeadline(time.Time{}) }()
	// A caller cancellation without a deadline still ends the drain.
	stop := context.AfterFunc(ctx, func() { _ = c.Conn.SetReadDeadline(time.Now()) })
	defer stop()
	scratch := make([]byte, 1024)
	for !c.complete() {
		if _, err := c.Read(scratch); err != nil {
			if !errors.Is(err, os.ErrDeadlineExceeded) {
				log.Debug("filter reply drain ended", "error", err.Error())
			}
			return
		}
	}
}
