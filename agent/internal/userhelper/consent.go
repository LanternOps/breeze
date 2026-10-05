package userhelper

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// maxConsentTimeoutMs caps the dialog countdown at 10 minutes; the API sends
// 30s today, the cap only guards against a hostile/buggy daemon payload.
const maxConsentTimeoutMs = 600_000

// dialogOutcome is what a native consent dialog reports.
type dialogOutcome int

const (
	// dialogUnavailable is the zero value: a dialog that never reported
	// anything was not shown.
	dialogUnavailable dialogOutcome = iota
	dialogAllowed
	dialogDenied
	// dialogExpired means the OS showed the dialog and its own countdown ran
	// out (MessageBoxTimeoutW's timeout code, zenity exit 5, osascript
	// "gave up:true"). Every platform only reports it for a dialog that was
	// actually displayed.
	dialogExpired
)

// wireValue is the v2 ConsentResult.Outcome for this dialog outcome.
func (o dialogOutcome) wireValue() string {
	switch o {
	case dialogAllowed:
		return ipc.ConsentOutcomeGranted
	case dialogDenied:
		return ipc.ConsentOutcomeDenied
	case dialogExpired:
		return ipc.ConsentOutcomePresentedExpired
	default:
		return ipc.ConsentOutcomeUnavailable
	}
}

// consentDetailPromptInProgress is the v2 unavailable detail for a prompt
// refused because another one is already on screen.
const consentDetailPromptInProgress = "prompt_in_progress"

// consentProtocolForAuth is the consent exchange this helper advertises at
// auth: v2 when it can render the native dialog, nothing otherwise.
func consentProtocolForAuth(consentUISupported bool) int {
	if consentUISupported {
		return ipc.ConsentProtocolVersion
	}
	return 0
}

// showConsentDialogFn is the platform dialog seam; tests swap it for a fake.
// It blocks until the user answers, the countdown expires, or ctx is
// cancelled. presented is
// called once, immediately before the OS is asked to display the dialog (after
// every step that can fail without showing anything); the v2 handler turns it
// into the consent_presented acknowledgement. An implementation that fails
// before that point returns dialogUnavailable without calling it.
//
// ctx is cancelled when the agent withdraws the prompt (consent_cancel); the
// platform dialog closes itself then.
var showConsentDialogFn = showConsentDialogOS

// consentDetailCancelled is the v2 unavailable detail for a prompt the agent
// withdrew before it was answered.
const consentDetailCancelled = "cancelled"

// handleConsentRequest renders the native consent dialog and replies on the
// same envelope ID — the wire contract the Tauri assist helper also implements
// (apps/helper/src-tauri/src/ipc/consent.rs).
//
// A v2 request (ProtocolVersion >= 2 with a Nonce) gets a consent_presented
// acknowledgement once the dialog is going up, then one consent_result
// {nonce, outcome}. A v1 request (older agent) gets the legacy
// {"decision": "allow"|"deny"} reply.
//
// This handler is dispatched via safeGo (client.go), which recovers panics
// but sends nothing back to the daemon. The most panic-prone code here is the
// raw Win32 MessageBoxTimeoutW syscall path. So handleConsentRequest
// guarantees a reply on every exit path, including its own panic recovery: an
// error reply, which the agent never treats as a grant.
func (c *Client) handleConsentRequest(env *ipc.Envelope) {
	replied := false
	releaseGuard := func() {}
	defer func() {
		releaseGuard()
		if r := recover(); r != nil {
			log.Error("consent handler panicked", "id", env.ID, "panic", fmt.Sprintf("%v", r))
			_ = c.conn.SendError(env.ID, ipc.TypeConsentResult, "consent handler panicked")
			return
		}
		if !replied {
			// Any non-panic path that fell through without a reply also fails closed.
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

	if req.ProtocolVersion < ipc.ConsentProtocolVersion || req.Nonce == "" {
		outcome := showConsentDialogFn(context.Background(), req, func() {})
		decision, isErr := legacyConsentDecision(outcome, req.OnTimeout)
		log.Info("consent dialog decided", "sessionId", req.SessionID, "outcome", outcome.wireValue(), "protocol", 1)
		if isErr {
			_ = c.conn.SendError(env.ID, ipc.TypeConsentResult, "consent dialog could not be shown")
			replied = true
			return
		}
		if err := c.conn.SendTyped(env.ID, ipc.TypeConsentResult, ipc.ConsentResult{Decision: decision}); err != nil {
			log.Warn("failed to send consent result", "id", env.ID, "error", err)
			return
		}
		replied = true
		return
	}

	reply := func(outcome, detail string) {
		res := ipc.ConsentResult{Nonce: req.Nonce, Outcome: outcome, Detail: detail}
		if err := c.conn.SendTyped(env.ID, ipc.TypeConsentResult, res); err != nil {
			log.Warn("failed to send consent result", "id", env.ID, "error", err)
			return
		}
		replied = true
	}

	if !c.consentPromptActive.CompareAndSwap(false, true) {
		log.Warn("consent prompt refused: another prompt is on screen", "sessionId", req.SessionID)
		reply(ipc.ConsentOutcomeUnavailable, consentDetailPromptInProgress)
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c.setActiveConsent(req.Nonce, cancel)
	releaseGuard = func() {
		c.setActiveConsent("", nil)
		cancel()
		c.consentPromptActive.Store(false)
	}

	acked := false
	outcome := showConsentDialogFn(ctx, req, func() {
		if acked {
			return
		}
		acked = true
		if err := c.conn.SendTyped(env.ID, ipc.TypeConsentPresented, ipc.ConsentPresented{Nonce: req.Nonce}); err != nil {
			log.Warn("failed to send consent presentation ack", "id", env.ID, "error", err)
		}
	})
	// Free the prompt slot before answering, so a request the agent sends
	// right after reading this result is not refused as "in progress".
	cancelled := ctx.Err() != nil
	releaseGuard()
	releaseGuard = func() {}
	if cancelled {
		log.Info("consent dialog withdrawn by the agent", "sessionId", req.SessionID)
		reply(ipc.ConsentOutcomeUnavailable, consentDetailCancelled)
		return
	}
	log.Info("consent dialog decided", "sessionId", req.SessionID, "outcome", outcome.wireValue(), "protocol", ipc.ConsentProtocolVersion)
	reply(outcome.wireValue(), "")
}

// setActiveConsent records (or clears, with nonce "") the v2 prompt on screen
// and how to take it down.
func (c *Client) setActiveConsent(nonce string, cancel context.CancelFunc) {
	c.consentMu.Lock()
	c.consentNonce, c.consentCancel = nonce, cancel
	c.consentMu.Unlock()
}

// handleConsentCancel closes the dialog for the nonce the agent withdrew.
// A cancel for any other prompt is ignored.
func (c *Client) handleConsentCancel(env *ipc.Envelope) {
	var req ipc.ConsentCancel
	if err := json.Unmarshal(env.Payload, &req); err != nil || req.Nonce == "" {
		return
	}
	c.consentMu.Lock()
	cancel := c.consentCancel
	match := c.consentNonce == req.Nonce
	c.consentMu.Unlock()
	if match && cancel != nil {
		cancel()
	}
}

// legacyConsentDecision maps a dialog outcome to the v1 wire decision for an
// older agent. A click is reported as-is and an expired countdown keeps the v1
// policy verdict (what those agents expect). A dialog that could not be shown
// is reported as an error (isErr) — v1 agents fail closed on it — instead of
// the fake decision earlier helpers sent. Unknown onTimeout fails closed.
func legacyConsentDecision(outcome dialogOutcome, onTimeout string) (decision string, isErr bool) {
	switch outcome {
	case dialogAllowed:
		return "allow", false
	case dialogDenied:
		return "deny", false
	case dialogExpired:
		if onTimeout == "proceed" {
			return "allow", false
		}
		return "deny", false
	default:
		return "", true
	}
}

// classifyMessageBoxReturn maps MessageBoxTimeoutW's return value (Windows).
// Only IDYES/IDNO are user answers and 32000 is the box's own timeout; 0 is a
// failed call — nothing was shown — and anything else is unexpected from a
// Yes/No box. Neither of the latter is a user denial.
func classifyMessageBoxReturn(ret uintptr) dialogOutcome {
	switch ret {
	case consentIDYes:
		return dialogAllowed
	case consentIDNo:
		return dialogDenied
	case consentIDTimeout:
		return dialogExpired
	default:
		return dialogUnavailable
	}
}

const (
	consentIDYes     = 6
	consentIDNo      = 7
	consentIDTimeout = 32000 // MessageBoxTimeoutW's timeout return value
)

// classifyZenityExit maps a zenity --question run (Linux). started=false means
// zenity could not be launched. Exit 1 is Deny/close — except that GTK exits 1
// too when it cannot open the display, which is not a user decision.
func classifyZenityExit(exitCode int, started bool, stderr string) dialogOutcome {
	if !started {
		return dialogUnavailable
	}
	switch exitCode {
	case 0:
		return dialogAllowed
	case 1:
		if strings.Contains(strings.ToLower(stderr), "cannot open display") {
			return dialogUnavailable
		}
		return dialogDenied
	case 5:
		return dialogExpired
	default:
		return dialogUnavailable
	}
}

// classifyOsascriptResult maps an osascript `display dialog` run (macOS).
// failed=true is a non-zero exit: -128 is the user pressing Deny (the cancel
// button); anything else (no window server, osascript missing) means no
// dialog, not an expiry.
func classifyOsascriptResult(output string, failed bool) dialogOutcome {
	if failed {
		if strings.Contains(output, "-128") {
			return dialogDenied
		}
		return dialogUnavailable
	}
	switch {
	case strings.Contains(output, "gave up:true"):
		return dialogExpired
	case strings.Contains(output, "button returned:Allow"):
		return dialogAllowed
	default:
		return dialogUnavailable
	}
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
		if r < 0x20 || r == 0x7f || isBidiFormattingRune(r) {
			return -1
		}
		return r
	}, s)
}

// isBidiFormattingRune reports the bidirectional embedding, override and
// isolate characters (U+202A–U+202E, U+2066–U+2069), which reorder the text
// shown around them.
func isBidiFormattingRune(r rune) bool {
	return (r >= 0x202A && r <= 0x202E) || (r >= 0x2066 && r <= 0x2069)
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
