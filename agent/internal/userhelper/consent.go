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
//
// This handler is dispatched via safeGo (client.go), which recovers panics
// but sends nothing back to the daemon. The most panic-prone code here is the
// raw Win32 MessageBoxTimeoutW syscall path. If a panic (or any other bug)
// left this handler without having sent a decision, the daemon's
// requestConsent (heartbeat/consent_gate.go) would block until the IPC
// timeout and then apply the default consentUnavailableBehavior — which for
// "proceed" starts the session with no consent shown, defeating the
// fail-closed intent (a present-but-malfunctioning helper must map to
// no_user -> deny). So handleConsentRequest guarantees a reply on every exit
// path, including its own panic recovery.
func (c *Client) handleConsentRequest(env *ipc.Envelope) {
	replied := false
	reply := func(decision string) {
		if err := c.conn.SendTyped(env.ID, ipc.TypeConsentResult, ipc.ConsentResult{Decision: decision}); err != nil {
			log.Warn("failed to send consent result", "id", env.ID, "error", err)
			return
		}
		replied = true
	}
	defer func() {
		if r := recover(); r != nil {
			// A crash in the dialog path (e.g. the raw Win32 syscall) must not
			// become daemon-side silence -> timeout -> proceed. Send a fail-closed
			// error so requestConsent classifies it as no_user -> deny. Recovered
			// (not re-panicked) intentionally: we've converted it into a reply.
			log.Error("consent handler panicked", "id", env.ID, "panic", fmt.Sprintf("%v", r))
			_ = c.conn.SendError(env.ID, ipc.TypeConsentResult, "consent handler panicked")
			return
		}
		if !replied {
			// Any non-panic path that fell through without a decision also fails closed.
			_ = c.conn.SendError(env.ID, ipc.TypeConsentResult, "consent handler produced no decision")
		}
	}()

	var req ipc.ConsentRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid consent_request payload", "error", err)
		_ = c.conn.SendError(env.ID, ipc.TypeConsentResult, fmt.Sprintf("invalid payload: %v", err))
		replied = true // terminal error reply already sent; don't double-send in defer
		return
	}
	req = sanitizeConsentRequest(req)
	allow, answered := showConsentDialogFn(req)
	decision := consentDecision(allow, answered, req.OnTimeout)
	log.Info("consent dialog decided", "sessionId", req.SessionID, "decision", decision, "answered", answered)
	reply(decision)
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
// Examples: "Billy (billy@example.com) from Olive Technology is requesting
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
