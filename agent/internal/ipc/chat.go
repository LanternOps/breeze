package ipc

// Endpoint live chat (#8743 W03). Technician-initiated chat shown by the
// Assist helper in the Windows console session. New typ values and one new
// scope only — the envelope framing is unchanged.
const (
	// agent -> helper. chat_open / chat_message are correlated
	// (SendCommandAndWait) and answered by chat_presented on the same id.
	TypeChatOpen    = "chat_open"
	TypeChatMessage = "chat_message"
	// agent -> helper, fire-and-forget.
	TypeChatClose       = "chat_close"
	TypeChatReplyResult = "chat_reply_result"
	// helper -> agent. chat_reply is unsolicited; chat_presented answers
	// chat_open / chat_message (unsolicited after a replay).
	TypeChatReply     = "chat_reply"
	TypeChatPresented = "chat_presented"
)

// ScopeChat lets an Assist helper receive chat windows and send chat replies.
// Granted per session only when role == assist and the helper advertised
// AuthRequest.SupportsChat; a chat session must also hold ScopeMessaging and
// sit in the Windows console session.
const ScopeChat = "chat"

// Chat message directions.
const (
	ChatDirectionToUser   = "to_user"
	ChatDirectionFromUser = "from_user"
)

// ChatMessage is one transcript line.
type ChatMessage struct {
	MessageID  string `json:"messageId"`
	Direction  string `json:"direction"`
	Body       string `json:"body"`
	SenderName string `json:"senderName,omitempty"`
	SentAt     string `json:"sentAt"`
}

// ChatShow is the chat_open / chat_message payload. Live sends carry just the
// new technician message; a replay (Replay=true) carries the retained
// transcript and never shows a window.
type ChatShow struct {
	ConversationID string          `json:"conversationId"`
	AllowReply     bool            `json:"allowReply"`
	Branding       MessageBranding `json:"branding"`
	Messages       []ChatMessage   `json:"messages"`
	Replay         bool            `json:"replay"`
	Closed         bool            `json:"closed"`
}

// ChatClose tells the helper a conversation ended.
type ChatClose struct {
	ConversationID string `json:"conversationId"`
	Reason         string `json:"reason"`
}

// ChatReply is the helper's unsolicited end-user reply.
type ChatReply struct {
	ConversationID string `json:"conversationId"`
	ClientNonce    string `json:"clientNonce"`
	Body           string `json:"body"`
}

// ChatPresented is the helper's reply to chat_open / chat_message. Status is
// empty when the message is on screen (or stored, for a chat_message).
type ChatPresented struct {
	ConversationID string `json:"conversationId"`
	MessageID      string `json:"messageId,omitempty"`
	Status         string `json:"status"`
}

// ChatPresentedFailed is the ChatPresented.Status of a refused / undrawable chat.
const ChatPresentedFailed = "failed"

// ChatReplyResult tells the helper what happened to a chat_reply.
type ChatReplyResult struct {
	ConversationID string `json:"conversationId"`
	ClientNonce    string `json:"clientNonce"`
	Status         string `json:"status"`
}

// ChatReplyResult.Status values.
const (
	ChatReplySent     = "sent"
	ChatReplyFailed   = "failed"
	ChatReplyRejected = "rejected"
	ChatReplyClosed   = "closed"
)
