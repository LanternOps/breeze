package tunnel

import (
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("tunnel")

const (
	readBufSize = 32 * 1024 // 32KB read chunks
	dialTimeout = 10 * time.Second
)

// DataCallback is called when data is read from the TCP connection.
type DataCallback func(tunnelID string, data []byte)

// CloseCallback is called when the tunnel is closed.
type CloseCallback func(tunnelID string, err error)

// Session represents a single TCP tunnel relay session.
type Session struct {
	ID         string
	TargetHost string
	TargetPort int
	TunnelType string // "vnc" or "proxy"

	conn       net.Conn
	done       chan struct{}
	closeOnce  sync.Once
	onData     DataCallback
	onClose    CloseCallback
	bytesSent  atomic.Int64
	bytesRecv  atomic.Int64
	lastActive atomic.Int64 // unix timestamp
	createdAt  time.Time
}

// Open dials the target and starts a read loop that calls onData for each chunk.
// The session runs until Close is called or the TCP connection is broken.
func Open(id, host string, port int, tunnelType string, onData DataCallback, onClose CloseCallback) (*Session, error) {
	if onData == nil {
		return nil, fmt.Errorf("onData callback must not be nil")
	}

	addr := net.JoinHostPort(host, fmt.Sprintf("%d", port))

	conn, err := net.DialTimeout("tcp", addr, dialTimeout)
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}

	s := &Session{
		ID:         id,
		TargetHost: host,
		TargetPort: port,
		TunnelType: tunnelType,
		conn:       conn,
		done:       make(chan struct{}),
		onData:     onData,
		onClose:    onClose,
		createdAt:  time.Now(),
	}
	s.touch()

	go s.readLoop()

	log.Info("tunnel opened",
		"tunnelId", id,
		"target", addr,
		"type", tunnelType,
	)
	return s, nil
}

// Write sends data from the API/browser side into the TCP connection.
func (s *Session) Write(data []byte) error {
	select {
	case <-s.done:
		return fmt.Errorf("tunnel %s is closed", s.ID)
	default:
	}

	n, err := s.conn.Write(data)
	if err != nil {
		return fmt.Errorf("write to %s:%d: %w", s.TargetHost, s.TargetPort, err)
	}
	s.bytesSent.Add(int64(n))
	s.touch()
	return nil
}

// Close tears down the TCP connection and signals the read loop to stop.
func (s *Session) Close() {
	s.closeOnce.Do(func() {
		close(s.done)
		s.conn.Close()
		log.Info("tunnel closed",
			"tunnelId", s.ID,
			"bytesSent", s.bytesSent.Load(),
			"bytesRecv", s.bytesRecv.Load(),
			"duration", time.Since(s.createdAt).String(),
		)
	})
}

// BytesSent returns total bytes written to the target.
func (s *Session) BytesSent() int64 { return s.bytesSent.Load() }

// BytesRecv returns total bytes read from the target.
func (s *Session) BytesRecv() int64 { return s.bytesRecv.Load() }

// LastActive returns the unix timestamp of the last read or write.
func (s *Session) LastActive() int64 { return s.lastActive.Load() }

// CreatedAt returns when the session was created.
func (s *Session) CreatedAt() time.Time { return s.createdAt }

func (s *Session) touch() {
	s.lastActive.Store(time.Now().Unix())
}

func (s *Session) readLoop() {
	buf := make([]byte, readBufSize)
	var closeErr error

	defer func() {
		s.Close()
		if s.onClose != nil {
			s.onClose(s.ID, closeErr)
		}
	}()

	for {
		select {
		case <-s.done:
			return
		default:
		}

		n, err := s.conn.Read(buf)
		if n > 0 {
			s.bytesRecv.Add(int64(n))
			s.touch()

			// Make a copy — buf is reused.
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			s.onData(s.ID, chunk)
		}
		if err != nil {
			if err != io.EOF {
				closeErr = err
			}
			return
		}
	}
}
