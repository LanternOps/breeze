package userhelper

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"net"
	"os"
	osexec "os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/helper"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

var log = logging.L("userhelper")

const (
	maxLaunchBinaryPathBytes = 4096
	maxLaunchArgs            = 32
	maxLaunchArgBytes        = 4096
)

// Client is the user-helper side of the IPC connection to the root daemon.
type Client struct {
	socketPath string
	role       string // "system" or "user"
	binaryKind string
	context    string
	conn       *ipc.Conn
	sessionKey []byte
	agentID    string
	scopes     []string
	stopChan   chan struct{}
	desktopMgr *helperDesktopManager
	executor   *executor.Executor
	pendingMu  sync.Mutex
	pending    map[string]chan *ipc.Envelope
	sasReqSeq  atomic.Uint64
}

// New creates a new user helper client with the given role.
// Role should be ipc.HelperRoleSystem or ipc.HelperRoleUser.
func New(socketPath, role string) *Client {
	return NewWithOptions(socketPath, role, "", "")
}

func NewWithOptions(socketPath, role, binaryKind, context string) *Client {
	if role == "" {
		role = ipc.HelperRoleSystem
	}
	if binaryKind == "" {
		binaryKind = ipc.HelperBinaryUserHelper
	}
	return &Client{
		socketPath: socketPath,
		role:       role,
		binaryKind: binaryKind,
		context:    context,
		stopChan:   make(chan struct{}),
		desktopMgr: newHelperDesktopManager(context),
		executor:   executor.New(nil),
		pending:    make(map[string]chan *ipc.Envelope),
	}
}

// Run connects to the root daemon, authenticates, and enters the command loop.
// Blocks until stopChan is closed or the connection drops.
func (c *Client) Run() error {
	if err := c.connect(); err != nil {
		return fmt.Errorf("connect: %w", err)
	}
	defer c.conn.Close()
	defer c.desktopMgr.stopAll() // Release DXGI/COM handles on any exit path

	if err := c.authenticate(); err != nil {
		return fmt.Errorf("authenticate: %w", err)
	}

	if err := c.sendCapabilities(); err != nil {
		log.Warn("failed to send capabilities", "error", err)
	}

	// Set SAS callback: route through IPC to the SCM service which can call SendSAS
	c.desktopMgr.mgr.OnSASRequest = func() error {
		return c.requestSASViaIPC()
	}

	// Notify the service when a WebRTC peer connection drops so it can relay
	// the disconnect to the API and allow the viewer to reconnect.
	c.desktopMgr.mgr.OnSessionStopped = func(sessionID string) {
		notice := ipc.DesktopPeerDisconnectedNotice{SessionID: sessionID}
		if err := c.conn.SendTyped("desk-disc-"+sessionID, ipc.TypeDesktopPeerDisconnected, notice); err != nil {
			log.Warn("failed to send desktop peer disconnect via IPC", "session", sessionID, "error", err)
		}
	}

	// Start TCC permission check loop (macOS only; no-op on other platforms).
	// Skip capture probes while a live session is active to avoid contending
	// with the streaming capturer in the same helper process.
	safeGo("tcc_check", func() {
		RunTCCCheckLoop(c.conn, c.stopChan, c.context, func() bool {
			return !c.desktopMgr.hasActiveSessions()
		})
	})

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
	if c.desktopMgr != nil {
		c.desktopMgr.stopAll()
	}
	if c.conn != nil {
		c.conn.SendTyped("disconnect", ipc.TypeDisconnect, nil)
		c.conn.Close()
	}
}

func (c *Client) connect() error {
	conn, err := c.dialIPC()
	if err != nil {
		return err
	}
	c.conn = ipc.NewConn(conn)
	return nil
}

// dialIPC is implemented in client_windows.go and client_unix.go.

func (c *Client) authenticate() error {
	cu, err := user.Current()
	if err != nil {
		return fmt.Errorf("get current user: %w", err)
	}

	uid, err := strconv.ParseUint(cu.Uid, 10, 32)
	var sid string
	if err != nil {
		// On Windows, cu.Uid is the SID string (e.g., "S-1-5-21-...")
		uid = 0
		sid = cu.Uid
	}

	binaryHash, _ := computeSelfHash()
	displayEnv := detectDisplayEnv()
	sessionID := fmt.Sprintf("helper-%s-%d", cu.Username, os.Getpid())

	authReq := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             uint32(uid),
		SID:             sid,
		Username:        cu.Username,
		SessionID:       sessionID,
		DisplayEnv:      displayEnv,
		PID:             os.Getpid(),
		BinaryHash:      binaryHash,
		WinSessionID:    currentWinSessionID(),
		HelperRole:      c.role,
		BinaryKind:      c.binaryKind,
		DesktopContext:  c.context,
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
	caps := detectCapabilities(c.binaryKind, c.context)
	// On Windows, user-role helpers cannot capture desktop (no SYSTEM token
	// for UAC/lock screen). On macOS, the user-role helper is the only process
	// that CAN capture — the root daemon lacks GUI session access.
	if c.role == ipc.HelperRoleUser && runtime.GOOS == "windows" {
		caps.CanCapture = false
	}
	return c.conn.SendTyped("caps", ipc.TypeCapabilities, caps)
}

func (c *Client) hasScope(scope string) bool {
	for _, allowed := range c.scopes {
		if allowed == scope || allowed == "*" {
			return true
		}
	}
	return false
}

func (c *Client) authorizeCommand(cmdType string) error {
	switch cmdType {
	case tools.CmdScript, tools.CmdRunScript, tools.CmdScriptCancel, tools.CmdScriptListRunning, "exec":
		if !c.hasScope("run_as_user") {
			return fmt.Errorf("command %s requires run_as_user scope", cmdType)
		}
	case tools.CmdTakeScreenshot, tools.CmdComputerAction:
		if c.hasScope("desktop") {
			return nil
		}
		if runtime.GOOS == "darwin" && c.hasScope("run_as_user") {
			return nil
		}
		return fmt.Errorf("command %s requires desktop scope", cmdType)
	default:
		return fmt.Errorf("unsupported command type: %s", cmdType)
	}
	return nil
}

func (c *Client) commandLoop() error {
	defer c.closePendingResponses()

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
				if pingErr := c.conn.SendTyped("ping", ipc.TypePing, nil); pingErr != nil {
					return fmt.Errorf("keepalive ping failed: %w", pingErr)
				}
				continue
			}
			return fmt.Errorf("recv: %w", err)
		}

		switch env.Type {
		case ipc.TypePing:
			if err := c.conn.SendTyped(env.ID, ipc.TypePong, nil); err != nil {
				return fmt.Errorf("pong send failed: %w", err)
			}

		case ipc.TypePong:
			// Response to our keepalive ping — no action needed

		case ipc.TypeCommand:
			safeGo("command", func() { c.handleCommand(env) })

		case ipc.TypeNotify:
			safeGo("notify", func() { c.handleNotify(env) })

		case ipc.TypeTrayUpdate:
			safeGo("tray_update", func() { c.handleTrayUpdate(env) })

		case ipc.TypeDesktopStart:
			safeGo("desktop_start", func() { c.handleDesktopStart(env) })

		case ipc.TypeDesktopStop:
			safeGo("desktop_stop", func() { c.handleDesktopStop(env) })

		case ipc.TypeDesktopInput:
			safeGo("desktop_input", func() { c.handleDesktopInput(env) })

		case ipc.TypeConsoleUserChanged:
			safeGo("console_user_changed", func() { c.handleConsoleUserChanged(env) })

		case ipc.TypeClipboardGet:
			safeGo("clipboard_get", func() { c.handleClipboardGet(env) })

		case ipc.TypeClipboardSet:
			safeGo("clipboard_set", func() { c.handleClipboardSet(env) })

		case ipc.TypeLaunchProcess:
			safeGo("launch_process", func() { c.handleLaunchProcess(env) })

		case ipc.TypeSASResponse:
			if !c.resolvePendingResponse(env) {
				log.Warn("unsolicited sas_response from daemon", "id", env.ID)
			}

		case ipc.TypeDisconnect:
			log.Info("disconnect received from daemon")
			return nil

		default:
			log.Warn("unknown message type", "type", env.Type)
		}
	}
}

func (c *Client) registerPendingResponse(id string) chan *ipc.Envelope {
	ch := make(chan *ipc.Envelope, 1)
	c.pendingMu.Lock()
	c.pending[id] = ch
	c.pendingMu.Unlock()
	return ch
}

func (c *Client) unregisterPendingResponse(id string) {
	var ch chan *ipc.Envelope
	c.pendingMu.Lock()
	ch = c.pending[id]
	delete(c.pending, id)
	c.pendingMu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func (c *Client) resolvePendingResponse(env *ipc.Envelope) bool {
	var ch chan *ipc.Envelope
	c.pendingMu.Lock()
	ch = c.pending[env.ID]
	if ch != nil {
		delete(c.pending, env.ID)
	}
	c.pendingMu.Unlock()
	if ch == nil {
		return false
	}
	select {
	case ch <- env:
	default:
		log.Warn("pending response channel full, dropping", "id", env.ID)
	}
	close(ch)
	return true
}

func (c *Client) closePendingResponses() {
	c.pendingMu.Lock()
	chans := make([]chan *ipc.Envelope, 0, len(c.pending))
	for id, ch := range c.pending {
		delete(c.pending, id)
		chans = append(chans, ch)
	}
	c.pendingMu.Unlock()
	for _, ch := range chans {
		close(ch)
	}
}

// safeGo runs fn in a goroutine with panic recovery. If fn panics, the panic
// is logged with a stack trace instead of crashing the entire helper process.
// This prevents Windows API / COM / DXGI panics from killing the IPC pipe and
// leaving GPU resources locked.
func safeGo(name string, fn func()) {
	go func() {
		defer func() {
			if r := recover(); r != nil {
				buf := make([]byte, 4096)
				n := runtime.Stack(buf, false)
				log.Error("recovered panic in handler",
					"handler", name,
					"panic", fmt.Sprintf("%v", r),
					"stack", string(buf[:n]),
				)
			}
		}()
		fn()
	}()
}

func (c *Client) handleCommand(env *ipc.Envelope) {
	var cmd ipc.IPCCommand
	if err := json.Unmarshal(env.Payload, &cmd); err != nil {
		if sendErr := c.conn.SendTyped(env.ID, ipc.TypeCommandResult, ipc.IPCCommandResult{
			CommandID: env.ID,
			Status:    "failed",
			Error:     fmt.Sprintf("invalid command payload: %v", err),
		}); sendErr != nil {
			log.Warn("failed to send command error response", "id", env.ID, "error", sendErr)
		}
		return
	}

	if err := c.authorizeCommand(cmd.Type); err != nil {
		if sendErr := c.conn.SendTyped(env.ID, ipc.TypeCommandResult, ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     err.Error(),
		}); sendErr != nil {
			log.Warn("failed to send unauthorized command response", "id", env.ID, "error", sendErr)
		}
		return
	}

	// Dispatch based on command type. Screenshot/computer_action need to run
	// in the user session (this process) since the service runs in Session 0
	// and has no display for DXGI/GDI/SendInput.
	var result ipc.IPCCommandResult
	switch cmd.Type {
	case tools.CmdTakeScreenshot, tools.CmdComputerAction:
		result = c.executeToolCommand(cmd)
	case "exec":
		result = c.executeProcess(cmd)
	case tools.CmdScript, tools.CmdRunScript, tools.CmdScriptCancel, tools.CmdScriptListRunning:
		result = c.executeScript(cmd)
	default:
		result = ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     fmt.Sprintf("unsupported command type: %s", cmd.Type),
		}
	}
	if err := c.conn.SendTyped(env.ID, ipc.TypeCommandResult, result); err != nil {
		log.Warn("failed to send command result", "id", env.ID, "error", err)
	}
}

func (c *Client) handleLaunchProcess(env *ipc.Envelope) {
	var req ipc.LaunchProcessRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		c.conn.SendTyped(env.ID, ipc.TypeLaunchResult, ipc.LaunchProcessResult{
			Error: fmt.Sprintf("invalid payload: %v", err),
		})
		return
	}

	if err := validateLaunchProcessRequest(&req); err != nil {
		c.conn.SendTyped(env.ID, ipc.TypeLaunchResult, ipc.LaunchProcessResult{
			Error: err.Error(),
		})
		return
	}
	if !c.hasScope("run_as_user") {
		c.conn.SendTyped(env.ID, ipc.TypeLaunchResult, ipc.LaunchProcessResult{
			Error: "launch_process requires run_as_user scope",
		})
		return
	}

	// Security: only allow launching the agent's own binary (e.g., Breeze Helper).
	// Prevents arbitrary code execution if the IPC channel is compromised.
	selfPath, err := os.Executable()
	if err == nil {
		if !isAllowedLaunchBinary(selfPath, req.BinaryPath) {
			log.Warn("launch_process rejected: binary not in agent directory",
				"requested", req.BinaryPath, "agentDir", filepath.Dir(filepath.Clean(selfPath)))
			c.conn.SendTyped(env.ID, ipc.TypeLaunchResult, ipc.LaunchProcessResult{
				Error: "binary path not in allowed launch directory",
			})
			return
		}
	}

	cmd := osexec.Command(req.BinaryPath, req.Args...)
	cmd.Dir = filepath.Dir(req.BinaryPath)
	if err := cmd.Start(); err != nil {
		log.Warn("failed to launch process", "binary", req.BinaryPath, "args", req.Args, "error", err.Error())
		c.conn.SendTyped(env.ID, ipc.TypeLaunchResult, ipc.LaunchProcessResult{
			Error: err.Error(),
		})
		return
	}

	log.Info("launched process as user", "binary", req.BinaryPath, "args", req.Args, "pid", cmd.Process.Pid)
	c.conn.SendTyped(env.ID, ipc.TypeLaunchResult, ipc.LaunchProcessResult{
		OK:  true,
		PID: cmd.Process.Pid,
	})

	// Don't wait for the process — release it so it runs independently.
	cmd.Process.Release()
}

func validateLaunchProcessRequest(req *ipc.LaunchProcessRequest) error {
	req.BinaryPath = strings.TrimSpace(req.BinaryPath)
	if req.BinaryPath == "" {
		return fmt.Errorf("binaryPath is required")
	}
	if len(req.BinaryPath) > maxLaunchBinaryPathBytes {
		return fmt.Errorf("binaryPath too large")
	}
	if containsControlChar(req.BinaryPath) {
		return fmt.Errorf("binaryPath contains invalid control characters")
	}
	if len(req.Args) > maxLaunchArgs {
		return fmt.Errorf("too many launch arguments")
	}
	for i := range req.Args {
		req.Args[i] = strings.TrimSpace(req.Args[i])
		if len(req.Args[i]) > maxLaunchArgBytes {
			return fmt.Errorf("launch argument too large")
		}
		if containsControlChar(req.Args[i]) {
			return fmt.Errorf("launch argument contains invalid control characters")
		}
	}
	return nil
}

func containsControlChar(value string) bool {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return true
		}
	}
	return false
}

func isAllowedLaunchBinary(selfPath, requestedPath string) bool {
	candidateDir := filepath.Dir(resolveLaunchPath(requestedPath))
	allowedDirs := []string{
		filepath.Dir(resolveLaunchPath(selfPath)),
		filepath.Dir(resolveLaunchPath(helper.DefaultBinaryPath())),
	}
	for _, dir := range allowedDirs {
		if candidateDir == dir {
			return true
		}
	}
	return false
}

func resolveLaunchPath(path string) string {
	resolved, err := filepath.EvalSymlinks(path)
	if err == nil {
		return filepath.Clean(resolved)
	}
	return filepath.Clean(path)
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

	switch cmd.Type {
	case tools.CmdScriptCancel:
		executionID := getStringOrDefault(payload, "executionId", "")
		if executionID == "" {
			return ipc.IPCCommandResult{
				CommandID: cmd.CommandID,
				Status:    "failed",
				Error:     "executionId is required",
			}
		}

		if err := c.executor.Cancel(executionID); err != nil {
			return ipc.IPCCommandResult{
				CommandID: cmd.CommandID,
				Status:    "failed",
				Error:     err.Error(),
			}
		}

		resultJSON, err := json.Marshal(map[string]any{
			"executionId": executionID,
			"cancelled":   true,
		})
		if err != nil {
			return ipc.IPCCommandResult{
				CommandID: cmd.CommandID,
				Status:    "failed",
				Error:     fmt.Sprintf("marshal result: %v", err),
			}
		}

		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "completed",
			Result:    resultJSON,
		}

	case tools.CmdScriptListRunning:
		running := c.executor.ListRunning()
		resultJSON, err := json.Marshal(map[string]any{
			"running": running,
			"count":   len(running),
		})
		if err != nil {
			return ipc.IPCCommandResult{
				CommandID: cmd.CommandID,
				Status:    "failed",
				Error:     fmt.Sprintf("marshal result: %v", err),
			}
		}

		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "completed",
			Result:    resultJSON,
		}
	}

	script := executor.ScriptExecution{
		ID:         cmd.CommandID,
		ScriptType: getStringOrDefault(payload, "language", "bash"),
		Script:     getStringOrDefault(payload, "content", ""),
		Timeout:    getIntOrDefault(payload, "timeoutSeconds", 300),
	}

	result, err := c.executor.Execute(script)
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

	resultJSON, err := json.Marshal(map[string]any{
		"exitCode": result.ExitCode,
		"stdout":   executor.SanitizeOutput(result.Stdout),
		"stderr":   executor.SanitizeOutput(result.Stderr),
	})
	if err != nil {
		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     fmt.Sprintf("marshal result: %v", err),
		}
	}

	return ipc.IPCCommandResult{
		CommandID: cmd.CommandID,
		Status:    status,
		Result:    resultJSON,
		Error:     result.Error,
	}
}

// executeProcess runs a direct command+args in user context (e.g. winget).
// Unlike executeScript, this does not go through the script executor — it runs
// the named binary directly and returns stdout/stderr/exitCode.
func (c *Client) executeProcess(cmd ipc.IPCCommand) ipc.IPCCommandResult {
	var payload map[string]any
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: "failed", Error: "invalid payload"}
	}

	name := getStringOrDefault(payload, "command", "")
	if name == "" {
		return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: "failed", Error: "command is required"}
	}

	var args []string
	if raw, ok := payload["args"].([]any); ok {
		for _, a := range raw {
			if s, ok := a.(string); ok {
				args = append(args, s)
			}
		}
	}

	timeoutSec := getIntOrDefault(payload, "timeoutSeconds", 300)
	proc := osexec.Command(name, args...)

	var stdout, stderr bytes.Buffer
	proc.Stdout = &stdout
	proc.Stderr = &stderr

	done := make(chan error, 1)
	if err := proc.Start(); err != nil {
		return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: "failed", Error: fmt.Sprintf("start: %v", err)}
	}
	go func() { done <- proc.Wait() }()

	select {
	case err := <-done:
		exitCode := 0
		if err != nil {
			if exitErr, ok := err.(*osexec.ExitError); ok {
				exitCode = exitErr.ExitCode()
			} else {
				return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: "failed", Error: fmt.Sprintf("wait: %v", err)}
			}
		}
		resultJSON, err := json.Marshal(map[string]any{
			"exitCode": exitCode,
			"stdout":   executor.SanitizeOutput(stdout.String()),
			"stderr":   executor.SanitizeOutput(stderr.String()),
		})
		if err != nil {
			return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: "failed", Error: fmt.Sprintf("marshal result: %v", err)}
		}
		status := "completed"
		if exitCode != 0 {
			status = "failed"
		}
		return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: status, Result: resultJSON}
	case <-time.After(time.Duration(timeoutSec) * time.Second):
		if err := proc.Process.Kill(); err != nil {
			log.Warn("failed to kill timed-out process", "command", name, "error", err.Error())
		}
		<-done // reap the process
		return ipc.IPCCommandResult{CommandID: cmd.CommandID, Status: "failed", Error: fmt.Sprintf("timeout after %ds", timeoutSec)}
	}
}

// executeToolCommand runs screenshot/computer_action in the user session.
// These commands require a display (DXGI/GDI) and input APIs (SendInput)
// that are only available in user sessions, not Session 0 (service).
//
// When a WebRTC desktop session is active, the capture function reuses the
// session's existing capturer instead of creating a standalone one. This
// prevents the standalone capturer's Close() from destroying shared global
// capture state (DXGI duplication on Windows, ScreenCaptureKit filter on
// macOS), which would kill the viewer's stream.
func (c *Client) executeToolCommand(cmd ipc.IPCCommand) ipc.IPCCommandResult {
	var payload map[string]any
	if err := json.Unmarshal(cmd.Payload, &payload); err != nil {
		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     "invalid payload",
		}
	}

	// Build a CaptureFunc that borrows the active WebRTC session's capturer.
	// Returns an error (triggering fallback) if no session is active.
	capFn := func(displayIndex int) (*image.RGBA, int, int, error) {
		return c.desktopMgr.captureScreenshot(displayIndex)
	}

	var toolResult tools.CommandResult
	switch cmd.Type {
	case tools.CmdTakeScreenshot:
		toolResult = tools.TakeScreenshotWithCapture(payload, capFn)
	case tools.CmdComputerAction:
		toolResult = tools.ComputerActionWithCapture(payload, capFn)
	default:
		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     fmt.Sprintf("unsupported tool command: %s", cmd.Type),
		}
	}

	resultJSON, err := json.Marshal(toolResult)
	if err != nil {
		return ipc.IPCCommandResult{
			CommandID: cmd.CommandID,
			Status:    "failed",
			Error:     fmt.Sprintf("marshal tool result: %v", err),
		}
	}

	return ipc.IPCCommandResult{
		CommandID: cmd.CommandID,
		Status:    toolResult.Status,
		Result:    resultJSON,
		Error:     toolResult.Error,
	}
}

func (c *Client) handleNotify(env *ipc.Envelope) {
	var req ipc.NotifyRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid notify payload", "error", err)
		if sendErr := c.conn.SendError(env.ID, ipc.TypeNotifyResult, fmt.Sprintf("invalid payload: %v", err)); sendErr != nil {
			log.Warn("failed to send notify error", "error", sendErr)
		}
		return
	}

	delivered := showNotification(req)
	if err := c.conn.SendTyped(env.ID, ipc.TypeNotifyResult, ipc.NotifyResult{
		Delivered: delivered,
	}); err != nil {
		log.Warn("failed to send notify result", "id", env.ID, "error", err)
	}
}

func (c *Client) handleTrayUpdate(env *ipc.Envelope) {
	var update ipc.TrayUpdate
	if err := json.Unmarshal(env.Payload, &update); err != nil {
		log.Warn("invalid tray update payload", "error", err)
		return
	}
	updateTray(update)
	log.Debug("tray update applied", "status", update.Status)
}

func (c *Client) handleDesktopStart(env *ipc.Envelope) {
	var req ipc.DesktopStartRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid desktop_start payload", "error", err)
		if sendErr := c.conn.SendError(env.ID, ipc.TypeDesktopStart, fmt.Sprintf("invalid payload: %v", err)); sendErr != nil {
			log.Warn("failed to send desktop_start error", "error", sendErr)
		}
		return
	}
	if err := validateDesktopStartRequest(&req); err != nil {
		log.Warn("invalid desktop_start request", "error", err.Error())
		if sendErr := c.conn.SendError(env.ID, ipc.TypeDesktopStart, err.Error()); sendErr != nil {
			log.Warn("failed to send desktop_start error", "error", sendErr)
		}
		return
	}

	log.Info("starting desktop session via IPC",
		"sessionId", req.SessionID,
		"displayIndex", req.DisplayIndex,
	)

	resp, err := c.desktopMgr.startSession(&req)
	if err != nil {
		log.Warn("desktop session start failed", "sessionId", req.SessionID, "error", err.Error())
		if sendErr := c.conn.SendError(env.ID, ipc.TypeDesktopStart, err.Error()); sendErr != nil {
			log.Warn("failed to send desktop_start error", "error", sendErr)
		}
		return
	}

	if err := c.conn.SendTyped(env.ID, ipc.TypeDesktopStart, resp); err != nil {
		log.Warn("failed to send desktop_start response", "error", err)
		c.desktopMgr.stopSession(req.SessionID)
	}
}

func (c *Client) handleDesktopStop(env *ipc.Envelope) {
	var req ipc.DesktopStopRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid desktop_stop payload", "error", err)
		return
	}
	if err := validateDesktopStopRequest(&req); err != nil {
		log.Warn("invalid desktop_stop request", "error", err.Error())
		return
	}

	log.Info("stopping desktop session via IPC", "sessionId", req.SessionID)
	c.desktopMgr.stopSession(req.SessionID)

	// Reply to unblock SendCommand on the broker side
	if err := c.conn.SendTyped(env.ID, ipc.TypeDesktopStop, map[string]any{"stopped": true}); err != nil {
		log.Warn("failed to send desktop_stop response", "error", err)
	}
}

func (c *Client) handleDesktopInput(env *ipc.Envelope) {
	log.Debug("desktop_input received (not yet implemented)")
}

func (c *Client) handleConsoleUserChanged(env *ipc.Envelope) {
	var payload ipc.ConsoleUserChangedPayload
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		log.Warn("invalid console_user_changed payload", "error", err)
		return
	}
	atLoginWindow := payload.Username == "loginwindow"
	log.Info("console user changed, updating input mode",
		"username", payload.Username, "atLoginWindow", atLoginWindow)
	c.desktopMgr.setAtLoginWindow(atLoginWindow)
}

func (c *Client) handleClipboardGet(env *ipc.Envelope) {
	c.handleClipboardGetWithProvider(env, clipboard.NewSystemClipboard())
}

func (c *Client) handleClipboardSet(env *ipc.Envelope) {
	c.handleClipboardSetWithProvider(env, clipboard.NewSystemClipboard())
}

func (c *Client) handleClipboardGetWithProvider(env *ipc.Envelope, provider clipboard.Provider) {
	content, err := provider.GetContent()
	if err != nil {
		log.Warn("clipboard_get failed", "error", err.Error())
		if sendErr := c.conn.SendError(env.ID, ipc.TypeClipboardData, err.Error()); sendErr != nil {
			log.Warn("failed to send clipboard_get error", "error", sendErr)
		}
		return
	}
	if err := clipboard.ValidateContent(content); err != nil {
		log.Warn("clipboard_get rejected oversized content", "error", err.Error())
		if sendErr := c.conn.SendError(env.ID, ipc.TypeClipboardData, err.Error()); sendErr != nil {
			log.Warn("failed to send clipboard_get error", "error", sendErr)
		}
		return
	}

	payload := map[string]any{
		"type":        string(content.Type),
		"text":        content.Text,
		"rtf":         content.RTF,
		"image":       content.Image,
		"imageFormat": content.ImageFormat,
	}
	if err := c.conn.SendTyped(env.ID, ipc.TypeClipboardData, payload); err != nil {
		log.Warn("failed to send clipboard_get response", "error", err)
	}
}

func (c *Client) handleClipboardSetWithProvider(env *ipc.Envelope, provider clipboard.Provider) {
	var payload struct {
		Type        string `json:"type"`
		Text        string `json:"text,omitempty"`
		RTF         []byte `json:"rtf,omitempty"`
		Image       []byte `json:"image,omitempty"`
		ImageFormat string `json:"imageFormat,omitempty"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		log.Warn("invalid clipboard_set payload", "error", err)
		if sendErr := c.conn.SendError(env.ID, ipc.TypeClipboardSet, fmt.Sprintf("invalid payload: %v", err)); sendErr != nil {
			log.Warn("failed to send clipboard_set error", "error", sendErr)
		}
		return
	}

	content := clipboard.Content{
		Type:        clipboard.ContentType(payload.Type),
		Text:        payload.Text,
		RTF:         payload.RTF,
		Image:       payload.Image,
		ImageFormat: payload.ImageFormat,
	}
	if err := clipboard.ValidateContent(content); err != nil {
		log.Warn("clipboard_set rejected oversized content", "error", err.Error())
		if sendErr := c.conn.SendError(env.ID, ipc.TypeClipboardSet, err.Error()); sendErr != nil {
			log.Warn("failed to send clipboard_set error", "error", sendErr)
		}
		return
	}
	if err := provider.SetContent(content); err != nil {
		log.Warn("clipboard_set failed", "error", err.Error())
		if sendErr := c.conn.SendError(env.ID, ipc.TypeClipboardSet, err.Error()); sendErr != nil {
			log.Warn("failed to send clipboard_set error", "error", sendErr)
		}
		return
	}

	if err := c.conn.SendTyped(env.ID, ipc.TypeClipboardSet, map[string]any{"ok": true}); err != nil {
		log.Warn("failed to send clipboard_set response", "error", err)
	}
}

// requestSASViaIPC sends a sas_request to the service process via IPC.
// The service (SCM-registered) is the preferred process for SendSAS(FALSE).
// Route through IPC first for the most reliable SAS invocation.
func (c *Client) requestSASViaIPC() error {
	reqID := fmt.Sprintf("sas-%d", c.sasReqSeq.Add(1))
	respCh := c.registerPendingResponse(reqID)
	// defer unregister is safe even after resolvePendingResponse:
	// resolvePendingResponse deletes the entry from c.pending before closing
	// the channel, so unregisterPendingResponse will find nil and skip close.
	defer c.unregisterPendingResponse(reqID)

	req := ipc.SASRequest{
		WinSessionID: currentWinSessionID(),
	}
	if err := c.conn.SendTyped(reqID, ipc.TypeSASRequest, req); err != nil {
		return fmt.Errorf("IPC sas_request send failed: %w", err)
	}
	log.Info("SAS request sent to service via IPC", "id", reqID)

	select {
	case <-c.stopChan:
		return errors.New("IPC stopped while waiting for SAS response")
	case env, ok := <-respCh:
		if !ok || env == nil {
			return errors.New("IPC closed while waiting for SAS response")
		}
		if env.Error != "" {
			return fmt.Errorf("SAS response error: %s", env.Error)
		}
		var resp ipc.SASResponse
		if err := json.Unmarshal(env.Payload, &resp); err != nil {
			return fmt.Errorf("invalid SAS response payload: %w", err)
		}
		if !resp.OK {
			if resp.Error != "" {
				return errors.New(resp.Error)
			}
			return errors.New("SAS request rejected by service")
		}
		return nil
	case <-time.After(8 * time.Second):
		return errors.New("timed out waiting for SAS response from service")
	}
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
	file, err := os.Open(exePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	return hashReaderSHA256(file)
}

func hashReaderSHA256(r io.Reader) (string, error) {
	hasher := sha256.New()
	if _, err := io.Copy(hasher, r); err != nil {
		return "", err
	}
	return hex.EncodeToString(hasher.Sum(nil)), nil
}

func detectDisplayEnv() string {
	if runtime.GOOS == "windows" {
		return "windows"
	}
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

func detectCapabilities(binaryKind, desktopContext string) ipc.Capabilities {
	display := detectDisplayEnv()
	hasDisplay := display != ""

	caps := ipc.Capabilities{
		CanNotify:     hasDisplay,
		CanTray:       hasDisplay,
		CanCapture:    hasDisplay,
		CanClipboard:  hasDisplay && clipboardSupported(),
		DisplayServer: display,
	}

	if binaryKind == ipc.HelperBinaryDesktopHelper {
		caps.CanNotify = false
		caps.CanTray = false
		caps.CanClipboard = false
		if runtime.GOOS == "darwin" {
			granted, err := desktop.ProbeCaptureAccess(desktop.CaptureConfig{
				DesktopContext: desktopContext,
			})
			if err != nil {
				log.Warn("desktop helper capability probe failed",
					"context", desktopContext,
					"error", err.Error())
				caps.CanCapture = false
			} else {
				caps.CanCapture = granted
			}
		}
	}

	return caps
}

func isTimeout(err error) bool {
	var netErr net.Error
	if errors.As(err, &netErr) {
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
