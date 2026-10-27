package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptidentity"
	"github.com/breeze-rmm/agent/internal/promptkinds"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/websocket"
)

// remote.consent and remote.session call sites (#10190 W06, plan Task 6.3).
//
// Each goes through the prompt host only when all three switches are on for
// the user's session (compatibility order step 2): this build constructs the
// kind (promptkinds.Register), a live renderer in that session advertised it,
// and the server enables it. Otherwise the call site makes exactly today's
// call: consent_request v2 (or v1 for an old Assist), banner_show.
//
// Consent keeps the v2 semantics end to end: the attempt this produces is the
// same consentAttempt the legacy exchange produces, and decideConsent plus
// consent_occupancy.go decide what it means. A renderer lost mid-consent is
// never asked again (KindSpec.NeverReask): the attempt is unavailable when it
// had not been on screen, unknown when it had.

// Renderer labels (spec §4 audit `renderer`).
const (
	consentRendererAssist = "assist"
	consentRendererNative = "native"
)

func consentRendererLabel(role ipc.HelperRole) string {
	if role == ipc.HelperRoleAssist {
		return consentRendererAssist
	}
	return consentRendererNative
}

// consentLostDetail maps the host's lost reason to the v2 detail the legacy
// exchange reports for the same event.
func consentLostDetail(reason string, presented bool) string {
	switch reason {
	case "renderer_gone":
		return "helper_disconnected"
	case "present_budget":
		return "no_presentation"
	case "send_failed":
		return "send_failed"
	case "render_failed":
		if presented {
			return "failed_after_presentation"
		}
		return "render_failed"
	}
	return "renderer_lost"
}

// showStamped shows a prompt with the MSP identity in force pinned on it,
// with no scope change in progress (see showNotice).
func (h *Heartbeat) showStamped(p *prompthost.Prompt) error {
	if h.promptIdentity == nil {
		return h.promptHost.Show(*p)
	}
	var err error
	h.promptIdentity.WithSettledIdentity(func(id promptidentity.Identity, ok bool) {
		stampIdentity(p, id, ok)
		err = h.promptHost.Show(*p)
	})
	return err
}

// solicitConsentPrompt asks for consent through the prompt host. ok is false
// when the prompt path is not available for routed's user (or the host
// would not take the prompt): the caller then makes today's call. routed is
// the helper today's call would use; its user's session is the owner.
func (h *Heartbeat) solicitConsentPrompt(ctx context.Context, routed *sessionbroker.Session, req ipc.ConsentRequest, cfg *ipc.DesktopPrompt) (consentAttempt, bool) {
	host := h.promptHost
	if host == nil || routed == nil || cfg == nil {
		return consentAttempt{}, false
	}
	owner := noticeOwner(routed)
	kind := promptkinds.RemoteConsentKind
	if !host.PromptPathAvailable(kind.Name, kind.Version, owner) {
		return consentAttempt{}, false
	}

	answers := make(chan consentAttempt, 1)
	settle := func(a consentAttempt) {
		select {
		case answers <- a:
		default: // the first answer wins; the host decides at most once
		}
	}
	var promptID string
	// drawnBy names the renderer that holds the prompt, while it is open.
	drawnBy := func(a *consentAttempt) {
		if info, ok := host.PlacementOf(promptID, owner); ok && info.Path == prompthost.PathPrompt {
			a.renderer = consentRendererLabel(info.Role)
			a.helper = h.sessionBroker.SessionByID(info.RendererKey)
		}
	}
	p := promptkinds.RemoteConsent(req, *cfg, promptkinds.ConsentHooks{
		Decided: func(actionID string, _ prompthost.Owner) {
			a := consentAttempt{outcome: ipc.ConsentOutcomeDenied}
			if actionID == "allow" {
				a.outcome = ipc.ConsentOutcomeGranted
			}
			drawnBy(&a)
			settle(a)
		},
		Expired: func() {
			a := consentAttempt{outcome: ipc.ConsentOutcomePresentedExpired}
			drawnBy(&a)
			settle(a)
		},
		Lost: func(info prompthost.PlacementInfo, reason string) {
			a := consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: consentLostDetail(reason, info.Presented)}
			if info.Presented {
				// It was on screen: the answer may have been Deny.
				a.outcome = consentOutcomeUnknown
			}
			a.renderer = consentRendererLabel(info.Role)
			settle(a)
		},
	})
	promptID = p.ID
	p.Owners = []prompthost.Owner{owner}
	if err := h.showStamped(&p); err != nil {
		log.Warn("consent prompt not shown through the prompt host; sending today's request", "promptId", p.ID, "error", err.Error())
		return consentAttempt{}, false
	}
	finish := func(a consentAttempt) (consentAttempt, bool) {
		if a.helper == nil {
			a.helper = routed
		}
		log.Info("consent prompt answered through the prompt host", "promptId", promptID, "outcome", a.outcome, "detail", a.detail, "renderer", a.renderer)
		return a, true
	}
	if info, ok := host.PlacementOf(promptID, owner); !ok || info.Path != prompthost.PathPrompt {
		select {
		case a := <-answers:
			return finish(a) // decided (or lost) already
		default:
		}
		// Nothing was drawn (the renderer went away, or another modal holds
		// the session): withdraw it, and ask today's way.
		_ = host.Close(promptID, ipc.PromptCloseWithdrawn)
		log.Info("consent prompt had no prompt renderer after all; sending today's request", "promptId", promptID)
		return consentAttempt{}, false
	}

	// The host times presentation (10 s) and the response window itself;
	// this bound only guards against a callback that never comes.
	bound := time.NewTimer(consentPresentBudget + time.Duration(req.TimeoutMs+consentTimeoutGraceMs)*time.Millisecond)
	defer bound.Stop()
	select {
	case a := <-answers:
		return finish(a)
	case <-ctx.Done():
		log.Info("consent prompt withdrawn: the session ended", "promptId", promptID)
		_ = host.Close(promptID, ipc.PromptCloseWithdrawn)
		return finish(consentAttempt{outcome: consentOutcomeUnknown, detail: consentDetailSessionEnded})
	case <-bound.C:
		a := consentAttempt{outcome: ipc.ConsentOutcomeUnavailable, detail: "no_presentation"}
		if info, ok := host.PlacementOf(promptID, owner); ok && info.Presented {
			a = consentAttempt{outcome: consentOutcomeUnknown, detail: "no_answer", renderer: consentRendererLabel(info.Role)}
		}
		log.Warn("consent prompt produced no answer in time; withdrawing it", "promptId", promptID, "detail", a.detail)
		_ = host.Close(promptID, ipc.PromptCloseWithdrawn)
		select {
		case late := <-answers:
			return finish(late)
		default:
		}
		return finish(a)
	}
}

// showSessionIndicator shows the remote-session indicator for sessionID.
// Legacy: today's banner_show to the consent-UI helper.
func (h *Heartbeat) showSessionIndicator(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string) {
	legacy := func() { h.sendBannerShow(sessionID, prompt, targetWinSession) }
	host := h.promptHost
	if host == nil || h.sessionBroker == nil || prompt == nil {
		legacy()
		return
	}
	session := h.consentUISessionForTarget(targetWinSession)
	if session == nil {
		legacy() // logs that no helper can show it, as today
		return
	}
	owner := noticeOwner(session)
	kind := promptkinds.RemoteSessionKind
	if !host.PromptPathAvailable(kind.Name, kind.Version, owner) {
		legacy()
		return
	}
	p := promptkinds.RemoteSession(sessionID, *prompt, time.Now(), promptkinds.SessionHooks{
		EndConfirmed: func() { h.endDesktopSessionByUser(sessionID) },
		ReportProblem: func(prompthost.Owner) {
			log.Info("the person at the keyboard chose Report a problem on the session indicator", "sessionId", sessionID)
		},
	})
	p.Owners = []prompthost.Owner{owner}
	// The host's fallback (a renderer that cannot draw it in time) is
	// today's banner.
	p.Legacy = func(prompthost.Owner) error { legacy(); return nil }
	// Not pinned to an MSP scope (no identityRef): a scope change closes the
	// prompts of the old scope, and the person must keep seeing that a
	// technician is connected for as long as the session runs.
	if err := host.Show(p); err != nil {
		// Including a tombstone (a session id reused within 24 h): the
		// person must still see that someone is connected.
		log.Info("session indicator not shown through the prompt host; sending today's banner", "promptId", p.ID, "error", err.Error())
		legacy()
	}
}

// closeSessionIndicator takes the indicator down when its session ends.
func (h *Heartbeat) closeSessionIndicator(sessionID string) {
	if h.promptHost == nil {
		return
	}
	id := promptkinds.RemoteSessionPromptID(sessionID)
	if err := h.promptHost.Close(id, ipc.PromptCloseResolved); err != nil && !errors.Is(err, prompthost.ErrUnknownPrompt) {
		log.Warn("session indicator not closed", "promptId", id, "error", err.Error())
	}
}

// desktopUserEndSender delivers the desk-userend result to the API (a var so
// tests observe it and its order against the stop).
var desktopUserEndSender = func(h *Heartbeat, r websocket.CommandResult) error {
	if h.wsClient == nil {
		return errors.New("no websocket client")
	}
	return h.wsClient.SendResult(r)
}

// desktopUserEndResult is the W06 contract's report that the person at the
// keyboard ended the session. It is its own result (the desk-clipsum
// precedent): the desk-* result object is strict on the API, so a new field
// on desk-disconnect would make an older API drop the disconnect itself. An
// older API drops this one instead, and the session still ends normally.
func desktopUserEndResult(sessionID string) websocket.CommandResult {
	return websocket.CommandResult{
		Type:      "command_result",
		CommandID: "desk-userend-" + sessionID,
		Status:    "completed",
		Result:    map[string]any{"event": "ended_by_user", "sessionId": sessionID},
	}
}

// endDesktopSessionByUser ends a session the person confirmed ending from
// the indicator: it reports ended_by_user FIRST, then runs exactly the stop
// routine the server's stop_desktop command runs (which ends the capture
// and sends the normal desk-disconnect result). It runs off the caller's
// goroutine: the stop can wait 10 s on the capture helper, and the prompt
// host serializes decisions.
func (h *Heartbeat) endDesktopSessionByUser(sessionID string) {
	if !desktopSessionIDPattern.MatchString(sessionID) {
		log.Warn("refusing to end a desktop session with an invalid session ID", "sessionId", sessionID)
		return
	}
	go func() {
		defer func() {
			if r := recover(); r != nil {
				log.Error("panic ending a desktop session for the user", "error", fmt.Sprint(r))
			}
		}()
		log.Info("the person at the keyboard ended the remote session", "sessionId", sessionID)
		if err := desktopUserEndSender(h, desktopUserEndResult(sessionID)); err != nil {
			log.Warn("failed to report that the user ended the session; ending it anyway", "sessionId", sessionID, "error", err.Error())
		}
		result := handleStopDesktop(h, Command{
			ID:      "desk-stop-" + sessionID,
			Type:    tools.CmdStopDesktop,
			Payload: map[string]any{"sessionId": sessionID},
		})
		if result.Status != "completed" {
			log.Warn("failed to stop the desktop session the user ended", "sessionId", sessionID, "error", result.Error)
		}
	}()
}
