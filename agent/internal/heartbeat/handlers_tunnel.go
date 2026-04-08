package heartbeat

import (
	"encoding/base64"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/tunnel"
	"github.com/breeze-rmm/agent/internal/websocket"
)

func init() {
	handlerRegistry[tools.CmdTunnelOpen] = handleTunnelOpen
	handlerRegistry[tools.CmdTunnelData] = handleTunnelData
	handlerRegistry[tools.CmdTunnelClose] = handleTunnelClose
}

func handleTunnelOpen(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	tunnelID, _ := cmd.Payload["tunnelId"].(string)
	targetHost, _ := cmd.Payload["targetHost"].(string)
	targetPortF, _ := cmd.Payload["targetPort"].(float64)
	tunnelType, _ := cmd.Payload["tunnelType"].(string)
	targetPort := int(targetPortF)

	if tunnelID == "" || targetHost == "" || targetPort == 0 {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing tunnelId, targetHost, or targetPort",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	if tunnelType == "" {
		tunnelType = "proxy"
	}

	isVNC := tunnelType == "vnc"

	// Defense-in-depth: check hardcoded block list.
	if blocked, reason := tunnel.IsBlocked(targetHost, targetPort, isVNC); blocked {
		return tools.CommandResult{
			Status:     "failed",
			Error:      fmt.Sprintf("target %s:%d is blocked: %s", targetHost, targetPort, reason),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Defense-in-depth: validate against allowlist rules sent in the payload.
	if !isVNC {
		var rules []tunnel.AllowlistRule
		if rawRules, ok := cmd.Payload["allowlistRules"].([]interface{}); ok {
			for _, r := range rawRules {
				if pattern, ok := r.(string); ok {
					rule, err := tunnel.ParseAllowlistRule(pattern)
					if err != nil {
						log.Warn("invalid allowlist rule from API", "pattern", pattern, "error", err.Error())
						continue
					}
					rules = append(rules, rule)
				}
			}
		}
		// Defense-in-depth: deny if target doesn't match any rule.
		// Empty rules = deny (API should always send rules for proxy tunnels).
		if !tunnel.IsAllowed(targetHost, targetPort, rules) {
			return tools.CommandResult{
				Status:     "failed",
				Error:      fmt.Sprintf("target %s:%d not permitted by allowlist", targetHost, targetPort),
				DurationMs: time.Since(start).Milliseconds(),
			}
		}
	}

	// For VNC on macOS, ensure Screen Sharing is running.
	if isVNC {
		if !tunnel.IsScreenSharingRunning() {
			if h.tunnelMgr == nil || !h.tunnelMgr.IsManagedByPolicy() {
				return tools.CommandResult{
					Status:     "failed",
					Error:      "Screen Sharing is disabled on this device. Enable 'Manage Remote Management' in Config Policy to allow Breeze to control this, or enable it manually in System Preferences > Sharing.",
					DurationMs: time.Since(start).Milliseconds(),
				}
			}
		}
		// Policy allows management — enable Screen Sharing.
		if h.tunnelMgr != nil && h.tunnelMgr.IsManagedByPolicy() {
			vncPassword, _ := cmd.Payload["vncPassword"].(string)
			if err := tunnel.EnableScreenSharing(vncPassword); err != nil {
				return tools.CommandResult{
					Status:     "failed",
					Error:      fmt.Sprintf("failed to enable VNC screen sharing: %s", err.Error()),
					DurationMs: time.Since(start).Milliseconds(),
				}
			}
		}
	}

	if h.tunnelMgr == nil {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "tunnel manager not initialized",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	// Wire onData to send binary frames back through WebSocket.
	onData := func(tid string, data []byte) {
		if h.wsClient != nil {
			if err := h.wsClient.SendTunnelData(tid, data); err != nil {
				log.Warn("failed to send tunnel data", "tunnelId", tid, "error", err.Error())
			}
		}
	}

	// Wire onClose to notify the API via a command_result with tun-closed- prefix.
	onClose := func(tid string, closeErr error) {
		if h.wsClient == nil {
			return
		}
		errMsg := ""
		if closeErr != nil {
			errMsg = closeErr.Error()
		}
		if err := h.wsClient.SendResult(websocket.CommandResult{
			Type:      "command_result",
			CommandID: "tun-closed-" + tid,
			Status:    "completed",
			Error:     errMsg,
		}); err != nil {
			log.Error("failed to send tunnel close notification", "tunnelId", tid, "error", err.Error())
		}
	}

	if err := h.tunnelMgr.OpenTunnel(tunnelID, targetHost, targetPort, tunnelType, onData, onClose); err != nil {
		return tools.CommandResult{
			Status:     "failed",
			Error:      err.Error(),
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"tunnelId": tunnelID,
		"target":   fmt.Sprintf("%s:%d", targetHost, targetPort),
		"type":     tunnelType,
	}, time.Since(start).Milliseconds())
}

func handleTunnelData(h *Heartbeat, cmd Command) tools.CommandResult {
	tunnelID, _ := cmd.Payload["tunnelId"].(string)
	dataB64, _ := cmd.Payload["data"].(string)

	if tunnelID == "" || dataB64 == "" {
		return tools.CommandResult{Status: "failed", Error: "missing tunnelId or data"}
	}

	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return tools.CommandResult{Status: "failed", Error: "invalid base64 data: " + err.Error()}
	}

	if h.tunnelMgr == nil {
		return tools.CommandResult{Status: "failed", Error: "tunnel manager not initialized"}
	}

	if err := h.tunnelMgr.WriteTunnel(tunnelID, data); err != nil {
		return tools.CommandResult{Status: "failed", Error: err.Error()}
	}

	return tools.CommandResult{Status: "completed"}
}

func handleTunnelClose(h *Heartbeat, cmd Command) tools.CommandResult {
	start := time.Now()

	tunnelID, _ := cmd.Payload["tunnelId"].(string)
	if tunnelID == "" {
		return tools.CommandResult{
			Status:     "failed",
			Error:      "missing tunnelId",
			DurationMs: time.Since(start).Milliseconds(),
		}
	}

	if h.tunnelMgr != nil {
		wasVNC := h.tunnelMgr.GetTunnelType(tunnelID) == "vnc"
		h.tunnelMgr.CloseTunnel(tunnelID)
		if wasVNC {
			h.tunnelMgr.DisableScreenSharingIfIdle("tunnel close")
		}
	}

	return tools.NewSuccessResult(map[string]any{
		"tunnelId": tunnelID,
		"closed":   true,
	}, time.Since(start).Milliseconds())
}
