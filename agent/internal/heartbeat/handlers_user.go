package heartbeat

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// Command type constants for user helper operations.
const (
	CmdNotifyUser = "notify_user"
	CmdTrayUpdate = "tray_update"
)

func init() {
	handlerRegistry[CmdNotifyUser] = handleNotifyUser
	handlerRegistry[CmdTrayUpdate] = handleTrayUpdate
}

// handleNotifyUser sends a desktop notification to a user via their session helper.
func handleNotifyUser(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	if h.sessionBroker == nil {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "user helper not enabled",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	title := tools.GetPayloadString(cmd.Payload, "title", "Breeze Agent")
	body := tools.GetPayloadString(cmd.Payload, "body", "")
	icon := tools.GetPayloadString(cmd.Payload, "icon", "")
	urgency := tools.GetPayloadString(cmd.Payload, "urgency", "normal")
	username := tools.GetPayloadString(cmd.Payload, "username", "")

	if body == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "notification body is required",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Find a connected user helper session
	var session = h.sessionBroker.SessionForUser(username)
	if session == nil {
		// Try first available session if no username specified
		sessions := h.sessionBroker.AllSessions()
		if len(sessions) > 0 && username == "" {
			session = h.sessionBroker.SessionForIdentity(sessions[0].IdentityKey)
		}
	}
	if session == nil {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "no user helper connected",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Build actions list
	var actions []string
	if rawActions, ok := cmd.Payload["actions"].([]any); ok {
		for _, a := range rawActions {
			if s, ok := a.(string); ok {
				actions = append(actions, s)
			}
		}
	}

	notifyReq := ipc.NotifyRequest{
		Title:   title,
		Body:    body,
		Icon:    icon,
		Urgency: urgency,
		Actions: actions,
	}

	resp, err := h.sessionBroker.SendCommandAndWait(session, cmd.ID, ipc.TypeNotify, notifyReq, 10*time.Second)
	if err != nil {
		return tools.NewErrorResult(
			fmt.Errorf("notify via user helper: %w", err),
			time.Since(start).Milliseconds(),
		)
	}

	var result ipc.NotifyResult
	if resp != nil && resp.Payload != nil {
		if err := json.Unmarshal(resp.Payload, &result); err != nil {
			log.Warn("failed to unmarshal notify result", "error", err)
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"delivered":     result.Delivered,
		"actionClicked": result.ActionClicked,
		"uid":           session.UID,
		"username":      session.Username,
	}, time.Since(start).Milliseconds())
}

// handleTrayUpdate sends a tray icon/menu update to all connected user helpers.
func handleTrayUpdate(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	if h.sessionBroker == nil {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "user helper not enabled",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	status := tools.GetPayloadString(cmd.Payload, "status", "ok")
	tooltip := tools.GetPayloadString(cmd.Payload, "tooltip", "Breeze Agent")

	var menuItems []ipc.MenuItem
	if rawItems, ok := cmd.Payload["menuItems"].([]any); ok {
		for _, item := range rawItems {
			if obj, ok := item.(map[string]any); ok {
				menuItems = append(menuItems, ipc.MenuItem{
					ID:      tools.GetPayloadString(obj, "id", ""),
					Label:   tools.GetPayloadString(obj, "label", ""),
					Enabled: tools.GetPayloadBool(obj, "enabled", true),
				})
			}
		}
	}

	update := ipc.TrayUpdate{
		Status:    status,
		Tooltip:   tooltip,
		MenuItems: menuItems,
	}

	sessions := h.sessionBroker.AllSessions()
	sent := 0
	for _, info := range sessions {
		session := h.sessionBroker.SessionForIdentity(info.IdentityKey)
		if session != nil {
			if err := session.SendNotify(cmd.ID, ipc.TypeTrayUpdate, update); err != nil {
				log.Warn("tray update failed for session", "uid", info.UID, "error", err)
			} else {
				sent++
			}
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"sentTo": sent,
	}, time.Since(start).Milliseconds())
}
