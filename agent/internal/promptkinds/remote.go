package promptkinds

import (
	"errors"
	"fmt"
	"strings"
	"sync/atomic"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// remote.consent@1 and remote.session@1 constructors (#10190 W06, plan Task
// 6.3, spec §3.5).
//
// Consent asks the person at the keyboard whether a technician may start a
// remote session: Deny is the one safe action and the default, so Esc and
// the close box answer Deny on every renderer. Expiry is the agent's timer;
// what an expiry means stays with the consent v2 decision matrix
// (heartbeat/consent.go, consent_occupancy.go). A consent whose renderer is
// lost is never asked again (KindSpec.NeverReask).
//
// The session indicator is the pill shown while a session runs. It is never
// a decision, and it is Reshowable: it closes withdrawn when the session
// stops, so a reconnect on the same session id shows it again. It offers End session only when the remote access policy
// allows it (DesktopPrompt.AllowUserEndSession), always behind a confirm
// step, and Report a problem, which Breeze Assist turns into its Request
// Support flow.
//
// Every string is catalog copy in the session's locale; the only server
// strings are the technician's name and email and the MSP name the server
// already redacted per technician_identity_level.

const (
	actionAllow         = "allow"
	actionDeny          = "deny"
	actionEndSession    = "end_session"
	actionReportProblem = "report_problem"
	actionEndConfirm    = "end_confirm"
	actionKeepSession   = "keep_session"

	remoteNamespace = "remote"

	// consentPresentWithinMs is the consent present budget (the v2
	// exchange's consentPresentBudgetMs, mirrored by the API's
	// AGENT_CONSENT_PRESENT_BUDGET_MS).
	consentPresentWithinMs = 10_000
	sessionPresentWithinMs = 10_000
	// maxConsentResponseMs is the contract's response budget cap.
	maxConsentResponseMs = 24 * 60 * 60 * 1000
	// maxEmailRunes caps a technician email shown as a fact.
	maxEmailRunes = 254
)

// RemoteConsentKind is remote.consent@1. Consent is never deferred behind a
// lock screen (the occupancy rules decide what an unseen prompt means) and
// never moved to a second renderer.
var RemoteConsentKind = prompthost.KindSpec{
	Name:            "remote.consent",
	Version:         1,
	ShowWhileLocked: true,
	NeverReask:      true,
	Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
		ipc.PromptStatePending: {
			actionAllow: ipc.PromptStateApproved,
			actionDeny:  ipc.PromptStateDenied,
		},
	},
}

// RemoteSessionKind is remote.session@1. Confirming End session is an
// action-set swap inside pending (states are closed), so every action keeps
// the state; the domain decides what each one does.
var RemoteSessionKind = prompthost.KindSpec{
	Name:    "remote.session",
	Version: 1,
	Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
		ipc.PromptStatePending: {
			actionEndSession:    ipc.PromptStatePending,
			actionReportProblem: ipc.PromptStatePending,
			actionEndConfirm:    ipc.PromptStatePending,
			actionKeepSession:   ipc.PromptStatePending,
		},
	},
}

var errRemoteAction = errors.New("promptkinds: action not offered by this prompt")

// ConsentHooks are the consent domain's callbacks. Each may be nil.
type ConsentHooks struct {
	// Decided runs when the person answered (allow or deny), once the host
	// accepted the action.
	Decided func(actionID string, from prompthost.Owner)
	// Expired runs when the response window ran out on screen.
	Expired func()
	// Lost runs when the renderer was lost and the prompt withdrawn; it is
	// never asked again.
	Lost func(info prompthost.PlacementInfo, reason string)
}

// identity is the technician identity the server sent, sanitized for a
// prompt: plain text, capped, and never read as a renderer placeholder.
type identity struct{ name, email, org string }

func remoteIdentity(name, email, org string) identity {
	return identity{
		name:  promptText(name, maxTechnicianRunes),
		email: promptText(email, maxEmailRunes),
		org:   promptText(org, maxTechnicianRunes),
	}
}

// promptText sanitizes a server string for a breeze-class prompt. The
// renderer fills {remaining} and {time:<unixMs>} itself, so a brace in a
// name is replaced by its full-width form after normalization (which would
// otherwise fold it back).
func promptText(raw string, max int) string {
	s := capRunes(promptcatalog.SanitizeIdentityName(raw), max)
	return strings.NewReplacer("{", "｛", "}", "｝").Replace(s)
}

// render picks one of four catalog keys by which identity parts are known.
func (id identity) render(loc promptcatalog.Locale, named, from, orgOnly, generic string) (string, error) {
	switch {
	case id.name != "" && id.org != "":
		return promptcatalog.Render(loc, remoteNamespace, from, map[string]string{"technician": id.name, "organization": id.org})
	case id.name != "":
		return promptcatalog.Render(loc, remoteNamespace, named, map[string]string{"technician": id.name})
	case id.org != "":
		return promptcatalog.Render(loc, remoteNamespace, orgOnly, map[string]string{"organization": id.org})
	}
	return promptcatalog.Render(loc, remoteNamespace, generic, nil)
}

// facts lists the identity parts the server sent, each as one fact.
func (id identity) facts(loc promptcatalog.Locale) ([]ipc.PromptFact, error) {
	var out []ipc.PromptFact
	for _, f := range []struct{ key, value string }{
		{"fact.technician", id.name},
		{"fact.email", id.email},
		{"fact.organization", id.org},
	} {
		if f.value == "" {
			continue
		}
		label, err := promptcatalog.Render(loc, remoteNamespace, f.key, nil)
		if err != nil {
			return nil, err
		}
		out = append(out, ipc.PromptFact{Label: label, Value: f.value})
	}
	return out, nil
}

// RemoteConsent builds the consent prompt for one start (id
// consent:<nonce>). The response window is the start's consentTimeoutMs,
// counted from presentation; the consequence sentence follows
// consentUnavailableBehavior.
func RemoteConsent(req ipc.ConsentRequest, cfg ipc.DesktopPrompt, hooks ConsentHooks) prompthost.Prompt {
	id := remoteIdentity(req.TechnicianName, req.TechnicianEmail, req.OrgName)
	if id.name == "" && id.org == "" {
		// The request carries what the start's prompt block carried; use the
		// block when the request is empty (same server fields).
		id = remoteIdentity(derefString(cfg.TechnicianName), derefString(cfg.TechnicianEmail), derefString(cfg.OrgName))
	}
	timeoutMs := req.TimeoutMs
	if timeoutMs < 0 {
		timeoutMs = 0
	}
	if timeoutMs > maxConsentResponseMs {
		timeoutMs = maxConsentResponseMs
	}
	expiryKey := "consent.expiryBlock"
	if req.OnTimeout == "proceed" {
		expiryKey = "consent.expiryProceed"
	}
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := promptcatalog.Render(loc, remoteNamespace, "consent.title", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		body, err := id.render(loc, "consent.body", "consent.bodyFrom", "consent.bodyOrganization", "consent.bodyGeneric")
		if err != nil {
			return prompthost.Localized{}, err
		}
		facts, err := id.facts(loc)
		if err != nil {
			return prompthost.Localized{}, err
		}
		labels, err := renderLabels(loc, map[string]string{actionAllow: "action.allow", actionDeny: "action.deny"})
		if err != nil {
			return prompthost.Localized{}, err
		}
		l := prompthost.Localized{Copy: ipc.PromptCopy{Title: title, Body: body}, Facts: facts, ActionLabels: labels}
		if timeoutMs > 0 {
			if l.ExpiryText, err = promptcatalog.Render(loc, remoteNamespace, expiryKey, nil); err != nil {
				return prompthost.Localized{}, err
			}
		}
		return l, nil
	}
	promptID := "consent:" + promptIDPart(req.Nonce)
	show := ipc.PromptShow{
		PromptID:     promptID,
		Kind:         RemoteConsentKind.Name,
		KindVersion:  RemoteConsentKind.Version,
		State:        ipc.PromptStatePending,
		Presentation: ipc.PromptPresentationModal,
		Actions: []ipc.PromptAction{
			{ID: actionDeny, Label: actionDeny, Role: ipc.PromptRoleSafe},
			{ID: actionAllow, Label: actionAllow, Role: ipc.PromptRoleProceed},
		},
		DefaultActionID: actionDeny,
		Timing:          ipc.PromptTiming{PresentWithinMs: consentPresentWithinMs, ResponseMs: int64(timeoutMs)},
		Focus:           ipc.PromptFocusSteal,
		// Every real consent prompt is also in the notification list, which
		// a lookalike window cannot write to (spec §5).
		ListEntry: ipc.PromptListEntry{Persistent: true},
		Locale:    string(promptcatalog.LocaleEN),
		Direction: "ltr",
	}
	if timeoutMs > 0 {
		show.Timing.Expiry = &ipc.PromptExpiry{} // text filled below; no action: expiry is never a click
	}
	applyEN(&show, localize)
	onAction := func(actionID string, from prompthost.Owner) (prompthost.ActionOutcome, error) {
		if actionID != actionAllow && actionID != actionDeny {
			return prompthost.ActionOutcome{}, errRemoteAction
		}
		if hooks.Decided != nil {
			hooks.Decided(actionID, from)
		}
		// The kind's transition table moves it to approved / denied; it
		// lingers there, then closes resolved.
		return prompthost.ActionOutcome{Accepted: true}, nil
	}
	return prompthost.Prompt{
		ID:       promptID,
		Kind:     RemoteConsentKind,
		Show:     show,
		OnAction: onAction,
		OnExpire: func() {
			if hooks.Expired != nil {
				hooks.Expired()
			}
		},
		OnRendererLost: func(info prompthost.PlacementInfo, reason string) {
			if hooks.Lost != nil {
				hooks.Lost(info, reason)
			}
		},
		Localize: localize,
	}
}

// SessionHooks are the session indicator's callbacks. Each may be nil.
type SessionHooks struct {
	// EndConfirmed runs once the person confirmed End session (and only
	// when the policy allows it). The caller reports ended_by_user, then
	// stops the session the way stop_desktop does.
	EndConfirmed func()
	// ReportProblem runs when the person chose Report a problem.
	ReportProblem func(from prompthost.Owner)
}

// RemoteSession builds the indicator for one remote session (id
// session:<sessionID>). It lives until the session ends.
func RemoteSession(sessionID string, cfg ipc.DesktopPrompt, startedAt time.Time, hooks SessionHooks) prompthost.Prompt {
	id := remoteIdentity(derefString(cfg.TechnicianName), "", derefString(cfg.OrgName))
	allowEnd := cfg.AllowUserEndSession
	var startedToken string
	if !startedAt.IsZero() {
		startedToken = fmt.Sprintf("{time:%d}", startedAt.UnixMilli())
	}
	// confirming is the confirm step's flag: read by Localize under the
	// host's lock, written by actions (serialized by the host).
	var confirming atomic.Bool

	normalActions := func() []ipc.PromptAction {
		var out []ipc.PromptAction
		if allowEnd {
			out = append(out, ipc.PromptAction{ID: actionEndSession, Label: actionEndSession, Role: ipc.PromptRoleNeutral})
		}
		return append(out, ipc.PromptAction{ID: actionReportProblem, Label: actionReportProblem, Role: ipc.PromptRoleNeutral})
	}
	confirmActions := func() []ipc.PromptAction {
		return []ipc.PromptAction{
			{ID: actionKeepSession, Label: actionKeepSession, Role: ipc.PromptRoleSafe},
			{ID: actionEndConfirm, Label: actionEndConfirm, Role: ipc.PromptRoleProceed},
		}
	}
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := id.render(loc, "session.title", "session.titleFrom", "session.titleOrganization", "session.titleGeneric")
		if err != nil {
			return prompthost.Localized{}, err
		}
		body, err := promptcatalog.Render(loc, remoteNamespace, "session.body", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		c := ipc.PromptCopy{Title: title, Body: body}
		if confirming.Load() {
			if c.StateDetail, err = promptcatalog.Render(loc, remoteNamespace, "session.confirmEnd", nil); err != nil {
				return prompthost.Localized{}, err
			}
		}
		facts, err := id.facts(loc)
		if err != nil {
			return prompthost.Localized{}, err
		}
		if startedToken != "" {
			label, err := promptcatalog.Render(loc, remoteNamespace, "fact.started", nil)
			if err != nil {
				return prompthost.Localized{}, err
			}
			facts = append(facts, ipc.PromptFact{Label: label, Value: startedToken})
		}
		labels, err := renderLabels(loc, map[string]string{
			actionEndSession:    "action.endSession",
			actionReportProblem: "action.reportProblem",
			actionEndConfirm:    "action.endSession",
			actionKeepSession:   "action.keepSession",
		})
		if err != nil {
			return prompthost.Localized{}, err
		}
		return prompthost.Localized{Copy: c, Facts: facts, ActionLabels: labels}, nil
	}
	promptID := RemoteSessionPromptID(sessionID)
	show := ipc.PromptShow{
		PromptID:     promptID,
		Kind:         RemoteSessionKind.Name,
		KindVersion:  RemoteSessionKind.Version,
		State:        ipc.PromptStatePending,
		Presentation: ipc.PromptPresentationIndicator,
		Actions:      normalActions(),
		Timing:       ipc.PromptTiming{PresentWithinMs: sessionPresentWithinMs},
		Focus:        ipc.PromptFocusNoActivate,
		Locale:       string(promptcatalog.LocaleEN),
		Direction:    "ltr",
	}
	applyEN(&show, localize)

	// patchTo swaps the action set (and the confirm sentence) in place.
	patchTo := func(confirm bool) *prompthost.Patch {
		confirming.Store(confirm)
		actions, def := normalActions(), ""
		if confirm {
			actions, def = confirmActions(), actionKeepSession
		}
		p := &prompthost.Patch{Actions: &actions, DefaultActionID: def, Relocalize: true}
		if l, err := localize(promptcatalog.LocaleEN); err == nil {
			p.Copy = &l.Copy
			for i := range actions {
				if label, ok := l.ActionLabels[actions[i].ID]; ok {
					actions[i].Label = label
				}
			}
		}
		return p
	}
	refuse := prompthost.ActionOutcome{Accepted: false}
	onAction := func(actionID string, from prompthost.Owner) (prompthost.ActionOutcome, error) {
		switch actionID {
		case actionEndSession:
			if !allowEnd || confirming.Load() {
				return refuse, nil
			}
			return prompthost.ActionOutcome{Accepted: true, Patch: patchTo(true)}, nil
		case actionKeepSession:
			if !confirming.Load() {
				return refuse, nil
			}
			return prompthost.ActionOutcome{Accepted: true, Patch: patchTo(false)}, nil
		case actionEndConfirm:
			if !allowEnd || !confirming.Load() {
				return refuse, nil
			}
			if hooks.EndConfirmed != nil {
				hooks.EndConfirmed()
			}
			// Withdrawn, not resolved: the session stopped, nothing was
			// decided, and the id must stay showable (Reshowable).
			withdrawn := ipc.PromptCloseWithdrawn
			return prompthost.ActionOutcome{Accepted: true, Close: &withdrawn}, nil
		case actionReportProblem:
			if hooks.ReportProblem != nil {
				hooks.ReportProblem(from)
			}
			// Accepted, no state change: Assist opens Request Support.
			return prompthost.ActionOutcome{Accepted: true}, nil
		}
		return prompthost.ActionOutcome{}, errRemoteAction
	}
	return prompthost.Prompt{
		ID:       promptID,
		Kind:     RemoteSessionKind,
		Show:     show,
		OnAction: onAction,
		Localize: localize,
		// A viewer reconnect re-offers on the same session id, and its new
		// start must get the pill again: the indicator closes withdrawn
		// (never tombstoned) on every stop path.
		Reshowable: true,
	}
}

// RemoteSessionPromptID is the indicator's prompt id for a session, so the
// session's end can close it.
func RemoteSessionPromptID(sessionID string) string {
	return "session:" + promptIDPart(sessionID)
}

func renderLabels(loc promptcatalog.Locale, keys map[string]string) (map[string]string, error) {
	out := make(map[string]string, len(keys))
	for action, key := range keys {
		label, err := promptcatalog.Render(loc, remoteNamespace, key, nil)
		if err != nil {
			return nil, err
		}
		out[action] = label
	}
	return out, nil
}

// applyEN fills a show's copy, facts, labels and expiry text from its en
// rendering. A render failure leaves an empty title, which the host refuses
// at Show, so the caller takes its legacy call (the catalog is embedded and
// tested, so that is a build defect).
func applyEN(show *ipc.PromptShow, localize func(promptcatalog.Locale) (prompthost.Localized, error)) {
	l, err := localize(promptcatalog.LocaleEN)
	if err != nil {
		log.Error("remote prompt copy could not be rendered; it will take its legacy path", "promptId", show.PromptID, "error", err.Error())
		return
	}
	show.Copy, show.Facts = l.Copy, l.Facts
	for i := range show.Actions {
		if label, ok := l.ActionLabels[show.Actions[i].ID]; ok {
			show.Actions[i].Label = label
		}
	}
	if show.Timing.Expiry != nil {
		show.Timing.Expiry.Text = l.ExpiryText
	}
}

func derefString(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
