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
