package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Endpoint live chat commands (#8743 W03). Technician-initiated, Windows
// console Assist helper only. There is NO native fallback: without a
// chat-capable Assist helper the command fails with chat_requires_assist.
const (
	CmdChatOpen    = "chat_open"
	CmdChatMessage = "chat_message"
	CmdChatClose   = "chat_close"
)

// Error codes the API maps onto the conversation (contract section 1).
const (
	chatErrRequiresAssist = "chat_requires_assist"
	chatErrWindowFailed   = "chat_window_failed"
	chatErrInvalidPayload = "chat_invalid_payload"
)

// var so tests can shorten it.
var chatHelperTimeout = 10 * time.Second

// Defence in depth: the API validates these limits; the agent refuses a
// payload outside them rather than forwarding it to a helper.
const (
	chatBodyMax       = 2000
	chatSenderNameMax = 120
	chatBrandNameMax  = 120
)

var chatAccentRE = regexp.MustCompile(`^#[0-9a-fA-F]{6}$`)

var chatCloseReasons = map[string]bool{"technician": true, "idle": true, "device_moved": true}

func init() {
	handlerRegistry[CmdChatOpen] = handleChatOpen
	handlerRegistry[CmdChatMessage] = handleChatMessage
	handlerRegistry[CmdChatClose] = handleChatClose
}

// canonicalUUID returns the lower-case hyphenated form of s, or false when s
// is not exactly a hyphenated UUID.
func canonicalUUID(s string) (string, bool) {
	id, err := uuid.Parse(s)
	if err != nil || !strings.EqualFold(id.String(), s) {
		return "", false
	}
	return id.String(), true
}

// isChatAssistSession is the single predicate for "this helper may show a
// chat": a messaging Assist helper in the Windows console session that also
// advertised chat support.
func (h *Heartbeat) isChatAssistSession(s *sessionbroker.Session) bool {
	return h.isMessagingAssistSession(s) && s.HasScope(ipc.ScopeChat)
}

func (h *Heartbeat) chatAssistSession() *sessionbroker.Session {
	if h.sessionBroker == nil {
		return nil
	}
	return h.sessionBroker.PreferredSessionWithScopeMatching(ipc.ScopeChat, h.isChatAssistSession)
}

// chatShowFromPayload validates a chat_open / chat_message payload and builds
// the ChatShow carrying just the new technician message.
func chatShowFromPayload(p map[string]any) (ipc.ChatShow, error) {
	var show ipc.ChatShow
	convID, ok := canonicalUUID(tools.GetPayloadString(p, "conversationId", ""))
	if !ok {
		return show, errors.New("conversationId must be a UUID")
	}
	b, ok := p["branding"].(map[string]any)
	if !ok {
		return show, errors.New("branding is required")
	}
	branding := ipc.MessageBranding{
		CompanyName: tools.GetPayloadString(b, "companyName", ""),
		DisplayName: tools.GetPayloadString(b, "displayName", ""),
		Accent:      tools.GetPayloadString(b, "accent", ""),
	}
	if n := utf8.RuneCountInString(strings.TrimSpace(branding.CompanyName)); n < 1 || n > chatBrandNameMax {
		return show, errors.New("branding companyName is out of bounds")
	}
	if utf8.RuneCountInString(branding.DisplayName) > chatBrandNameMax {
		return show, errors.New("branding displayName is out of bounds")
	}
	if branding.Accent != "" && !chatAccentRE.MatchString(branding.Accent) {
		return show, errors.New("branding accent is invalid")
	}
	m, ok := p["message"].(map[string]any)
	if !ok {
		return show, errors.New("message is required")
	}
	msgID, ok := canonicalUUID(tools.GetPayloadString(m, "messageId", ""))
	if !ok {
		return show, errors.New("messageId must be a UUID")
	}
	body := strings.TrimSpace(tools.GetPayloadString(m, "body", ""))
	if n := utf8.RuneCountInString(body); n < 1 || n > chatBodyMax {
		return show, errors.New("message body is out of bounds")
	}
	sender := strings.TrimSpace(tools.GetPayloadString(m, "senderName", ""))
	if n := utf8.RuneCountInString(sender); n < 1 || n > chatSenderNameMax {
		return show, errors.New("message senderName is out of bounds")
	}
	sentAt := tools.GetPayloadString(m, "sentAt", "")
	if _, err := time.Parse(time.RFC3339, sentAt); err != nil {
		return show, errors.New("message sentAt is invalid")
	}
	return ipc.ChatShow{
		ConversationID: convID,
		// Fail closed: a missing flag means no user replies.
		AllowReply: tools.GetPayloadBool(p, "allowUserReply", false),
		Branding:   branding,
		Messages: []ipc.ChatMessage{{
			MessageID:  msgID,
			Direction:  ipc.ChatDirectionToUser,
			Body:       body,
			SenderName: sender,
			SentAt:     sentAt,
		}},
	}, nil
}

func chatFail(start time.Time, code string) tools.CommandResult {
	return tools.CommandResult{Status: "failed", Error: code, DurationMs: time.Since(start).Milliseconds()}
}

func chatDeliveredResult(start time.Time, s *sessionbroker.Session, duplicate bool) tools.CommandResult {
	out := map[string]any{"delivered": true, "surface": "assist"}
	if s != nil {
		ev := messageEventSessionFor(s)
		out["username"] = ev.Username
		if ev.SID != "" {
			out["sid"] = ev.SID
		}
		if ev.WinSessionID != nil {
			out["winSessionId"] = *ev.WinSessionID
		}
	}
	if duplicate {
		out["duplicate"] = true
	}
	return tools.NewSuccessResult(out, time.Since(start).Milliseconds())
}

func handleChatOpen(h *Heartbeat, cmd Command) tools.CommandResult {
	return h.deliverChatMessage(cmd, ipc.TypeChatOpen)
}

func handleChatMessage(h *Heartbeat, cmd Command) tools.CommandResult {
	return h.deliverChatMessage(cmd, ipc.TypeChatMessage)
}

// deliverChatMessage upserts the conversation and shows one technician
// message through the chat-capable Assist helper. The message is recorded as
// delivered only after the helper confirmed it, so a retry after a failure
// really sends again.
func (h *Heartbeat) deliverChatMessage(cmd Command, ipcType string) tools.CommandResult {
	start := time.Now()
	show, err := chatShowFromPayload(cmd.Payload)
	if err != nil {
		log.Warn("rejected invalid chat payload", "command", cmd.Type, "reason", err.Error())
		return chatFail(start, chatErrInvalidPayload)
	}
	if h.sessionBroker == nil {
		return chatFail(start, chatErrRequiresAssist)
	}
	store := h.endpointChatStore()
	msg := show.Messages[0]

	session := h.chatAssistSession()
	if store.isDelivered(show.ConversationID, msg.MessageID) {
		return chatDeliveredResult(start, session, true)
	}
	if session == nil {
		return chatFail(start, chatErrRequiresAssist)
	}
	if store.upsert(show) {
		// Closed conversations are never reopened.
		log.Warn("chat message for a closed conversation not delivered", "conversationId", show.ConversationID)
		return chatFail(start, chatErrWindowFailed)
	}

	unlock := store.lockSend(show.ConversationID)
	defer unlock()
	// A duplicate may have completed while we waited for the lock.
	if store.isDelivered(show.ConversationID, msg.MessageID) {
		return chatDeliveredResult(start, session, true)
	}

	resp, err := h.sessionBroker.SendCommandAndWait(session, "chat-"+cmd.ID, ipcType, show, chatHelperTimeout)
	var presented ipc.ChatPresented
	switch {
	case err != nil:
		log.Warn("assist helper did not present the chat", "error", err.Error())
	case resp == nil || resp.Error != "":
		log.Warn("assist helper refused the chat", "error", respError(resp))
	case json.Unmarshal(resp.Payload, &presented) != nil:
		log.Warn("assist helper sent an unreadable chat_presented")
	case presented.Status != "":
		log.Warn("assist helper could not present the chat", "status", presented.Status)
	case presented.ConversationID != "" && !strings.EqualFold(presented.ConversationID, show.ConversationID):
		log.Warn("assist helper answered for a different conversation")
	default:
		store.appendMessage(show.ConversationID, msg)
		return chatDeliveredResult(start, session, false)
	}
	return chatFail(start, chatErrWindowFailed)
}

// handleChatClose ends a conversation. Idempotent: an unknown conversation or a
// missing helper is still a success.
func handleChatClose(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()
	convID, ok := canonicalUUID(tools.GetPayloadString(cmd.Payload, "conversationId", ""))
	reason := tools.GetPayloadString(cmd.Payload, "reason", "")
	if !ok || !chatCloseReasons[reason] {
		return chatFail(start, chatErrInvalidPayload)
	}
	h.endpointChatStore().markClosed(convID)
	if s := h.chatAssistSession(); s != nil {
		if err := s.SendNotify("chat-close-"+cmd.ID, ipc.TypeChatClose, ipc.ChatClose{ConversationID: convID, Reason: reason}); err != nil {
			log.Warn("could not tell the assist helper a chat closed", "conversationId", convID, "error", fmt.Sprint(err))
		}
	}
	return tools.NewSuccessResult(map[string]any{"closed": true}, time.Since(start).Milliseconds())
}
