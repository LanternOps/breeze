package websocket

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/url"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("websocket")

const (
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024
	initialBackoff = 1 * time.Second
	maxBackoff     = 60 * time.Second
	backoffFactor  = 2.0
	jitterFactor   = 0.3
)

// Config holds WebSocket client configuration
type Config struct {
	ServerURL string
	AgentID   string
	AuthToken string
}

// Command represents a command received via WebSocket
type Command struct {
	ID      string         `json:"id"`
	Type    string         `json:"type"`
	Payload map[string]any `json:"payload"`
}

// CommandResult represents the result of a command execution
type CommandResult struct {
	Type      string `json:"type"`
	CommandID string `json:"commandId"`
	Status    string `json:"status"`
	Result    any    `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
}

// CommandHandler processes commands received via WebSocket
type CommandHandler func(cmd Command) CommandResult

// Client manages the WebSocket connection to the server
type Client struct {
	config          *Config
	conn            *websocket.Conn
	connMu          sync.RWMutex
	cmdHandler      CommandHandler
	done            chan struct{}
	sendChan        chan []byte
	binaryFrameChan chan []byte
	stopOnce        sync.Once
	isRunning       bool
	runningMu       sync.RWMutex
}

// New creates a new WebSocket client
func New(cfg *Config, handler CommandHandler) *Client {
	return &Client{
		config:          cfg,
		cmdHandler:      handler,
		done:            make(chan struct{}),
		sendChan:        make(chan []byte, 256),
		binaryFrameChan: make(chan []byte, 30),
	}
}

// Start begins the WebSocket client
func (c *Client) Start() {
	c.runningMu.Lock()
	if c.isRunning {
		c.runningMu.Unlock()
		return
	}
	c.isRunning = true
	c.runningMu.Unlock()

	c.reconnectLoop()
}

// Stop gracefully closes the connection
func (c *Client) Stop() {
	c.stopOnce.Do(func() {
		c.runningMu.Lock()
		c.isRunning = false
		c.runningMu.Unlock()

		close(c.done)

		c.connMu.Lock()
		if c.conn != nil {
			c.conn.WriteControl(
				websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
				time.Now().Add(writeWait),
			)
			c.conn.Close()
			c.conn = nil
		}
		c.connMu.Unlock()

		log.Info("client stopped")
	})
}

func (c *Client) connect() error {
	wsURL, err := c.buildWSURL()
	if err != nil {
		return fmt.Errorf("failed to build WebSocket URL: %w", err)
	}

	dialer := websocket.Dialer{HandshakeTimeout: 10 * time.Second}
	conn, _, err := dialer.Dial(wsURL, nil)
	if err != nil {
		return fmt.Errorf("failed to connect: %w", err)
	}

	c.connMu.Lock()
	c.conn = conn
	c.connMu.Unlock()

	conn.SetReadLimit(maxMessageSize)
	log.Info("connected", "server", c.config.ServerURL)
	return nil
}

func (c *Client) buildWSURL() (string, error) {
	serverURL, err := url.Parse(c.config.ServerURL)
	if err != nil {
		return "", err
	}

	switch serverURL.Scheme {
	case "https":
		serverURL.Scheme = "wss"
	case "http":
		serverURL.Scheme = "ws"
	}

	serverURL.Path = fmt.Sprintf("/api/v1/agent-ws/%s/ws", c.config.AgentID)
	q := serverURL.Query()
	q.Set("token", c.config.AuthToken)
	serverURL.RawQuery = q.Encode()

	return serverURL.String(), nil
}

func (c *Client) reconnectLoop() {
	backoff := initialBackoff

	for {
		select {
		case <-c.done:
			return
		default:
		}

		if err := c.connect(); err != nil {
			log.Warn("connection failed", "error", err)

			jitter := time.Duration(float64(backoff) * jitterFactor * (rand.Float64()*2 - 1))
			sleep := backoff + jitter
			if sleep < 0 {
				sleep = backoff
			}

			log.Info("retrying", "delay", sleep)
			select {
			case <-c.done:
				return
			case <-time.After(sleep):
			}

			backoff = time.Duration(float64(backoff) * backoffFactor)
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
			continue
		}

		// Reset backoff on successful connection
		backoff = initialBackoff

		// Run read/write pumps
		done := make(chan struct{})
		go c.writePump(done)
		c.readPump()
		close(done)

		// Check if we should stop
		c.runningMu.RLock()
		running := c.isRunning
		c.runningMu.RUnlock()
		if !running {
			return
		}
	}
}

func (c *Client) readPump() {
	c.connMu.RLock()
	conn := c.conn
	c.connMu.RUnlock()

	if conn == nil {
		return
	}

	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Warn("read error", "error", err)
			}
			return
		}

		// First, check if this is a server message (has type but no id)
		var msg struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Warn("failed to parse message", "error", err)
			continue
		}

		// Skip non-command messages (connected, ack, heartbeat_ack, error, etc.)
		// Commands have both an ID and a type like "run_script", "list_processes", etc.
		if msg.ID == "" {
			// Server acknowledgments, errors, etc. - not commands
			continue
		}

		var cmd Command
		if err := json.Unmarshal(message, &cmd); err != nil {
			log.Warn("failed to parse command", "error", err)
			continue
		}

		go c.processCommand(cmd)
	}
}

func (c *Client) writePump(done chan struct{}) {
	ticker := time.NewTicker(pingPeriod)
	defer ticker.Stop()

	for {
		select {
		case <-done:
			return
		case <-c.done:
			return

		case message := <-c.sendChan:
			c.connMu.RLock()
			conn := c.conn
			c.connMu.RUnlock()

			if conn == nil {
				continue
			}

			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.TextMessage, message); err != nil {
				log.Warn("write error", "error", err)
				return
			}

		case frame := <-c.binaryFrameChan:
			c.connMu.RLock()
			conn := c.conn
			c.connMu.RUnlock()

			if conn == nil {
				continue
			}

			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.BinaryMessage, frame); err != nil {
				log.Warn("binary write error", "error", err)
				return
			}

		case <-ticker.C:
			c.connMu.RLock()
			conn := c.conn
			c.connMu.RUnlock()

			if conn == nil {
				continue
			}

			conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) processCommand(cmd Command) {
	log.Info("processing command", "commandId", cmd.ID, "commandType", cmd.Type)

	result := c.cmdHandler(cmd)
	result.Type = "command_result"
	result.CommandID = cmd.ID

	if err := c.SendResult(result); err != nil {
		log.Error("failed to send command result", "error", err)
	}
}

// SendResult sends a command result back to the server
func (c *Client) SendResult(result CommandResult) error {
	data, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}

	select {
	case c.sendChan <- data:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel is full")
	}
}

// SendDesktopFrame sends a binary JPEG frame to the server.
// Format: [0x02][36-byte sessionId UTF-8][JPEG data]
// Non-blocking: drops frame if channel is full.
func (c *Client) SendDesktopFrame(sessionId string, data []byte) error {
	// Build binary message: 1 byte type + 36 byte session ID + frame data
	msg := make([]byte, 1+36+len(data))
	msg[0] = 0x02
	copy(msg[1:37], []byte(sessionId))
	copy(msg[37:], data)

	select {
	case c.binaryFrameChan <- msg:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("frame channel full, dropping frame")
	}
}

// SendTerminalOutput sends terminal output data to the server
func (c *Client) SendTerminalOutput(sessionId string, data []byte) error {
	msg := map[string]any{
		"type":      "terminal_output",
		"sessionId": sessionId,
		"data":      string(data),
	}
	msgBytes, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("failed to marshal terminal output: %w", err)
	}

	select {
	case c.sendChan <- msgBytes:
		return nil
	case <-c.done:
		return fmt.Errorf("client is stopped")
	default:
		return fmt.Errorf("send channel full")
	}
}
