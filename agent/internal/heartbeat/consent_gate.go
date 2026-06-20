package heartbeat

import (
	"encoding/json"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// consentTimeoutGraceMs is the extra time the service waits on the helper's
// consent IPC response beyond the user-facing ConsentTimeoutMs. The helper runs
// its own countdown and replies with the timeout verdict at ConsentTimeoutMs;
// the grace covers the round-trip so the service doesn't declare an IPC timeout
// before the helper's own decision lands.
const consentTimeoutGraceMs = 2000

// desktopPrompts remembers the prompt config for each live desktop session so
// the disconnect path (heartbeat.go's TypeDesktopPeerDisconnected branch) can
// fire the ended notice and hide the banner. Keyed by desktop session ID.
var (
	desktopPromptsMu sync.Mutex
	desktopPrompts   = map[string]*ipc.DesktopPrompt{}
)

func rememberDesktopPrompt(sessionID string, prompt *ipc.DesktopPrompt) {
	if sessionID == "" || prompt == nil {
		return
	}
	desktopPromptsMu.Lock()
	desktopPrompts[sessionID] = prompt
	desktopPromptsMu.Unlock()
}

func takeDesktopPrompt(sessionID string) *ipc.DesktopPrompt {
	if sessionID == "" {
		return nil
	}
	desktopPromptsMu.Lock()
	prompt := desktopPrompts[sessionID]
	delete(desktopPrompts, sessionID)
	desktopPromptsMu.Unlock()
	return prompt
}

// parseDesktopPrompt re-marshals the optional `prompt` block from a start_desktop
// payload into the typed ipc.DesktopPrompt. Returns nil when absent (older API)
// or when the block can't be decoded, so the caller treats it as "no prompt"
// and preserves the legacy behavior.
func parseDesktopPrompt(payload map[string]any) *ipc.DesktopPrompt {
	raw, ok := payload["prompt"].(map[string]any)
	if !ok {
		return nil
	}
	data, err := json.Marshal(raw)
	if err != nil {
		log.Warn("failed to marshal desktop prompt block", "error", err.Error())
		return nil
	}
	var prompt ipc.DesktopPrompt
	if err := json.Unmarshal(data, &prompt); err != nil {
		log.Warn("failed to unmarshal desktop prompt block", "error", err.Error())
		return nil
	}
	return &prompt
}

// requestConsent asks the local user (via the consent_ui-capable helper) to
// allow or deny a remote session. It uses PreferredSessionWithScope("consent_ui")
// to locate the assist helper. Returns (verdict, helperPresent, timedOut):
//   - no consent_ui-capable helper connected -> ("", false, false)  [helper_absent]
//   - helper present but IPC timed out        -> ("", true, true)   [timeout]
//   - helper replied with a valid decision    -> (result.Decision, true, false)
//   - helper present but replied with an error envelope or an undecodable
//     payload                                 -> ("", true, false)  [no_user, fails closed]
//
// The verdict is fed to decideConsent, which applies the unavailable-behavior
// policy for the helper_absent/timeout cases and fails closed for an
// invalid reply from a present helper. requestConsent itself does not decide
// whether to proceed.
func (h *Heartbeat) requestConsent(sessionID string, prompt *ipc.DesktopPrompt) (verdict string, helperPresent, timedOut bool) {
	if h.sessionBroker == nil {
		return "", false, false
	}
	session := h.sessionBroker.PreferredSessionWithScope("consent_ui")
	if session == nil {
		return "", false, false
	}

	req := ipc.ConsentRequest{
		SessionID:       sessionID,
		TechnicianName:  derefString(prompt.TechnicianName),
		TechnicianEmail: derefString(prompt.TechnicianEmail),
		OrgName:         derefString(prompt.OrgName),
		TimeoutMs:       prompt.ConsentTimeoutMs,
		OnTimeout:       prompt.ConsentUnavailableBehavior,
	}

	timeout := time.Duration(prompt.ConsentTimeoutMs+consentTimeoutGraceMs) * time.Millisecond
	resp, err := h.sessionBroker.SendCommandAndWait(session, "consent-"+sessionID, ipc.TypeConsentRequest, req, timeout)
	if err != nil {
		// Treat any IPC error (including ErrCommandTimeout) as "the user did not
		// answer in time". decideConsent + the unavailable-behavior policy then
		// decide whether to proceed or block.
		log.Warn("consent request to helper failed", "sessionId", sessionID, "error", err.Error())
		return "", true, true
	}

	// A present helper that signals an application-level error (e.g. it could not
	// build or show the dialog) yielded no user decision. Mirror RequestPamApproval:
	// surface it as an invalid reply (verdict "") so decideConsent fails closed
	// rather than letting a "proceed" default grant the session.
	if resp != nil && resp.Error != "" {
		log.Warn("consent helper returned an error", "sessionId", sessionID, "error", resp.Error)
		return "", true, false
	}

	var result ipc.ConsentResult
	if resp != nil && resp.Payload != nil {
		// An undecodable payload from a present helper is treated the same way:
		// verdict "" -> decideConsent fails closed.
		if err := json.Unmarshal(resp.Payload, &result); err != nil {
			log.Warn("failed to unmarshal consent result", "sessionId", sessionID, "error", err.Error())
		}
	}
	return result.Decision, true, false
}

// afterDesktopStart fires the start-of-session notice + banner for a session that
// is proceeding, and remembers the prompt so the disconnect path can fire the
// ended notice and hide the banner. Best-effort: failures are logged, never fatal.
func (h *Heartbeat) afterDesktopStart(sessionID string, prompt *ipc.DesktopPrompt) {
	if prompt == nil {
		return
	}
	rememberDesktopPrompt(sessionID, prompt)

	if prompt.Mode == "notify" {
		h.sendSessionNotify(connectedNotifyBody(prompt))
	}
	if prompt.ShowIndicator {
		h.sendBannerShow(sessionID, prompt)
	}
}

// sendSessionNotify pushes a fire-and-forget desktop notification to the
// preferred notify-capable helper. Used for the start/ended session notices.
func (h *Heartbeat) sendSessionNotify(body string) {
	if h.sessionBroker == nil || body == "" {
		return
	}
	session := h.sessionBroker.PreferredSessionWithScope("notify")
	if session == nil {
		log.Warn("no notify-capable helper for session notice")
		return
	}
	req := ipc.NotifyRequest{
		Title:   "Breeze Agent",
		Body:    body,
		Urgency: "normal",
	}
	if err := session.SendNotify("session-notify-"+randomNotifyID(), ipc.TypeNotify, req); err != nil {
		log.Warn("failed to send session notify", "error", err.Error())
	}
}

// sendBannerShow tells the assist helper to display the on-screen session
// indicator banner. Fire-and-forget; the helper renders it.
func (h *Heartbeat) sendBannerShow(sessionID string, prompt *ipc.DesktopPrompt) {
	if h.sessionBroker == nil {
		return
	}
	session := h.sessionBroker.PreferredSessionWithScope("consent_ui")
	if session == nil {
		log.Warn("no consent_ui-capable helper for session banner", "sessionId", sessionID)
		return
	}
	req := ipc.BannerShowRequest{
		SessionID:       sessionID,
		Label:           bannerLabel(prompt),
		StartedAtUnixMs: time.Now().UnixMilli(),
	}
	if err := session.SendNotify("banner-show-"+sessionID, ipc.TypeBannerShow, req); err != nil {
		log.Warn("failed to send banner show", "sessionId", sessionID, "error", err.Error())
	}
}

// sendBannerHide tells the assist helper to remove the session banner.
func (h *Heartbeat) sendBannerHide(sessionID string) {
	if h.sessionBroker == nil {
		return
	}
	session := h.sessionBroker.PreferredSessionWithScope("consent_ui")
	if session == nil {
		return
	}
	if err := session.SendNotify("banner-hide-"+sessionID, ipc.TypeBannerHide, map[string]any{"sessionId": sessionID}); err != nil {
		log.Warn("failed to send banner hide", "sessionId", sessionID, "error", err.Error())
	}
}

// handleConsentSessionEnd fires the ended notice + banner-hide for a session that
// had a remembered prompt, then forgets the mapping. Called from the peer
// disconnect path. No-op when the session was never prompted.
func (h *Heartbeat) handleConsentSessionEnd(sessionID string) {
	prompt := takeDesktopPrompt(sessionID)
	if prompt == nil {
		return
	}
	if prompt.ShowIndicator {
		h.sendBannerHide(sessionID)
	}
	if prompt.NotifyOnEnd {
		h.sendSessionNotify("Remote session ended")
	}
}

// consentDeniedResult builds the command result the API ingests when consent is
// not granted. It is returned as a COMPLETED result (not failed) so the
// agent->WS conversion in HandleCommand carries the marker in the `result`
// field; a `failed` result drops the Stdout payload. The session is NOT started.
func consentDeniedResult(sessionID, reason string, durationMs int64) tools.CommandResult {
	return tools.NewSuccessResult(map[string]any{
		"sessionId": sessionID,
		"event":     "consent_denied",
		"reason":    reason,
	}, durationMs)
}

// withConsentGranted re-marshals a successful helper start result to add the
// consentReason marker when the session was gated by a consent prompt that the
// user allowed. For notify/off modes it returns the result unchanged.
func withConsentGranted(result tools.CommandResult, prompt *ipc.DesktopPrompt) tools.CommandResult {
	if prompt == nil || prompt.Mode != "consent" || result.Status != "completed" || result.Stdout == "" {
		return result
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &data); err != nil || data == nil {
		log.Warn("failed to decode start result for consent marker", "error", errString(err))
		return result
	}
	data["consentReason"] = "user"
	return tools.NewSuccessResult(data, result.DurationMs)
}

func connectedNotifyBody(prompt *ipc.DesktopPrompt) string {
	if name := derefString(prompt.TechnicianName); name != "" {
		return name + " connected to your computer"
	}
	return "A technician connected to your computer"
}

func bannerLabel(prompt *ipc.DesktopPrompt) string {
	if name := derefString(prompt.TechnicianName); name != "" {
		return name + " is connected"
	}
	return "A technician is connected"
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// randomNotifyID returns a short unique-ish ID for fire-and-forget notify
// envelopes. The notify path doesn't await a response, so the ID only needs to
// avoid colliding with a pending command on the same session within a tick.
func randomNotifyID() string {
	return time.Now().Format("150405.000000000")
}
