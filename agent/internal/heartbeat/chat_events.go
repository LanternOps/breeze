package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// chatReplyEvent is the end-user reply posted to the API's message-events
// route (contract section 2). The session fields are agent-attested: they come
// from the broker's authenticated helper session, never from the helper payload.
type chatReplyEvent struct {
	EventType      string              `json:"eventType"`
	ConversationID string              `json:"conversationId"`
	ClientNonce    string              `json:"clientNonce"`
	Body           string              `json:"body"`
	Session        messageEventSession `json:"session"`
	At             string              `json:"at"`
}

// sendChatReplyResult tells the helper what became of a reply. Best effort.
func sendChatReplyResult(s *sessionbroker.Session, convID, nonce, status string) {
	id := fmt.Sprintf("chat-reply-result-%s-%d", nonce, time.Now().UnixNano())
	if err := s.SendNotify(id, ipc.TypeChatReplyResult, ipc.ChatReplyResult{ConversationID: convID, ClientNonce: nonce, Status: status}); err != nil {
		log.Warn("could not send chat reply result", "conversationId", convID, "status", status, "error", err.Error())
	}
}

// handleChatReplyFromHelper validates a helper's chat_reply and posts it. The
// body is never logged.
func (h *Heartbeat) handleChatReplyFromHelper(s *sessionbroker.Session, env *ipc.Envelope) {
	if !h.isChatAssistSession(s) {
		log.Warn("dropping chat reply from a session that cannot chat", "sessionId", s.SessionID)
		return
	}
	var req ipc.ChatReply
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid chat reply payload", "sessionId", s.SessionID)
		return
	}
	// reject drops the reply and, when the helper gave a usable nonce, says so
	// (a nonce is echoed back only if short enough to be one).
	reject := func(reason, status string) {
		log.Warn("dropping chat reply", "reason", reason, "conversationId", req.ConversationID)
		if req.ClientNonce != "" && len(req.ClientNonce) <= 64 && len(req.ConversationID) <= 64 {
			sendChatReplyResult(s, req.ConversationID, req.ClientNonce, status)
		}
	}
	convID, ok := canonicalUUID(req.ConversationID)
	if !ok {
		reject("invalid conversation id", ipc.ChatReplyRejected)
		return
	}
	nonce, ok := canonicalUUID(req.ClientNonce)
	if !ok {
		log.Warn("dropping chat reply", "reason", "invalid nonce", "conversationId", convID)
		return
	}
	body := strings.TrimSpace(req.Body)
	if n := utf8.RuneCountInString(body); n < 1 || n > chatBodyMax {
		reject("body out of bounds", ipc.ChatReplyRejected)
		return
	}
	store := h.endpointChatStore()
	snap, found := store.snapshot(convID)
	switch {
	case !found:
		reject("unknown conversation", ipc.ChatReplyRejected)
		return
	case snap.Closed:
		reject("conversation closed", ipc.ChatReplyClosed)
		return
	case !snap.AllowReply:
		reject("replies disabled", ipc.ChatReplyRejected)
		return
	}
	if s.Username == "" {
		// The API requires session.username; never post an unattested reply.
		reject("session has no username", ipc.ChatReplyRejected)
		return
	}
	claimed, prior := store.claimNonceState(convID, nonce)
	if !claimed {
		// A retry of a nonce that already finished (typically after a helper
		// reconnect) gets the recorded outcome again; an in-flight one gets its
		// result when the post completes.
		if status, ok := nonceOutcomeStatus(prior); ok {
			sendChatReplyResult(s, convID, nonce, status)
		}
		return
	}
	ev := chatReplyEvent{
		EventType:      "chat_reply",
		ConversationID: convID,
		ClientNonce:    nonce,
		Body:           body,
		Session:        messageEventSessionFor(s),
		At:             time.Now().UTC().Format(time.RFC3339),
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic posting chat reply", "error", fmt.Sprint(r))
				store.releaseNonce(convID, nonce)
				h.sendCurrentChatResult(convID, nonce, ipc.ChatReplyFailed)
			}
		}()
		h.finishChatReply(ev)
	}()
}

// nonceOutcomeStatus maps a terminal nonce outcome to its result status.
func nonceOutcomeStatus(outcome string) (string, bool) {
	switch outcome {
	case nonceSent:
		return ipc.ChatReplySent, true
	case nonceRejected:
		return ipc.ChatReplyRejected, true
	case nonceClosed:
		return ipc.ChatReplyClosed, true
	}
	return "", false
}

// sendCurrentChatResult delivers a result to the chat session that is current
// NOW (the one that posted may be gone after a helper reconnect). With no
// current session it is dropped; the helper's same-nonce retry is answered
// from the recorded outcome.
func (h *Heartbeat) sendCurrentChatResult(convID, nonce, status string) *sessionbroker.Session {
	cur := h.chatAssistSession()
	if cur == nil {
		log.Debug("no chat session to receive a reply result", "conversationId", convID, "status", status)
		return nil
	}
	sendChatReplyResult(cur, convID, nonce, status)
	return cur
}

// finishChatReply posts the reply and maps the outcome onto the helper's
// chat_reply_result and the local store.
//
//	200/201 -> sent; 409 -> closed; 400/403/404 -> rejected;
//	anything else (401, 408, 425, 429, 5xx, network error) -> failed, nonce freed.
func (h *Heartbeat) finishChatReply(ev chatReplyEvent) {
	store := h.endpointChatStore()
	post := h.postChatReply
	if h.chatReplySink != nil {
		post = h.chatReplySink
	}
	status, err := post(ev)
	switch {
	case err == nil && (status == http.StatusOK || status == http.StatusCreated):
		store.appendMessage(ev.ConversationID, ipc.ChatMessage{
			MessageID: uuid.NewString(),
			Direction: ipc.ChatDirectionFromUser,
			Body:      ev.Body,
			SentAt:    ev.At,
		})
		store.setNonceOutcome(ev.ConversationID, ev.ClientNonce, nonceSent)
		h.sendCurrentChatResult(ev.ConversationID, ev.ClientNonce, ipc.ChatReplySent)
	case err == nil && status == http.StatusConflict:
		store.markClosed(ev.ConversationID)
		store.setNonceOutcome(ev.ConversationID, ev.ClientNonce, nonceClosed)
		if cur := h.sendCurrentChatResult(ev.ConversationID, ev.ClientNonce, ipc.ChatReplyClosed); cur != nil {
			closeID := fmt.Sprintf("chat-close-ended-%s-%d", ev.ConversationID, time.Now().UnixNano())
			if cerr := cur.SendNotify(closeID, ipc.TypeChatClose, ipc.ChatClose{ConversationID: ev.ConversationID, Reason: "ended"}); cerr != nil {
				log.Warn("could not tell the assist helper the chat ended", "conversationId", ev.ConversationID, "error", cerr.Error())
			}
		}
	case err == nil && (status == http.StatusBadRequest || status == http.StatusForbidden || status == http.StatusNotFound):
		// replies_disabled, unknown_conversation, validation: a retry with the
		// same content cannot succeed. The nonce stays claimed as rejected.
		log.Warn("chat reply rejected by the API", "conversationId", ev.ConversationID, "status", status)
		store.setNonceOutcome(ev.ConversationID, ev.ClientNonce, nonceRejected)
		h.sendCurrentChatResult(ev.ConversationID, ev.ClientNonce, ipc.ChatReplyRejected)
	default:
		if err != nil {
			log.Warn("chat reply not delivered", "conversationId", ev.ConversationID, "error", err.Error())
		} else {
			log.Warn("chat reply not delivered", "conversationId", ev.ConversationID, "status", status)
		}
		store.releaseNonce(ev.ConversationID, ev.ClientNonce)
		h.sendCurrentChatResult(ev.ConversationID, ev.ClientNonce, ipc.ChatReplyFailed)
	}
}

// postChatReply sends one reply to POST /api/v1/agents/{id}/message-events. Any
// HTTP response is returned as a status (the caller maps 409/403/404); only
// transport failures and retry exhaustion are errors. httputil.Do already
// returns non-retryable 4xx responses without retrying.
func (h *Heartbeat) postChatReply(ev chatReplyEvent) (int, error) {
	body, err := json.Marshal(ev)
	if err != nil {
		return 0, fmt.Errorf("marshal chat reply: %w", err)
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/message-events", h.serverURL(), h.config.AgentID)
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		return 0, fmt.Errorf("post chat reply: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1024))
	return resp.StatusCode, nil
}

// replayChat re-sends every open conversation (retained transcript, both
// directions) to a freshly authenticated chat session. Fire-and-forget; a
// replay never shows a window and closed conversations never replay.
func (h *Heartbeat) replayChat(s *sessionbroker.Session) {
	if !h.isChatAssistSession(s) {
		return
	}
	n := 0
	// Never revive a stale chat: close what the API has already idled out.
	h.endpointChatStore().expireIdle(chatIdleClose)
	for _, c := range h.endpointChatStore().openSnapshots() {
		if len(c.Messages) == 0 {
			continue
		}
		show := ipc.ChatShow{
			ConversationID: c.ID,
			AllowReply:     c.AllowReply,
			Branding:       c.Branding,
			Messages:       c.Messages,
			Replay:         true,
			Closed:         false,
		}
		id := fmt.Sprintf("chat-replay-%s-%d", c.ID, time.Now().UnixNano())
		if err := s.SendNotify(id, ipc.TypeChatOpen, show); err != nil {
			log.Warn("endpoint chat replay failed", "conversationId", c.ID, "error", err.Error())
			continue
		}
		n++
	}
	if n > 0 {
		log.Info("replayed open endpoint chats to assist helper", "count", n, "sessionId", s.SessionID)
	}
}
