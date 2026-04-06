package watchdog

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// IPCClient connects to the agent's IPC socket as a watchdog role client.
// It implements IPCProber via the Ping method.
type IPCClient struct {
	mu         sync.Mutex
	socketPath string
	conn       *ipc.Conn
	connected  bool
	onMessage  func(*ipc.Envelope)
	stopCh     chan struct{}
	lastPingAt time.Time
	lastPongAt time.Time
}

// NewIPCClient constructs an IPCClient that will connect to socketPath and
// call onMessage for each envelope received from the agent.
func NewIPCClient(socketPath string, onMessage func(*ipc.Envelope)) *IPCClient {
	return &IPCClient{
		socketPath: socketPath,
		onMessage:  onMessage,
		stopCh:     make(chan struct{}),
	}
}

// Connect dials the Unix socket, authenticates as a watchdog role client,
// and starts the receive loop. It must be called before Ping.
func (c *IPCClient) Connect() error {
	raw, err := dialIPC(c.socketPath)
	if err != nil {
		return fmt.Errorf("watchdog ipc: connect to %s: %w", c.socketPath, err)
	}

	conn := ipc.NewConn(raw)

	binaryHash, _ := c.selfHash()

	authReq := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             uint32(os.Getuid()),
		PID:             os.Getpid(),
		BinaryHash:      binaryHash,
		HelperRole:      ipc.HelperRoleWatchdog,
	}

	if err := conn.SendTyped("auth", ipc.TypeAuthRequest, authReq); err != nil {
		raw.Close()
		return fmt.Errorf("watchdog ipc: send auth request: %w", err)
	}

	env, err := conn.Recv()
	if err != nil {
		raw.Close()
		return fmt.Errorf("watchdog ipc: recv auth response: %w", err)
	}
	if env.Type != ipc.TypeAuthResponse {
		raw.Close()
		return fmt.Errorf("watchdog ipc: expected auth_response, got %s", env.Type)
	}

	var authResp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &authResp); err != nil {
		raw.Close()
		return fmt.Errorf("watchdog ipc: unmarshal auth response: %w", err)
	}
	if !authResp.Accepted {
		raw.Close()
		return fmt.Errorf("watchdog ipc: auth rejected: %s", authResp.Reason)
	}

	key, err := hex.DecodeString(authResp.SessionKey)
	if err != nil {
		raw.Close()
		return fmt.Errorf("watchdog ipc: decode session key: %w", err)
	}
	conn.SetSessionKey(key)

	c.mu.Lock()
	c.conn = conn
	c.connected = true
	c.mu.Unlock()

	go c.readLoop()
	return nil
}

// Ping implements IPCProber. It checks whether the previous ping received a
// pong (indicating the agent is responsive), records the current time as the
// new ping timestamp, and sends a watchdog_ping. On the very first call there
// is no prior ping/pong pair, so true is returned optimistically.
//
// Because pongs arrive asynchronously, three consecutive calls without any
// pong in between will return false — indicating a hung agent.
func (c *IPCClient) Ping() (bool, error) {
	c.mu.Lock()
	if !c.connected || c.conn == nil {
		c.mu.Unlock()
		return false, fmt.Errorf("watchdog ipc: not connected")
	}
	// Check whether the last ping got a response.
	firstPing := c.lastPingAt.IsZero()
	gotPong := !c.lastPongAt.IsZero() && c.lastPongAt.After(c.lastPingAt)
	c.lastPingAt = time.Now()
	conn := c.conn
	c.mu.Unlock()

	ping := ipc.WatchdogPing{RequestHealthSummary: false}
	if err := conn.SendTyped("wd-ping", ipc.TypeWatchdogPing, ping); err != nil {
		return false, fmt.Errorf("watchdog ipc: send ping: %w", err)
	}

	// On the very first ping there has been no opportunity to receive a pong
	// yet, so we give the agent the benefit of the doubt.
	if firstPing {
		return true, nil
	}

	return gotPong, nil
}

// IsConnected returns whether the client currently has an active connection.
func (c *IPCClient) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.connected
}

// Close sends a disconnect message, marks the client as disconnected, and
// closes the stop channel to terminate the read loop.
func (c *IPCClient) Close() {
	c.mu.Lock()
	conn := c.conn
	alreadyClosed := !c.connected
	c.connected = false
	c.mu.Unlock()

	if alreadyClosed {
		return
	}

	// Signal readLoop to exit.
	select {
	case <-c.stopCh:
	default:
		close(c.stopCh)
	}

	if conn != nil {
		// Best-effort disconnect notification.
		_ = conn.SendTyped("disconnect", ipc.TypeDisconnect, nil)
		conn.Close()
	}
}

// readLoop reads envelopes from the connection until it is closed or an error
// occurs. Each envelope is forwarded to the onMessage callback. On any read
// error the client is marked disconnected and the loop exits.
func (c *IPCClient) readLoop() {
	c.mu.Lock()
	conn := c.conn
	c.mu.Unlock()

	for {
		select {
		case <-c.stopCh:
			return
		default:
		}

		env, err := conn.Recv()
		if err != nil {
			fmt.Fprintf(os.Stderr, "watchdog ipc: read loop error: %v\n", err)
			c.mu.Lock()
			c.connected = false
			c.mu.Unlock()
			return
		}

		if env.Type == ipc.TypeWatchdogPong {
			c.mu.Lock()
			c.lastPongAt = time.Now()
			c.mu.Unlock()
		}

		if c.onMessage != nil {
			c.onMessage(env)
		}
	}
}

// selfHash computes the SHA-256 hash of the current executable and returns it
// as a lowercase hex string. Errors are non-fatal; callers should use an empty
// string on failure.
func (c *IPCClient) selfHash() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return "", err
	}
	f, err := os.Open(exePath)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
