package heartbeat

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// consentTimeoutGraceMs is the extra time the service waits on the helper's
// consent IPC response beyond the user-facing ConsentTimeoutMs. The helper runs
// its own countdown and replies with the timeout verdict at ConsentTimeoutMs;
// the grace covers the round-trip so the service doesn't declare an IPC timeout
// before the helper's own decision lands. Mirrored as
// AGENT_CONSENT_IPC_GRACE_MS in apps/api/src/routes/remote/consentTiming.ts,
// which sizes the viewer's answer wait from it (#6818); change both together.
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

// consentPresentBudgetMs is how long the agent waits for the helper to confirm
// the consent prompt is on screen (consent_presented). The prompt's own
// countdown starts only then, so the whole answer can take this plus
// ConsentTimeoutMs plus consentTimeoutGraceMs. Mirrored as
// AGENT_CONSENT_PRESENT_BUDGET_MS in apps/api/src/routes/remote/consentTiming.ts,
// which sizes the viewer's answer wait from it; change both together.
const consentPresentBudgetMs = 10000

// consentPresentBudget is consentPresentBudgetMs as a Duration (a var so tests
// can shorten it).
var consentPresentBudget = time.Duration(consentPresentBudgetMs) * time.Millisecond

// consentHostOS is the OS whose consent binding rules apply (a var so tests
// can exercise the Windows and macOS rules anywhere).
var consentHostOS = runtime.GOOS

// consentInFlight holds the helper sessions (by SessionID) currently showing a
// consent prompt. A second start that would prompt the same helper is refused
// rather than stacked: two prompts on one desktop invite an answer to the
// wrong request.
var consentInFlight sync.Map

// Test seams for the two OS facts the decision may need.
var (
	// consentOccupancyFn reports whether anyone is signed in to the session a
	// start would capture (target = Windows session, "" untargeted).
	consentOccupancyFn = func(target string) string {
		sessions, err := listConsentSessionsFn()
		displays, displayErr := 0, error(nil)
		if runtime.GOOS == "linux" {
			displays, displayErr = countX11DisplaysFn()
		}
		return classifyConsentOccupancy(runtime.GOOS, sessions, err, target, displays, displayErr)
	}
	// consentVisibleFn reports whether the user in the consenting helper's
	// session could see its prompt (active and unlocked).
	consentVisibleFn = func(helper *sessionbroker.Session) bool {
		if helper == nil {
			return false
		}
		sessions, err := listConsentSessionsFn()
		return consentTargetVisible(runtime.GOOS, sessions, err, helper.WinSessionID)
	}
)

// runConsentGate asks the signed-in user (when there is one to ask) and
// decides whether a consent-mode start may proceed. See decideConsent for the
// matrix.
func (h *Heartbeat) runConsentGate(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string) consentVerdict {
	att := h.solicitConsent(sessionID, prompt, targetWinSession)
	v := decideConsent(att, prompt.ConsentUnavailableBehavior,
		func() string { return consentOccupancyFn(targetWinSession) },
		func() bool { return consentVisibleFn(att.helper) })
	log.Info("consent gate decided",
		"sessionId", sessionID,
		"proceed", v.proceed,
		"reason", v.reason,
		"outcome", v.outcome,
		"occupancy", v.occupancy,
		"detail", v.detail,
	)
	return v
}

// consentHelperForTarget picks the helper that will show the prompt: the
// Breeze Assist app (consent_ui) when connected, else a native user helper
// that advertised consent_ui_fallback AND the v2 exchange. A pre-v2 native
// helper is never asked — it answered "allow" when its countdown ran out
// under a proceed policy, which is indistinguishable from a click. Targeting
// is strict (see sessionWithScopeForTarget).
func (h *Heartbeat) consentHelperForTarget(targetWinSession string) *sessionbroker.Session {
	if h.sessionBroker == nil {
		return nil
	}
	if s := h.sessionWithScopeForTarget(ipc.ScopeConsentUI, targetWinSession); s != nil {
		return s
	}
	s := h.sessionWithScopeForTarget(ipc.ScopeConsentUIFallback, targetWinSession)
	if s == nil {
		return nil
	}
	if s.ConsentProtocolVersion < ipc.ConsentProtocolVersion {
		log.Warn("native consent helper predates the current consent prompt protocol; not asking it",
			"winSession", s.WinSessionID, "pid", s.PID, "helperProtocol", s.ConsentProtocolVersion)
		return nil
	}
	return s
}

// solicitConsent shows the consent prompt and reports what happened. It never
// decides: decideConsent does, from the returned attempt.
func (h *Heartbeat) solicitConsent(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string) consentAttempt {
	session := h.consentHelperForTarget(targetWinSession)
	if session == nil {
		return consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "no_helper"}
	}
	if _, busy := consentInFlight.LoadOrStore(session.SessionID, struct{}{}); busy {
		log.Warn("consent prompt refused: another prompt is already on this helper",
			"sessionId", sessionID, "helper", session.SessionID)
		return consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "prompt_in_progress", helper: session}
	}
	defer consentInFlight.Delete(session.SessionID)

	// Record which helper the prompt is routed to. On the success path the
	// broker's send/reply is otherwise silent, so this is the only line that
	// attributes a ConsentRequest to a specific Windows session — the invariant
	// that matters when a shadow targets one RDS session among several.
	log.Info("routing consent prompt to helper",
		"sessionId", sessionID,
		"targeted", targetWinSession != "",
		"winSession", session.WinSessionID,
		"identity", session.IdentityKey,
		"role", session.HelperRole,
		"pid", session.PID,
		"helperProtocol", session.ConsentProtocolVersion,
	)

	req := ipc.ConsentRequest{
		SessionID:       sessionID,
		TechnicianName:  derefString(prompt.TechnicianName),
		TechnicianEmail: derefString(prompt.TechnicianEmail),
		OrgName:         derefString(prompt.OrgName),
		TimeoutMs:       prompt.ConsentTimeoutMs,
		OnTimeout:       prompt.ConsentUnavailableBehavior,
		ProtocolVersion: ipc.ConsentProtocolVersion,
		Nonce:           newConsentNonce(),
	}
	answerWait := time.Duration(prompt.ConsentTimeoutMs+consentTimeoutGraceMs) * time.Millisecond

	var att consentAttempt
	if session.ConsentProtocolVersion >= ipc.ConsentProtocolVersion {
		att = solicitConsentV2(session, "consent-"+sessionID, req, answerWait)
	} else {
		att = solicitConsentLegacy(session, "consent-"+sessionID, req, answerWait)
	}
	att.helper = session
	return att
}

// solicitConsentV2 runs the two-stage exchange: wait up to consentPresentBudget
// for the presentation acknowledgement, then up to answerWait for the terminal
// result, both correlated by nonce. A prompt abandoned without a terminal
// result is cancelled on the helper so it does not linger on screen.
func solicitConsentV2(session *sessionbroker.Session, id string, req ipc.ConsentRequest, answerWait time.Duration) consentAttempt {
	stream, err := session.OpenCommandStream(id, ipc.TypeConsentRequest, req)
	if err != nil {
		log.Warn("consent request to helper failed", "id", id, "error", err.Error())
		return consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "send_failed"}
	}
	defer stream.Close()

	terminal := false
	defer func() {
		if terminal {
			return
		}
		if err := session.SendNotify("consent-cancel-"+req.Nonce, ipc.TypeConsentCancel, ipc.ConsentCancel{Nonce: req.Nonce}); err != nil {
			log.Debug("failed to cancel abandoned consent prompt", "id", id, "error", err.Error())
		}
	}()

	presented := false
	timer := time.NewTimer(consentPresentBudget)
	defer timer.Stop()

	handle := func(env *ipc.Envelope) (consentAttempt, bool) {
		att, done, ack := classifyConsentEnvelope(env, req.Nonce, presented)
		if ack && !presented {
			presented = true
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(answerWait)
		}
		return att, done
	}

	for {
		select {
		case env := <-stream.Envelopes():
			if att, done := handle(env); done {
				terminal = true
				return att
			}
		case <-stream.Done():
			// A reply can land just before the helper's EOF.
			for {
				select {
				case env := <-stream.Envelopes():
					if att, done := handle(env); done {
						terminal = true
						return att
					}
					continue
				default:
				}
				break
			}
			terminal = true // nobody left to cancel
			if presented {
				return consentAttempt{outcome: consentOutcomeUnknown, detail: "helper_disconnected"}
			}
			return consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "helper_disconnected"}
		case <-timer.C:
			if presented {
				log.Warn("consent prompt was shown but no answer arrived", "id", id)
				return consentAttempt{outcome: consentOutcomeUnknown, detail: "no_answer"}
			}
			log.Warn("consent helper did not confirm showing the prompt", "id", id)
			return consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "no_presentation"}
		}
	}
}

// classifyConsentEnvelope interprets one reply to a v2 consent request.
// ack reports a presentation acknowledgement for this nonce; done reports a
// terminal reply (att is then the attempt). Replies for another nonce, and
// message types that are neither, are ignored.
func classifyConsentEnvelope(env *ipc.Envelope, nonce string, presented bool) (att consentAttempt, done, ack bool) {
	if env == nil {
		return consentAttempt{}, false, false
	}
	switch env.Type {
	case ipc.TypeConsentPresented:
		var p ipc.ConsentPresented
		if err := json.Unmarshal(env.Payload, &p); err != nil || p.Nonce != nonce {
			return consentAttempt{}, false, false
		}
		return consentAttempt{}, false, true
	case ipc.TypeConsentResult:
		if env.Error != "" {
			log.Warn("consent helper returned an error", "id", env.ID, "error", env.Error)
			if presented {
				return consentAttempt{outcome: consentOutcomeUnknown, detail: "helper_error"}, true, false
			}
			return consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "helper_error"}, true, false
		}
		var res ipc.ConsentResult
		if err := json.Unmarshal(env.Payload, &res); err != nil {
			return consentAttempt{outcome: consentOutcomeUnknown, detail: "invalid_reply"}, true, false
		}
		if res.Nonce != nonce {
			log.Warn("ignoring consent result for another prompt", "id", env.ID)
			return consentAttempt{}, false, false
		}
		switch res.Outcome {
		case ipc.ConsentOutcomeGranted, ipc.ConsentOutcomeDenied:
			// A click proves the prompt was on screen.
			return consentAttempt{outcome: res.Outcome}, true, false
		case ipc.ConsentOutcomePresentedExpired:
			if !presented {
				return consentAttempt{outcome: consentOutcomeUnknown, detail: "expired_without_presentation"}, true, false
			}
			return consentAttempt{outcome: res.Outcome}, true, false
		case ipc.ConsentOutcomeUnavailable:
			if presented {
				return consentAttempt{outcome: consentOutcomeUnknown, detail: "contradictory_reply"}, true, false
			}
			return consentAttempt{outcome: res.Outcome, detail: sanitizeConsentDetail(res.Detail)}, true, false
		default:
			return consentAttempt{outcome: consentOutcomeUnknown, detail: "invalid_reply"}, true, false
		}
	default:
		return consentAttempt{}, false, false
	}
}

// solicitConsentLegacy talks to a version 1 Assist helper, which replies only
// to a click and says nothing when its countdown runs out (or when it could
// not show the prompt at all). Its clicks are honored; anything else is an
// unknown outcome, which blocks — silence is not proof the prompt was seen.
func solicitConsentLegacy(session *sessionbroker.Session, id string, req ipc.ConsentRequest, answerWait time.Duration) consentAttempt {
	resp, err := session.SendCommand(id, ipc.TypeConsentRequest, req, answerWait)
	if err != nil {
		log.Warn("legacy consent helper gave no answer", "id", id, "error", err.Error())
		return consentAttempt{outcome: consentOutcomeUnknown, detail: "legacy_no_answer"}
	}
	if resp == nil || resp.Error != "" {
		return consentAttempt{outcome: consentOutcomeUnknown, detail: "helper_error"}
	}
	var result ipc.ConsentResult
	if err := json.Unmarshal(resp.Payload, &result); err != nil {
		return consentAttempt{outcome: consentOutcomeUnknown, detail: "invalid_reply"}
	}
	switch result.Decision {
	case "allow":
		return consentAttempt{outcome: ipc.ConsentOutcomeGranted}
	case "deny":
		return consentAttempt{outcome: ipc.ConsentOutcomeDenied}
	default:
		return consentAttempt{outcome: consentOutcomeUnknown, detail: "invalid_reply"}
	}
}

// sanitizeConsentDetail keeps a helper-supplied detail only when it is short
// lowercase snake_case (the API refuses anything else).
func sanitizeConsentDetail(detail string) string {
	if detail == "" || len(detail) > 64 {
		return ""
	}
	for _, r := range detail {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '_' {
			return ""
		}
	}
	return detail
}

// newConsentNonce returns a fresh 128-bit hex nonce for one consent prompt.
func newConsentNonce() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		// crypto/rand does not fail on supported platforms; fall back to a
		// time-derived value rather than an empty (uncorrelatable) nonce.
		return fmt.Sprintf("%032x", time.Now().UnixNano())
	}
	return hex.EncodeToString(b[:])
}

// consentCaptureTarget binds an untargeted Windows start to the session whose
// user answered the prompt, so the capture shows the desktop of the person who
// consented (and not, say, the console while the prompt went to an RDP user).
// Everything else keeps its target.
func consentCaptureTarget(goos, target string, helper *sessionbroker.Session) string {
	if goos != "windows" || target != "" || helper == nil {
		return target
	}
	if helper.WinSessionID == "" || helper.WinSessionID == "0" {
		return target
	}
	return helper.WinSessionID
}

// sameConsentPrincipal reports whether the capture helper serves the desktop
// the consenting helper's user answered on. On Windows the capture helper runs
// as SYSTEM inside the user's session, so the WTS session is the binding; on
// macOS the capture helper runs as the user. Linux has no capture helper.
func sameConsentPrincipal(goos string, consent, capture *sessionbroker.Session) bool {
	switch goos {
	case "windows":
		return consent.WinSessionID != "" && consent.WinSessionID == capture.WinSessionID
	case "darwin":
		return consent.IdentityKey != "" && consent.IdentityKey == capture.IdentityKey
	default:
		return true
	}
}

// consentBindingDetail re-checks, after capture started and before the answer
// is released, that the grounds the gate proceeded on still hold. It returns a
// non-empty detail when they do not.
//
//   - A user answer or an unanswered prompt binds to the helper that showed
//     it: it must still be connected (same logon), and the capture must be of
//     that user's desktop. viaHelper says the capture runs in a helper, whose
//     identity must then be known — an unresolvable capture helper is refused
//     rather than assumed to match.
//   - "Nobody is signed in" must still be true.
func (h *Heartbeat) consentBindingDetail(sessionID string, v consentVerdict, target string, viaHelper bool) string {
	switch v.reason {
	case consentReasonUser, consentReasonTimeout:
		if v.helper == nil || v.helper.IsClosed() {
			return "consent_helper_gone"
		}
		if !viaHelper {
			return ""
		}
		capture := h.desktopOwnerSession(sessionID)
		if capture == nil {
			return "capture_target_unknown"
		}
		if !sameConsentPrincipal(consentHostOS, v.helper, capture) {
			return "capture_target_changed"
		}
	case consentReasonNoUserSession:
		if consentOccupancyFn(target) != occupancyUnoccupied {
			return "user_signed_in"
		}
	}
	return ""
}

// sessionWithScopeForTarget resolves the helper session that should present
// user-facing UI for an operation. An empty target keeps the legacy
// machine-global selection (workstations, untargeted connects). A non-empty
// target is strict: UI must land in that Windows session or nowhere —
// falling back to another session would show the prompt to the wrong user.
func (h *Heartbeat) sessionWithScopeForTarget(scope, targetWinSession string) *sessionbroker.Session {
	if targetWinSession == "" {
		return h.sessionBroker.PreferredSessionWithScope(scope)
	}
	return h.sessionBroker.SessionWithScopeInWinSession(scope, targetWinSession)
}

// consentUISessionForTarget returns the best helper session able to render
// consent UI: the Tauri assist helper (rich branded dialog) when connected,
// else a user-helper that advertised native fallback dialogs at auth. When
// targetWinSession is non-empty, both scopes are resolved strictly within
// that Windows session (see sessionWithScopeForTarget) — never falling back
// to another user's session.
func (h *Heartbeat) consentUISessionForTarget(targetWinSession string) *sessionbroker.Session {
	if s := h.sessionWithScopeForTarget(ipc.ScopeConsentUI, targetWinSession); s != nil {
		return s
	}
	return h.sessionWithScopeForTarget(ipc.ScopeConsentUIFallback, targetWinSession)
}

// afterDesktopStart fires the start-of-session notice + banner for a session that
// is proceeding, and remembers the prompt so the disconnect path can fire the
// ended notice and hide the banner. Best-effort: failures are logged, never fatal.
func (h *Heartbeat) afterDesktopStart(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string) {
	if prompt == nil {
		return
	}
	rememberDesktopPrompt(sessionID, prompt)

	if prompt.Mode == "notify" {
		h.sendSessionNotify(connectedNotifyBody(prompt), targetWinSession)
	}
	if prompt.ShowIndicator {
		h.sendBannerShow(sessionID, prompt, targetWinSession)
	}
}

// sendSessionNotify pushes a fire-and-forget desktop notification to the
// notify-capable helper. Used for the start/ended session notices. An empty
// targetWinSession keeps the legacy machine-global selection; a non-empty one
// routes strictly to that Windows session (see sessionNoticeTarget).
func (h *Heartbeat) sendSessionNotify(body, targetWinSession string) {
	if h.sessionBroker == nil || body == "" {
		return
	}
	session := h.sessionNoticeTarget(targetWinSession)
	if session == nil {
		log.Warn("no notify-capable helper for session notice")
		return
	}
	req := sessionNoticeRequest(body)
	if err := session.SendNotify("session-notify-"+randomNotifyID(), ipc.TypeNotify, req); err != nil {
		log.Warn("failed to send session notify", "error", err.Error())
	}
}

// sendBannerShow tells the consent-UI helper (assist app, or the native
// user-helper as fallback) to display the on-screen session indicator
// banner. Fire-and-forget; the helper renders it. See
// consentUISessionForTarget for the targeting semantics.
func (h *Heartbeat) sendBannerShow(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string) {
	if h.sessionBroker == nil {
		return
	}
	session := h.consentUISessionForTarget(targetWinSession)
	if session == nil {
		log.Warn("no consent-ui-capable helper for session banner", "sessionId", sessionID)
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

// sendBannerHide tells the consent-UI helper (assist app, or the native
// user-helper as fallback) to remove the session banner. See
// consentUISessionForTarget for the targeting semantics.
func (h *Heartbeat) sendBannerHide(sessionID, targetWinSession string) {
	if h.sessionBroker == nil {
		return
	}
	session := h.consentUISessionForTarget(targetWinSession)
	if session == nil {
		return
	}
	if err := session.SendNotify("banner-hide-"+sessionID, ipc.TypeBannerHide, map[string]any{"sessionId": sessionID}); err != nil {
		log.Warn("failed to send banner hide", "sessionId", sessionID, "error", err.Error())
	}
}

// handleConsentSessionEnd fires the ended notice + banner-hide for a session that
// had a remembered prompt, then forgets the mapping. Called from the peer
// disconnect path (unconditionally, for every desktop session — prompted or
// not), so h.takeDesktopTarget runs first and unconditionally to release the
// entry set in handleStartDesktop regardless of whether a prompt is present.
// The notify/banner sends themselves are still a no-op when the session was
// never prompted. Routes to the same Windows session that was targeted at
// start, so the end-of-session UX lands with the same user who saw the
// consent prompt / start notice, not wherever the machine-global preference
// now points.
func (h *Heartbeat) handleConsentSessionEnd(sessionID string) {
	targetWinSession := h.takeDesktopTarget(sessionID)

	prompt := takeDesktopPrompt(sessionID)
	if prompt == nil {
		return
	}
	if prompt.ShowIndicator {
		h.sendBannerHide(sessionID, targetWinSession)
	}
	if prompt.NotifyOnEnd {
		h.sendSessionNotify("Remote session ended", targetWinSession)
	}
}

// consentMarkerFields is the structured consent record a consent-mode start
// result carries to the API (apps/api/src/routes/agentWs.ts
// desktopCommandResultSchema): the protocol, what happened to the prompt,
// whether anyone was signed in (only when that decided it), and a short
// machine-readable detail.
func consentMarkerFields(v consentVerdict) map[string]any {
	m := map[string]any{
		"consentProtocol": ipc.ConsentProtocolVersion,
		"consentOutcome":  v.outcome,
	}
	if v.occupancy != "" {
		m["consentOccupancy"] = v.occupancy
	}
	if v.detail != "" {
		m["consentDetail"] = v.detail
	}
	return m
}

// consentDeniedResult builds the command result the API ingests when consent is
// not granted. It is returned as a COMPLETED result (not failed) so the
// agent->WS conversion in HandleCommand carries the marker in the `result`
// field; a `failed` result drops the Stdout payload. The session is NOT started.
func consentDeniedResult(sessionID string, v consentVerdict, durationMs int64) tools.CommandResult {
	data := map[string]any{
		"sessionId": sessionID,
		"event":     "consent_denied",
		"reason":    v.reason,
	}
	for k, val := range consentMarkerFields(v) {
		data[k] = val
	}
	return tools.NewSuccessResult(data, durationMs)
}

// withConsentGranted re-marshals a successful helper start result to add the
// consent marker when the session passed a consent-mode gate: consentReason is
// "user" when the end user allowed it, "timeout" when a prompt they could see
// went unanswered, or "no_user_session" when nobody is signed in — the last
// two only under consentUnavailableBehavior "proceed". The API audits "user"
// as a user grant, so it never stands in for the others. For notify/off modes
// it returns the result unchanged.
func withConsentGranted(result tools.CommandResult, prompt *ipc.DesktopPrompt, v consentVerdict) tools.CommandResult {
	if prompt == nil || prompt.Mode != "consent" || result.Status != "completed" || result.Stdout == "" {
		return result
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(result.Stdout), &data); err != nil || data == nil {
		log.Warn("failed to decode start result for consent marker", "error", errString(err))
		return result
	}
	data["consentReason"] = v.reason
	for k, val := range consentMarkerFields(v) {
		data[k] = val
	}
	return tools.NewSuccessResult(data, result.DurationMs)
}

func connectedNotifyBody(prompt *ipc.DesktopPrompt) string {
	return technicianLine(prompt) + " connected to your computer"
}

func bannerLabel(prompt *ipc.DesktopPrompt) string {
	return technicianLine(prompt) + " is connected"
}

// technicianLine renders the who-is-this prefix: "Billy from Olive Technology",
// "Billy", "A technician from Olive Technology", or "A technician". The partner
// name is the trust anchor for the end user, so it is kept even when the
// identity level redacts the technician's name.
func technicianLine(prompt *ipc.DesktopPrompt) string {
	name := derefString(prompt.TechnicianName)
	org := derefString(prompt.OrgName)
	switch {
	case name != "" && org != "":
		return name + " from " + org
	case name != "":
		return name
	case org != "":
		return "A technician from " + org
	default:
		return "A technician"
	}
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

// sessionNoticeTarget picks the helper that draws the remote-session start/end
// notice. A non-empty targetWinSession resolves strictly inside that Windows
// session and prefers the user-role helper over the system-role one (#6864): the
// system-role helper runs as SYSTEM, where the Windows toast platform is not
// available, and it used to win here because the generic lookup ranks by
// LastSeen and the system-role helper is the one streaming the desktop. An
// empty target keeps the machine-global PreferredSessionWithScope, which
// already prefers the user role.
func (h *Heartbeat) sessionNoticeTarget(targetWinSession string) *sessionbroker.Session {
	if targetWinSession == "" {
		return h.sessionBroker.PreferredSessionWithScope("notify")
	}
	return h.sessionBroker.NotifySessionInWinSession(targetWinSession)
}

// sessionNoticeRequest builds the remote-session notice. It is a
// consent-visibility notice, so it asks the helper for a dialog when the toast
// cannot be shown (toasts can be disabled, suppressed by Focus Assist, or
// unavailable to the process). It carries no Actions: it is an announcement,
// not a prompt.
func sessionNoticeRequest(body string) ipc.NotifyRequest {
	return ipc.NotifyRequest{
		Title:          "Breeze Agent",
		Body:           body,
		Urgency:        "normal",
		FallbackDialog: true,
	}
}
