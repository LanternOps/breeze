package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// endpointMessageSource marks a notify_user payload built by the API's
// endpoint-message send route (#8293). Any other payload keeps the legacy
// single-session toast path untouched.
const endpointMessageSource = "endpoint_message"

const endpointMessageHelperTimeout = 10 * time.Second

// Defence in depth: the API validates these limits; the agent refuses a
// payload outside them rather than forwarding it to a helper.
const (
	endpointMessageTitleMax = 120
	endpointMessageBodyMax  = 2000
)

var endpointMessageSeverities = map[string]bool{"info": true, "warning": true, "critical": true}

func endpointMessageFromPayload(p map[string]any, now time.Time) (ipc.MessageShow, error) {
	show := ipc.MessageShow{
		MessageID:   strings.TrimSpace(tools.GetPayloadString(p, "messageId", "")),
		BatchID:     strings.TrimSpace(tools.GetPayloadString(p, "batchId", "")),
		Title:       tools.GetPayloadString(p, "title", ""),
		Body:        tools.GetPayloadString(p, "body", ""),
		Severity:    tools.GetPayloadString(p, "severity", ""),
		RequiresAck: tools.GetPayloadBool(p, "requiresAck", false),
		ExpiresAt:   tools.GetPayloadString(p, "expiresAt", ""),
	}
	if b, ok := p["branding"].(map[string]any); ok {
		show.Branding = ipc.MessageBranding{
			CompanyName: tools.GetPayloadString(b, "companyName", ""),
			DisplayName: tools.GetPayloadString(b, "displayName", ""),
			Accent:      tools.GetPayloadString(b, "accent", ""),
		}
	}
	switch {
	case show.MessageID == "" || show.BatchID == "":
		return show, errors.New("message id and batch id are required")
	case strings.TrimSpace(show.Title) == "" || strings.TrimSpace(show.Body) == "":
		return show, errors.New("message title and body are required")
	case len([]rune(show.Title)) > endpointMessageTitleMax || len([]rune(show.Body)) > endpointMessageBodyMax:
		return show, errors.New("message exceeds content limits")
	case !endpointMessageSeverities[show.Severity]:
		return show, fmt.Errorf("unknown message severity %q", show.Severity)
	}
	expires, err := time.Parse(time.RFC3339, show.ExpiresAt)
	if err != nil {
		return show, errors.New("message expiresAt is missing or invalid")
	}
	if !expires.After(now) {
		return show, errors.New("message expired before delivery")
	}
	return show, nil
}

// nativeMessageRequest is the toast (or, for critical, the self-dismissing
// native dialog) shown where no Assist card can be drawn. The sender comes from
// the server-resolved branding, prefixed so the body cannot pose as the sender.
func nativeMessageRequest(show ipc.MessageShow) ipc.NotifyRequest {
	title := show.Title
	if sender := strings.TrimSpace(show.Branding.CompanyName); sender != "" {
		title = sender + ": " + show.Title
	}
	urgency := "normal"
	if show.Severity == "critical" {
		urgency = "critical"
	}
	return ipc.NotifyRequest{
		Title:          title,
		Body:           show.Body,
		Urgency:        urgency,
		FallbackDialog: show.Severity == "critical",
	}
}

type nativeDelivery struct {
	session   *sessionbroker.Session
	delivered bool
}

// sendNativeMessage shows the message on every given session in parallel and
// reports which ones confirmed delivery.
func (h *Heartbeat) sendNativeMessage(cmdID string, show ipc.MessageShow, targets []*sessionbroker.Session) []nativeDelivery {
	req := nativeMessageRequest(show)
	out := make([]nativeDelivery, len(targets))
	var wg sync.WaitGroup
	for i, s := range targets {
		out[i].session = s
		wg.Add(1)
		go func(i int, s *sessionbroker.Session) {
			defer wg.Done()
			defer func() {
				if r := recover(); r != nil {
					log.Error("panic in native endpoint message send", "error", fmt.Sprint(r))
				}
			}()
			resp, err := h.sessionBroker.SendCommandAndWait(s, fmt.Sprintf("%s-native-%d", cmdID, i), ipc.TypeNotify, req, endpointMessageHelperTimeout)
			if err != nil || resp == nil || resp.Error != "" {
				log.Warn("native endpoint message not delivered", "sessionId", s.SessionID, "error", fmt.Sprint(err))
				return
			}
			var res ipc.NotifyResult
			if err := json.Unmarshal(resp.Payload, &res); err == nil && res.Delivered {
				out[i].delivered = true
			}
		}(i, s)
	}
	wg.Wait()
	return out
}

// handleEndpointMessage delivers an endpoint message (#8293 W1):
//   - a messaging-capable Assist helper in the console session draws the
//     persistent card (kept for replay until acked, closed or expired);
//   - every OTHER interactive session gets the native toast, so an RDS user is
//     never suppressed by the console Assist helper;
//   - with no capable Assist helper every session gets the native path.
func handleEndpointMessage(h *Heartbeat, cmd Command, start time.Time) tools.CommandResult {
	fail := func(msg string) tools.CommandResult {
		return tools.CommandResult{Status: "failed", Error: msg, DurationMs: time.Since(start).Milliseconds()}
	}
	show, err := endpointMessageFromPayload(cmd.Payload, time.Now())
	if err != nil {
		return fail(err.Error())
	}
	persistent := tools.GetPayloadBool(cmd.Payload, "persistent", true)

	assistOK := false
	var assist *sessionbroker.Session
	if s := h.sessionBroker.PreferredSessionWithScope(ipc.ScopeMessaging); h.isMessagingAssistSession(s) {
		assist = s
		resp, err := h.sessionBroker.SendCommandAndWait(s, "msg-"+cmd.ID, ipc.TypeMessageShow, show, endpointMessageHelperTimeout)
		switch {
		case err != nil:
			log.Warn("assist message card not presented; using native fallback", "error", err.Error())
		case resp == nil || resp.Error != "":
			log.Warn("assist helper refused message card; using native fallback", "error", respError(resp))
		default:
			assistOK = true
		}
	}

	exclude := ""
	if assistOK {
		exclude = assist.WinSessionID
		if persistent {
			if err := h.endpointMessageStore().Put(show, time.Now()); err != nil {
				log.Warn("endpoint message not kept for replay", "messageId", show.MessageID, "error", err.Error())
			}
		}
		h.emitMessageEvent(newMessageEvent(show, messageEventDisplayed, assist))
	}
	natives := h.sendNativeMessage(cmd.ID, show, h.sessionBroker.NotifyTargetsExcept(exclude))
	nativeDelivered := 0
	for _, d := range natives {
		if d.delivered {
			nativeDelivered++
			h.emitMessageEvent(newMessageEvent(show, messageEventDisplayed, d.session))
		}
	}

	if !assistOK && nativeDelivered == 0 {
		if assist == nil && len(natives) == 0 {
			return fail("no user helper connected")
		}
		return fail("message was not delivered to any user session")
	}

	surface := "native"
	primary := assist
	if !assistOK {
		primary = nil
		for _, d := range natives {
			if d.delivered {
				primary = d.session
				break
			}
		}
	} else {
		surface = "assist"
	}
	return tools.NewSuccessResult(map[string]any{
		"delivered":       true,
		"surface":         surface,
		"nativeDelivered": nativeDelivered,
		"uid":             primary.UID,
		"username":        primary.Username,
	}, time.Since(start).Milliseconds())
}

func respError(resp *ipc.Envelope) string {
	if resp == nil {
		return "no response"
	}
	return resp.Error
}
