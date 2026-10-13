package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Endpoint message event types posted to the API (#8293). The acting user is
// agent-attested: the session fields come from the broker's authenticated
// helper session, never from the helper's own payload.
const (
	messageEventDisplayed    = "displayed"
	messageEventAcknowledged = "acknowledged"
	messageEventDismissed    = "dismissed"
	messageEventExpired      = "expired"
)

type messageEventSession struct {
	Username     string  `json:"username"`
	SID          string  `json:"sid,omitempty"`
	WinSessionID *uint32 `json:"winSessionId,omitempty"`
}

type messageEvent struct {
	MessageID string              `json:"messageId"`
	BatchID   string              `json:"batchId"`
	EventType string              `json:"eventType"`
	Session   messageEventSession `json:"session"`
	At        string              `json:"at"`
}

func messageEventSessionFor(s *sessionbroker.Session) messageEventSession {
	out := messageEventSession{Username: s.Username}
	// IdentityKey is the SID on Windows and the numeric UID elsewhere.
	if strings.HasPrefix(s.IdentityKey, "S-") {
		out.SID = s.IdentityKey
	}
	if id, err := strconv.ParseUint(s.WinSessionID, 10, 32); err == nil && id != 0 {
		v := uint32(id)
		out.WinSessionID = &v
	}
	return out
}

func newMessageEvent(show ipc.MessageShow, eventType string, s *sessionbroker.Session) messageEvent {
	return messageEvent{
		MessageID: show.MessageID,
		BatchID:   show.BatchID,
		EventType: eventType,
		Session:   messageEventSessionFor(s),
		At:        time.Now().UTC().Format(time.RFC3339),
	}
}

// emitMessageEvent posts an event without blocking the caller (the broker
// receive loop or a command handler). Delivery is best effort: the API
// deduplicates, and W1 has no outbox — a lost event leaves the audit trail one
// row short, it never re-shows a card.
func (h *Heartbeat) emitMessageEvent(ev messageEvent) {
	if h.messageEventSink != nil {
		go h.messageEventSink(ev)
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic posting endpoint message event", "error", fmt.Sprint(r))
			}
		}()
		if err := h.postMessageEvent(ev); err != nil {
			log.Warn("endpoint message event not delivered",
				"messageId", ev.MessageID, "eventType", ev.EventType, "error", err.Error())
		}
	}()
}

// postMessageEvent sends one event to POST /api/v1/agents/{id}/message-events,
// in the shape of SendElevationRequest (heartbeat retry config, 30 s timeout).
func (h *Heartbeat) postMessageEvent(ev messageEvent) error {
	body, err := json.Marshal(ev)
	if err != nil {
		return fmt.Errorf("marshal message event: %w", err)
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
		return fmt.Errorf("post message event: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		errBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		return fmt.Errorf("message-events returned status %d: %s", resp.StatusCode, string(errBody))
	}
	return nil
}

// isMessagingAssistSession is the single predicate for "this helper may draw
// endpoint message cards": an Assist-role helper holding the messaging scope
// (granted only on advertisement) in the active console session.
func (h *Heartbeat) isMessagingAssistSession(s *sessionbroker.Session) bool {
	if s == nil || s.HelperRole != ipc.HelperRoleAssist || !s.HasScope(ipc.ScopeMessaging) {
		return false
	}
	return h.sessionBroker == nil || h.sessionBroker.SessionInConsoleSession(s)
}

// handleMessageEventFromHelper turns a helper's message_presented / ack /
// dismissed into an upstream event. Only messages this agent drew and still
// holds are reported, so a helper cannot fabricate events for other ids.
func (h *Heartbeat) handleMessageEventFromHelper(s *sessionbroker.Session, env *ipc.Envelope) {
	if !h.isMessagingAssistSession(s) {
		log.Warn("dropping message event from a session that cannot draw messages",
			"type", env.Type, "sessionId", s.SessionID)
		return
	}
	// One struct reads all three payload shapes (MessageRef, MessagePresented,
	// MessageDismissed); the fields that do not apply stay empty.
	var ref struct {
		MessageID string `json:"messageId"`
		Status    string `json:"status"`
		Reason    string `json:"reason"`
	}
	if err := json.Unmarshal(env.Payload, &ref); err != nil || ref.MessageID == "" {
		log.Warn("invalid message event payload", "type", env.Type, "sessionId", s.SessionID)
		return
	}
	store := h.endpointMessageStore()
	show, ok := store.Get(ref.MessageID)
	if !ok {
		log.Debug("message event for an unknown or already closed message",
			"type", env.Type, "messageId", ref.MessageID)
		return
	}
	switch env.Type {
	case ipc.TypeMessagePresented:
		switch ref.Status {
		case "":
			h.emitMessageEvent(newMessageEvent(show, messageEventDisplayed, s))
		case ipc.MessagePresentedAlreadyResolved:
			// The user closed it in this helper process but the ack/dismiss
			// frame never arrived: retire it so it is not replayed again. No
			// event — which terminal action the user took is unknown.
			store.MarkTerminal(ref.MessageID)
		default:
			// Not drawn: keep it stored for the next helper auth.
			log.Warn("replayed message card was not drawn",
				"messageId", ref.MessageID, "status", ref.Status)
		}
	case ipc.TypeMessageAck:
		if store.MarkTerminal(ref.MessageID) {
			h.emitMessageEvent(newMessageEvent(show, messageEventAcknowledged, s))
		}
	case ipc.TypeMessageDismissed:
		eventType := messageEventDismissed
		if ref.Reason == ipc.MessageDismissReasonExpired {
			eventType = messageEventExpired
		}
		if store.MarkTerminal(ref.MessageID) {
			h.emitMessageEvent(newMessageEvent(show, eventType, s))
		}
	}
}

// replayEndpointMessages resends still-open cards to a freshly authenticated
// Assist helper. Only unexpired, unacknowledged messages are in the store, so
// nothing already closed can reappear. Fire-and-forget: the helper's
// message_presented arrives unsolicited and is reported as "displayed".
func (h *Heartbeat) replayEndpointMessages(s *sessionbroker.Session) {
	if !h.isMessagingAssistSession(s) {
		return
	}
	pending := h.endpointMessageStore().Pending(time.Now())
	for _, show := range pending {
		show.Replay = true
		id := fmt.Sprintf("msg-replay-%s-%d", show.MessageID, time.Now().UnixNano())
		if err := s.SendNotify(id, ipc.TypeMessageShow, show); err != nil {
			// Keep going: the message stays stored and is retried at the next
			// helper auth; one failed write must not strand the rest.
			log.Warn("endpoint message replay failed", "messageId", show.MessageID, "error", err.Error())
		}
	}
	if len(pending) > 0 {
		log.Info("replayed open endpoint messages to assist helper",
			"count", len(pending), "sessionId", s.SessionID)
	}
}
