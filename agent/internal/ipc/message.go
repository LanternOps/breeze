package ipc

import "encoding/json"

// Message type constants for IPC communication.
const (
	TypeAuthRequest  = "auth_request"
	TypeAuthResponse = "auth_response"
	TypeCommand      = "command"
	TypeCommandResult = "command_result"
	TypePing         = "ping"
	TypePong         = "pong"
	TypeCapabilities = "capabilities"
	TypeDisconnect   = "disconnect"

	// Phase 2: Notifications + Tray
	TypeNotify       = "notify"
	TypeNotifyResult = "notify_result"
	TypeTrayUpdate   = "tray_update"
	TypeTrayAction   = "tray_action"

	// Phase 4: Desktop + Clipboard
	TypeDesktopStart  = "desktop_start"
	TypeDesktopFrame  = "desktop_frame"
	TypeDesktopInput  = "desktop_input"
	TypeDesktopStop   = "desktop_stop"
	TypeClipboardGet  = "clipboard_get"
	TypeClipboardData = "clipboard_data"
	TypeClipboardSet  = "clipboard_set"

	// SAS (Secure Attention Sequence) — helper requests service to invoke SendSAS
	TypeSASRequest  = "sas_request"
	TypeSASResponse = "sas_response"
)

// MaxMessageSize is the maximum size of a JSON IPC message (16MB).
const MaxMessageSize = 16 * 1024 * 1024

// MaxBinaryFrameSize is the maximum size of a binary channel frame (4MB).
const MaxBinaryFrameSize = 4 * 1024 * 1024

// ProtocolVersion is the current IPC protocol version.
const ProtocolVersion = 1

// Envelope is the wire-format wrapper for all IPC messages.
type Envelope struct {
	ID      string          `json:"id"`
	Seq     uint64          `json:"seq"`
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
	Error   string          `json:"error,omitempty"`
	HMAC    string          `json:"hmac"`
}

// AuthRequest is sent by the user helper to the root daemon after connecting.
type AuthRequest struct {
	ProtocolVersion int    `json:"protocolVersion"`
	UID             uint32 `json:"uid"`
	SID             string `json:"sid,omitempty"` // Windows Security Identifier
	Username        string `json:"username"`
	SessionID       string `json:"sessionId"`
	DisplayEnv      string `json:"displayEnv"`
	PID             int    `json:"pid"`
	BinaryHash      string `json:"binaryHash"`
	WinSessionID    uint32 `json:"winSessionId,omitempty"` // Windows session ID (1, 2, etc.)
}

// AuthResponse is sent by the root daemon back to the user helper.
type AuthResponse struct {
	Accepted      bool     `json:"accepted"`
	SessionKey    string   `json:"sessionKey,omitempty"`
	AgentID       string   `json:"agentId,omitempty"`
	AllowedScopes []string `json:"allowedScopes,omitempty"`
	Reason        string   `json:"reason,omitempty"`
}

// Capabilities is sent by the user helper after successful auth.
type Capabilities struct {
	CanNotify     bool   `json:"canNotify"`
	CanTray       bool   `json:"canTray"`
	CanCapture    bool   `json:"canCapture"`
	CanClipboard  bool   `json:"canClipboard"`
	DisplayServer string `json:"displayServer"`
}

// IPCCommand is a command forwarded from root daemon to user helper.
type IPCCommand struct {
	CommandID string          `json:"commandId"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

// IPCCommandResult is the result from user helper back to root daemon.
type IPCCommandResult struct {
	CommandID string          `json:"commandId"`
	Status    string          `json:"status"`
	Result    json.RawMessage `json:"result,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// NotifyRequest asks the user helper to show a desktop notification.
type NotifyRequest struct {
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Icon    string   `json:"icon,omitempty"`
	Urgency string   `json:"urgency,omitempty"`
	Actions []string `json:"actions,omitempty"`
}

// NotifyResult is the user helper's response after showing a notification.
type NotifyResult struct {
	Delivered     bool   `json:"delivered"`
	ActionClicked string `json:"actionClicked,omitempty"`
}

// TrayUpdate tells the user helper to update the system tray icon/menu.
type TrayUpdate struct {
	Status    string     `json:"status"`
	Tooltip   string     `json:"tooltip"`
	MenuItems []MenuItem `json:"menuItems,omitempty"`
}

// MenuItem is an entry in the system tray menu.
type MenuItem struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Enabled bool   `json:"enabled"`
}

// TrayAction is sent by the user helper when a tray menu item is clicked.
type TrayAction struct {
	MenuItemID string `json:"menuItemId"`
}

// DesktopStartRequest is sent from the service to the user helper to start a
// remote desktop session. The helper creates the full WebRTC pipeline and
// returns an SDP answer.
type DesktopStartRequest struct {
	SessionID    string          `json:"sessionId"`
	Offer        string          `json:"offer"`
	ICEServers   json.RawMessage `json:"iceServers,omitempty"`
	DisplayIndex int             `json:"displayIndex"`
}

// DesktopStartResponse is returned by the user helper after creating the
// WebRTC peer connection.
type DesktopStartResponse struct {
	SessionID string `json:"sessionId"`
	Answer    string `json:"answer"`
}

// DesktopStopRequest tells the user helper to tear down a desktop session.
type DesktopStopRequest struct {
	SessionID string `json:"sessionId"`
}

// SASRequest is sent by the user helper to the service when it needs to
// trigger the Secure Attention Sequence (Ctrl+Alt+Del). The service is the
// SCM-registered process with the highest chance of SendSAS(FALSE) succeeding.
// The helper may also attempt it as a fallback.
type SASRequest struct {
	WinSessionID uint32 `json:"winSessionId,omitempty"`
}

// SASResponse is sent by the service back to the helper after invoking SAS.
type SASResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// SessionInfoItem describes one interactive Windows session for the
// list_sessions command response.
type SessionInfoItem struct {
	SessionID       uint32 `json:"sessionId"`
	Username        string `json:"username"`
	State           string `json:"state"`
	Type            string `json:"type"`
	HelperConnected bool   `json:"helperConnected"`
}
