package userhelper

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// maxConsentTimeoutMs caps the dialog countdown at 10 minutes; the API sends
// 30s today, the cap only guards against a hostile/buggy daemon payload.
const maxConsentTimeoutMs = 600_000

// showConsentDialogFn is the platform dialog seam; tests swap it for a fake.
// It blocks until the user answers or the countdown expires.
// answered=false means the countdown expired with no user decision.
var showConsentDialogFn = showConsentDialogOS

// handleConsentRequest renders the native consent dialog and replies with a
// consent_result on the same envelope ID — the exact wire contract the Tauri
// assist helper implements (apps/helper/src-tauri/src/ipc/client.rs).
func (c *Client) handleConsentRequest(env *ipc.Envelope) {
	var req ipc.ConsentRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid consent_request payload", "error", err)
		if sendErr := c.conn.SendError(env.ID, ipc.TypeConsentResult, fmt.Sprintf("invalid payload: %v", err)); sendErr != nil {
			log.Warn("failed to send consent error", "error", sendErr)
		}
		return
	}
	req = sanitizeConsentRequest(req)
	allow, answered := showConsentDialogFn(req)
	decision := consentDecision(allow, answered, req.OnTimeout)
	log.Info("consent dialog decided", "sessionId", req.SessionID, "decision", decision, "answered", answered)
	if err := c.conn.SendTyped(env.ID, ipc.TypeConsentResult, ipc.ConsentResult{Decision: decision}); err != nil {
		log.Warn("failed to send consent result", "id", env.ID, "error", err)
	}
}

// consentDecision maps the dialog outcome to the wire decision. On countdown
// expiry the helper SENDS the policy verdict rather than going silent —
// mirroring the Tauri dialog (ConsentDialog.tsx: onDecision(onTimeout ===
// "proceed", "timeout")). Unknown onTimeout fails closed.
func consentDecision(allow, answered bool, onTimeout string) string {
	if answered {
		if allow {
			return "allow"
		}
		return "deny"
	}
	if onTimeout == "proceed" {
		return "allow"
	}
	return "deny"
}

func sanitizeConsentRequest(req ipc.ConsentRequest) ipc.ConsentRequest {
	req.TechnicianName = stripControl(trimNotifyField(req.TechnicianName, maxNotifyTitleBytes))
	req.TechnicianEmail = stripControl(trimNotifyField(req.TechnicianEmail, maxNotifyTitleBytes))
	req.OrgName = stripControl(trimNotifyField(req.OrgName, maxNotifyTitleBytes))
	req.OnTimeout = strings.ToLower(strings.TrimSpace(req.OnTimeout))
	if req.TimeoutMs < 0 {
		req.TimeoutMs = 0
	}
	if req.TimeoutMs > maxConsentTimeoutMs {
		req.TimeoutMs = maxConsentTimeoutMs
	}
	return req
}

func stripControl(s string) string {
	return strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, s)
}

// buildConsentDialogText renders the platform-neutral dialog copy.
// Examples: "Billy (billy@olive.co) from Olive Technology is requesting
// remote access to view and control this computer."
func buildConsentDialogText(req ipc.ConsentRequest) (title, body string) {
	who := "A technician"
	if req.TechnicianName != "" {
		who = req.TechnicianName
		if req.TechnicianEmail != "" {
			who += " (" + req.TechnicianEmail + ")"
		}
	}
	if req.OrgName != "" {
		who += " from " + req.OrgName
	}
	return "Remote Support Request", who + " is requesting remote access to view and control this computer."
}
