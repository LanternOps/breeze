package userhelper

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
)

var log = logging.L("userhelper")

// Client is the user-helper side of the IPC connection to the root daemon.
type Client struct {
	socketPath string
	conn       *ipc.Conn
	sessionKey []byte
	agentID    string
	scopes     []string
	stopChan   chan struct{}
}

// New creates a new user helper client.
func New(socketPath string) *Client {
	return &Client{
		socketPath: socketPath,
		stopChan:   make(chan struct{}),
	}
}

// Run connects to the root daemon, authenticates, and enters the command loop.
// Blocks until stopChan is closed or the connection drops.
func (c *Client) Run() error {
	if err := c.connect(); err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer c.conn.Close()

	if err := c.authenticate(); err != nil {
		return fmt.Errorf("authenticate: %w", err)
	}

	if err := c.sendCapabilities(); err != nil {
		log.Warn("failed to send capabilities", "error", err)
	}

	log.Info("user helper connected and authenticated", "agentId", c.agentID)

	// Enter command loop
	return c.commandLoop()
}

// Stop signals the client to shut down gracefully.
func (c *Client) Stop() {
	select {
	case <-c.stopChan:
	default:
		close(c.stopChan)
	}
	if c.conn != nil {
		c.conn.SendTyped("disconnect", ipc.TypeDisconnect, nil)
		c.conn.Close()
	}
}

func (c *Client) connect() error {
	var conn net.Conn
	var err error

	if runtime.GOOS == "windows" {
		// Windows: try TCP fallback (development) or named pipe
		conn, err = net.DialTimeout("tcp", "127.0.0.1:0", 5*time.Second)
		if err != nil {
			return fmt.Errorf("connect to named pipe: %w", err)
		}
	} else {
		conn, err = net.DialTimeout("unix", c.socketPath, 5*time.Second)
		if err != nil {
			return fmt.Errorf("connect to %s: %w", c.socketPath, err)
		}
	}

	c.conn = ipc.NewConn(conn)
	return nil
}

func (c *Client) authenticate() error {
	cu, err := user.Current()
	if err != nil {
		return fmt.Errorf("get current user: %w", err)
	}

	uid, err := strconv.ParseUint(cu.Uid, 10, 32)
	if err != nil {
		// On Windows, UID is a SID string
		uid = 0
	}

	binaryHash, _ := computeSelfHash()
	displayEnv := detectDisplayEnv()
	sessionID := fmt.Sprintf("helper-%s-%d", cu.Username, os.Getpid())

	authReq := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             uint32(uid),
		Username:        cu.Username,
		SessionID:       sessionID,
		DisplayEnv:      displayEnv,
		PID:             os.Getpid(),
		BinaryHash:      binaryHash,
	}

	if err := c.conn.SendTyped("auth", ipc.TypeAuthRequest, authReq); err != nil {
		return fmt.Errorf("send auth request: %w", err)
	}

	// Read auth response
	env, err := c.conn.Recv()
	if err != nil {
		return fmt.Errorf("recv auth response: %w", err)
	}

	if env.Type != ipc.TypeAuthResponse {
		return fmt.Errorf("expected auth_response, got %s", env.Type)
	}

	var authResp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &authResp); err != nil {
		return fmt.Errorf("unmarshal auth response: %w", err)
	}

	if !authResp.Accepted {
		return fmt.Errorf("auth rejected: %s", authResp.Reason)
	}

	// Set session key
	key, err := hex.DecodeString(authResp.SessionKey)
	if err != nil {
		return fmt.Errorf("decode session key: %w", err)
	}
	c.conn.SetSessionKey(key)
	c.sessionKey = key
	c.agentID = authResp.AgentID
	c.scopes = authResp.AllowedScopes

	return nil
}

func (c *Client) sendCapabilities() error {
	caps := detectCapabilities()
	return c.conn.SendTyped("caps", ipc.TypeCapabilities, caps)
}

func (c *Client) commandLoop() error {
	for {
		select {
		case <-c.stopChan:
			return nil
		default:
		}

		// Set a read deadline so we can check stopChan periodically
		c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))

		env, err := c.conn.Recv()
		if err != nil {
			if isTimeout(err) {
				// Send ping to keep alive
				c.conn.SendTyped("ping", ipc.TypePing, nil)
				continue
			}
			return fmt.Errorf("recv: %w", err)
		}

		switch env.Type {
		case ipc.TypePing:
			c.conn.SendTyped(env.ID, ipc.TypePong, nil)

		case ipc.TypeCommand:
			go c.handleCommand(env)

		case ipc.TypeNotify:
			go c.handleNotify(env)

		case ipc.TypeTrayUpdate:
			go c.handleTrayUpdate(env)

		case ipc.TypeDesktopStart:
			go c.handleDesktopStart(env)

		case ipc.TypeDesktopStop:
			go c.handleDesktopStop(env)

		case ipc.TypeDesktopInput:
			go c.handleDesktopInput(env)

		case ipc.TypeClipboardGet:
			go c.handleClipboardGet(env)

		case ipc.TypeClipboardSet:
			go c.handleClipboardSet(env)

		case ipc.TypeDisconnect:
			log.Info("disconnect received from daemon")
			return nil

		default:
			log.Warn("unknown message type", "type", env.Type)
		}
	}
}

func (c *Client) handleCommand(env *ipc.Envelope) {
	var cmd ipc.IPCCommand
	if err := json.Unmarshal(env.Payload, &cmd); err != nil {
		c.conn.SendTyped(env.ID, ipc.TypeCommandResult, ipc.IPCCommandResult{
			CommandID: env.ID,
			Status:    "failed",
			Error:     fmt.Sprintf("invalid command payload: %v", err),
		})
		return
	}

	// Execute using the standard executor (runs in user context since this process is the user)
	result := c.executeScript(cmd)
	c.conn.SendTyped(env.ID, ipc.TypeCommandResult, result)
}

func (c *Client) executeScript(cmd ipc.IPCCommand) ipc.IPCCommandResult {
	var payload map[string]any
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     "invalid payload",
		}
	}

	exec := executor.New(nil)
	script := executor.ScriptExecution{
		ID:         cmd.CommandID,
		ScriptType: getStringOrDefault(payload, "language", "bash"),
		Script:     getStringOrDefault(payload, "content", ""),
		Timeout:    getIntOrDefault(payload, "timeoutSeconds", 300),
	}

	result, err := exec.Execute(script)
	if err != nil && result == nil {
		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     err.Error(),
		}
	}

	status := "completed"
	if result.ExitCode != 0 {
		status = "failed"
	}

	resultJSON, _ := json.Marshal(map[string]any{
		"exitCode": result.ExitCode,
		"stdout":   result.Stdout,
		"stderr":   result.Stderr,
	})

	return ipc.IPCCommandResult{
		CommandID: cmd.CommandID,
		Status:    status,
		Result:    resultJSON,
		Error:     result.Error,
	}
}

func (c *Client) handleNotify(env *ipc.Envelope) {
	var req ipc.NotifyRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid notify payload", "error", err)
		return
	}

	delivered := showNotification(req)
	c.conn.SendTyped(env.ID, ipc.TypeNotifyResult, ipc.NotifyResult{
		Delivered: delivered,
	})
}

func (c *Client) handleTrayUpdate(env *ipc.Envelope) {
	var update ipc.TrayUpdate
	if err := json.Unmarshal(env.Payload, &update); err != nil {
		log.Warn("invalid tray update payload", "error", err)
		return
	}
	updateTray(update)
}

func (c *Client) handleDesktopStart(env *ipc.Envelope) {
	// Phase 4: Desktop capture delegation
	log.Debug("desktop_start received (not yet implemented)")
}

func (c *Client) handleDesktopStop(env *ipc.Envelope) {
	log.Debug("desktop_stop received (not yet implemented)")
}

func (c *Client) handleDesktopInput(env *ipc.Envelope) {
	log.Debug("desktop_input received (not yet implemented)")
}

func (c *Client) handleClipboardGet(env *ipc.Envelope) {
	// Phase 4: Clipboard delegation
	log.Debug("clipboard_get received (not yet implemented)")
}

func (c *Client) handleClipboardSet(env *ipc.Envelope) {
	log.Debug("clipboard_set received (not yet implemented)")
}

func computeSelfHash() (string, error) {
	exePath, err := os.Executable()
	if err != nil {
		return "", err
	}
	exePath, err = filepath.EvalSymlinks(exePath)
	if err != nil {
		return "", err
	}
	data, err := os.ReadFile(exePath)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

func detectDisplayEnv() string {
	if runtime.GOOS == "darwin" {
		return "quartz"
	}
	if display := os.Getenv("WAYLAND_DISPLAY"); display != "" {
		return "wayland:" + display
	}
	if display := os.Getenv("DISPLAY"); display != "" {
		return "x11:" + display
	}
	return ""
}

func detectCapabilities() ipc.Capabilities {
	display := detectDisplayEnv()
	hasDisplay := display != ""
	return ipc.Capabilities{
		CanNotify:     hasDisplay,
		CanTray:       hasDisplay,
		CanCapture:    hasDisplay,
		CanClipboard:  hasDisplay,
		DisplayServer: display,
	}
}

func isTimeout(err error) bool {
	if netErr, ok := err.(net.Error); ok {
		return netErr.Timeout()
	}
	return false
}

func getStringOrDefault(m map[string]any, key, def string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return def
}

func getIntOrDefault(m map[string]any, key string, def int) int {
	if v, ok := m[key].(float64); ok {
		return int(v)
	}
	return def
}
