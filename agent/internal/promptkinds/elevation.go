package promptkinds

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// elevation.request@1 (#10190 W07, plan Task 7.2, spec §3.4): the stateful
// PAM elevation request.
//
// One prompt, id elevation:<requestId>, carries the whole request:
//
//   - pending, the first question ("Send a request to IT?"): a modal with
//     Cancel as the safe default. With UAC on the secure desktop only the
//     SYSTEM helper can be seen, so only it may draw it (Prompt.Roles);
//     otherwise Assist draws it next to UAC, the SYSTEM helper as fallback.
//     It is never re-asked (Prompt.NeverReask): a lost first question is
//     the same as today's dialog error.
//   - waiting, after Send request: a card on Assist only (Cancel request
//     safe, Hide neutral). It is placed again with a new lease (the SYSTEM
//     copy is fenced), and Assist restarts replay it.
//   - approved, failed, denied, expired, cancelled: terminal cards that
//     linger, then stay in the notification list.
//
// Every string is catalog copy rendered here; the only free strings are the
// program path, publisher and command line from the agent's own ETW capture,
// the partner name from the identity store, and the technician name and deny
// reason the server sent — each sanitized and capped, never read as markup or
// a renderer placeholder.

const (
	ActionSendRequest   = "send_request"
	ActionCancel        = "cancel"
	ActionCancelRequest = "cancel_request"
	ActionHide          = "hide"

	elevationNamespace = "elevation"

	// ElevationFirstQuestionMs is the first question's response window
	// (pamDialogTimeout, plan Global Constraints "Defaults").
	ElevationFirstQuestionMs     = 90_000
	elevationPresentWithinMs     = 10_000
	maxElevationProgramRunes     = 260
	maxElevationPublisherRunes   = 255
	maxElevationCommandLineRunes = 1024
	// maxElevationReasonRunes is the server's deny-reason cap (#8928).
	maxElevationReasonRunes = 500
)

// ElevationRequestKind is elevation.request@1. Every action keeps or moves
// the state the domain's patch names; the table only says which actions are
// valid in which state.
var ElevationRequestKind = prompthost.KindSpec{
	Name:    "elevation.request",
	Version: 1,
	Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
		ipc.PromptStatePending: {
			ActionSendRequest: ipc.PromptStateWaiting,
			ActionCancel:      ipc.PromptStateCancelled,
		},
		ipc.PromptStateWaiting: {
			ActionCancelRequest: ipc.PromptStateCancelled,
			ActionHide:          ipc.PromptStateWaiting,
		},
	},
}

// ElevationPromptID is the prompt id of one elevation request.
func ElevationPromptID(requestID string) string {
	return "elevation:" + promptIDPart(strings.ToLower(strings.TrimSpace(requestID)))
}

// FirstQuestionRoles are the renderer roles that may draw the first
// question. With UAC on the secure desktop (PromptOnSecureDesktop = 1, or
// the value missing) Assist cannot be seen, so only the SYSTEM helper draws
// it; with it off Assist draws it next to UAC and the SYSTEM helper is the
// fallback.
func FirstQuestionRoles(secureDesktop bool) []ipc.HelperRole {
	if secureDesktop {
		return []ipc.HelperRole{ipc.HelperRoleSystem}
	}
	return []ipc.HelperRole{ipc.HelperRoleAssist, ipc.HelperRoleSystem}
}

// waitingRoles: the waiting card and every outcome are Assist-only.
var waitingRoles = []ipc.HelperRole{ipc.HelperRoleAssist}

// ElevationParams describe one request.
type ElevationParams struct {
	RequestID   string
	ProgramPath string
	Publisher   string
	CommandLine string
	// Partner is the sanitized MSP name; "" uses the generic sentences.
	Partner string
	// FirstQuestionRoles (FirstQuestionRoles(secureDesktop)).
	FirstQuestionRoles []ipc.HelperRole
	// WaitingDeadline is when the server expires the pending request
	// (zero = unknown: the card states no time and has no deadline).
	WaitingDeadline time.Time
}

// ElevationHooks are the domain's callbacks. Each may be nil. They run
// outside the host's state lock, serialized with every other action.
type ElevationHooks struct {
	// Answered runs when the person answered the first question
	// (ActionSendRequest or ActionCancel) on a renderer of role, before the
	// host applies the answer: record it here, but do not act on it yet.
	Answered func(actionID string, role ipc.HelperRole)
	// AnswerApplied runs for the same answer once the host has applied and
	// sent it (the first question's renderer fenced or the card cancelled):
	// the domain acts on the answer from here, so its WaitingPatch can never
	// be overwritten by the answer's own patch (#10734).
	AnswerApplied func(actionID string, role ipc.HelperRole)
	// CancelRequest runs for Cancel request on the waiting card. false
	// refuses it (the request was decided meanwhile).
	CancelRequest func(role ipc.HelperRole) bool
	// Expired runs when the state's response window ran out on screen
	// (pending: the first question went unanswered; waiting: the server's
	// expiry passed).
	Expired func(state ipc.PromptState)
	// Lost runs when the first question's renderer was lost; it is never
	// asked again.
	Lost func(info prompthost.PlacementInfo, reason string)
}

// Elevation is one elevation prompt and the state its copy renders from.
type Elevation struct {
	id       string
	program  string
	pub      string
	cmdline  string
	partner  string
	deadline time.Time
	prompt   prompthost.Prompt

	mu   sync.Mutex
	view elevationView
}

type elevationView struct {
	state           ipc.PromptState
	technician      string
	reason          string
	dismissUnproven bool
}

var errElevationAction = errors.New("promptkinds: action not offered by this elevation prompt")

// elevationRender is a var so tests can make a key fail.
var elevationRender = promptcatalog.Render

// NewElevation builds the prompt for one request, in its first-question
// state.
func NewElevation(p ElevationParams, hooks ElevationHooks) *Elevation {
	e := &Elevation{
		id:       ElevationPromptID(p.RequestID),
		program:  factText(elevationProgramName(p.ProgramPath), maxElevationProgramRunes),
		pub:      factText(p.Publisher, maxElevationPublisherRunes),
		cmdline:  factText(p.CommandLine, maxElevationCommandLineRunes),
		partner:  promptText(p.Partner, maxTechnicianRunes),
		deadline: p.WaitingDeadline,
		view:     elevationView{state: ipc.PromptStatePending},
	}
	if e.program == "" {
		e.program = factText(p.ProgramPath, maxElevationProgramRunes)
	}
	show := ipc.PromptShow{
		PromptID:     e.id,
		Kind:         ElevationRequestKind.Name,
		KindVersion:  ElevationRequestKind.Version,
		State:        ipc.PromptStatePending,
		Presentation: ipc.PromptPresentationModal,
		Actions: []ipc.PromptAction{
			{ID: ActionCancel, Label: ActionCancel, Role: ipc.PromptRoleSafe},
			{ID: ActionSendRequest, Label: ActionSendRequest, Role: ipc.PromptRoleProceed},
		},
		DefaultActionID: ActionCancel,
		Timing: ipc.PromptTiming{PresentWithinMs: elevationPresentWithinMs, ResponseMs: ElevationFirstQuestionMs,
			Expiry: &ipc.PromptExpiry{}},
		// A modal answering something the person just did may take focus.
		Focus:     ipc.PromptFocusSteal,
		ListEntry: ipc.PromptListEntry{Persistent: true},
		Locale:    string(promptcatalog.LocaleEN),
		Direction: "ltr",
	}
	applyEN(&show, e.localize)

	refuse := prompthost.ActionOutcome{Accepted: false}
	// answer records a first-question answer now and hands it to the domain
	// once the host has applied patch (ActionOutcome.After).
	answer := func(actionID string, role ipc.HelperRole, patch prompthost.Patch) prompthost.ActionOutcome {
		if hooks.Answered != nil {
			hooks.Answered(actionID, role)
		}
		out := prompthost.ActionOutcome{Accepted: true, Patch: &patch}
		if hooks.AnswerApplied != nil {
			out.After = func() { hooks.AnswerApplied(actionID, role) }
		}
		return out
	}
	onAction := func(actionID string, _ prompthost.Owner, role ipc.HelperRole) (prompthost.ActionOutcome, error) {
		switch e.state() {
		case ipc.PromptStatePending:
			switch actionID {
			case ActionSendRequest:
				// Nobody draws it until the domain has dismissed the UAC
				// prompt and calls Update(WaitingPatch): the old renderer is
				// fenced now and never sees the waiting state.
				patch, err := e.patchTo(elevationView{state: ipc.PromptStateWaiting}, []ipc.HelperRole{})
				if err != nil {
					return refuse, err
				}
				return answer(actionID, role, patch), nil
			case ActionCancel:
				patch, err := e.patchTo(elevationView{state: ipc.PromptStateCancelled}, nil)
				if err != nil {
					return refuse, err
				}
				return answer(actionID, role, patch), nil
			}
		case ipc.PromptStateWaiting:
			switch actionID {
			case ActionHide:
				// Hiding is never a decision: no patch, the request stays.
				return prompthost.ActionOutcome{Accepted: true}, nil
			case ActionCancelRequest:
				if hooks.CancelRequest != nil && !hooks.CancelRequest(role) {
					return refuse, nil
				}
				patch, err := e.patchTo(elevationView{state: ipc.PromptStateCancelled}, nil)
				if err != nil {
					return refuse, err
				}
				return prompthost.ActionOutcome{Accepted: true, Patch: &patch}, nil
			}
		}
		return prompthost.ActionOutcome{}, errElevationAction
	}
	e.prompt = prompthost.Prompt{
		ID:               e.id,
		Kind:             ElevationRequestKind,
		Show:             show,
		OnActionRenderer: onAction,
		OnExpire: func() {
			if hooks.Expired != nil {
				hooks.Expired(e.state())
			}
		},
		OnRendererLost: func(info prompthost.PlacementInfo, reason string) {
			if hooks.Lost != nil {
				hooks.Lost(info, reason)
			}
		},
		Localize:   e.localize,
		Roles:      append([]ipc.HelperRole(nil), p.FirstQuestionRoles...),
		NeverReask: true,
	}
	if e.prompt.Roles == nil {
		e.prompt.Roles = FirstQuestionRoles(true)
	}
	return e
}

// ID is the prompt id.
func (e *Elevation) ID() string { return e.id }

// Prompt is the host prompt (the caller sets Owners).
func (e *Elevation) Prompt() prompthost.Prompt { return e.prompt }

func (e *Elevation) state() ipc.PromptState {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.view.state
}

// WaitingPatch places the waiting card on Assist with a new lease, once the
// domain has tried to dismiss the user's UAC prompt. dismissProven false
// says so on the card: the person may close the Windows prompt themselves.
func (e *Elevation) WaitingPatch(dismissProven bool) (prompthost.Patch, error) {
	return e.patchTo(elevationView{state: ipc.PromptStateWaiting, dismissUnproven: !dismissProven}, waitingRoles)
}

// OutcomePatch moves the prompt to a terminal state on Assist: approved
// (technician = the name the server sent, "" = none), failed, denied
// (reason = the server's deny reason), expired or cancelled. A first
// question still on screen is fenced (superseded by the decision).
func (e *Elevation) OutcomePatch(state ipc.PromptState, technician, reason string) (prompthost.Patch, error) {
	if !state.Terminal() {
		return prompthost.Patch{}, fmt.Errorf("promptkinds: %s is not an elevation outcome", state)
	}
	v := elevationView{state: state}
	switch state {
	case ipc.PromptStateApproved:
		v.technician = promptText(technician, maxTechnicianRunes)
	case ipc.PromptStateDenied:
		v.reason = factText(reason, maxElevationReasonRunes)
	}
	return e.patchTo(v, waitingRoles)
}

// patchTo renders v and returns the patch that shows it. roles nil keeps
// the prompt where it is; non-nil places it again under roles.
func (e *Elevation) patchTo(v elevationView, roles []ipc.HelperRole) (prompthost.Patch, error) {
	l, err := e.render(promptcatalog.LocaleEN, v)
	if err != nil {
		return prompthost.Patch{}, err
	}
	e.mu.Lock()
	e.view = v
	e.mu.Unlock()

	actions, def := []ipc.PromptAction{}, ""
	timing := ipc.PromptTiming{PresentWithinMs: elevationPresentWithinMs}
	switch v.state {
	case ipc.PromptStateWaiting:
		actions = []ipc.PromptAction{
			{ID: ActionCancelRequest, Label: ActionCancelRequest, Role: ipc.PromptRoleSafe},
			{ID: ActionHide, Label: ActionHide, Role: ipc.PromptRoleNeutral},
		}
		def = ActionHide
		if !e.deadline.IsZero() {
			timing.DeadlineUnixMs = e.deadline.UnixMilli()
			timing.Expiry = &ipc.PromptExpiry{Text: l.ExpiryText}
		}
	}
	for i := range actions {
		if label, ok := l.ActionLabels[actions[i].ID]; ok {
			actions[i].Label = label
		}
	}
	state := v.state
	facts := l.Facts
	copyV := l.Copy
	patch := prompthost.Patch{State: &state, Copy: &copyV, Facts: &facts, Actions: &actions, DefaultActionID: def, Timing: &timing, Relocalize: true}
	if roles != nil {
		// Placed again: every state after the first question is a card that
		// never takes focus, and is moved (not lost) when its renderer goes.
		pres, focus := ipc.PromptPresentationCard, ipc.PromptFocusNoActivate
		patch.Presentation, patch.Focus = &pres, &focus
		reask := false
		patch.NeverReask = &reask
		r := append([]ipc.HelperRole{}, roles...)
		patch.Roles = &r
	}
	return patch, nil
}

// localize renders the current state (Prompt.Localize: pure catalog work).
func (e *Elevation) localize(loc promptcatalog.Locale) (prompthost.Localized, error) {
	e.mu.Lock()
	v := e.view
	e.mu.Unlock()
	return e.render(loc, v)
}

func (e *Elevation) render(loc promptcatalog.Locale, v elevationView) (prompthost.Localized, error) {
	r := func(key string, params map[string]string) (string, error) {
		return elevationRender(loc, elevationNamespace, key, params)
	}
	// byPartner picks the named or the generic sentence.
	byPartner := func(key string, params map[string]string) (string, error) {
		if e.partner == "" {
			return r(key+"Generic", params)
		}
		p := map[string]string{"partner": e.partner}
		for k, val := range params {
			p[k] = val
		}
		return r(key, p)
	}
	prog := map[string]string{"program": e.program}
	until := ""
	if !e.deadline.IsZero() {
		until = fmt.Sprintf("{time:%d}", e.deadline.UnixMilli())
	}

	var (
		c          ipc.PromptCopy
		labels     = map[string]string{}
		expiryText string
		err        error
	)
	label := func(action, key string) {
		if err != nil {
			return
		}
		labels[action], err = r(key, nil)
	}
	switch v.state {
	case ipc.PromptStatePending:
		if c.Title, err = r("ask.title", nil); err == nil {
			if c.Body, err = byPartner("ask.body", prog); err == nil {
				expiryText, err = r("ask.expiry", nil)
			}
		}
		label(ActionSendRequest, "action.sendRequest")
		label(ActionCancel, "action.cancel")
	case ipc.PromptStateWaiting:
		if c.Title, err = byPartner("waiting.title", nil); err == nil {
			c.Body, err = r("waiting.body", prog)
		}
		switch {
		case err != nil:
		case v.dismissUnproven:
			c.StateDetail, err = byPartner("waiting.dismissUnproven", nil)
		case until != "":
			c.StateDetail, err = r("waiting.deadline", map[string]string{"until": until})
		}
		if err == nil && until != "" {
			expiryText, err = r("waiting.expiry", map[string]string{"until": until})
		}
		label(ActionCancelRequest, "action.cancelRequest")
		label(ActionHide, "action.hide")
	case ipc.PromptStateApproved:
		if c.Title, err = r("approved.title", nil); err == nil {
			switch {
			case v.technician != "" && e.partner != "":
				c.Body, err = r("approved.bodyFrom", map[string]string{"technician": v.technician, "partner": e.partner, "program": e.program})
			case v.technician != "":
				c.Body, err = r("approved.bodyTechnician", map[string]string{"technician": v.technician, "program": e.program})
			default:
				c.Body, err = byPartner("approved.body", prog)
			}
		}
	case ipc.PromptStateFailed:
		if c.Title, err = r("failed.title", nil); err == nil {
			c.Body, err = byPartner("failed.body", prog)
		}
	case ipc.PromptStateDenied:
		if c.Title, err = r("denied.title", nil); err == nil {
			c.Body, err = byPartner("denied.body", prog)
		}
	case ipc.PromptStateExpired:
		if c.Title, err = r("expired.title", nil); err == nil {
			c.Body, err = byPartner("expired.body", prog)
		}
	case ipc.PromptStateCancelled:
		if c.Title, err = r("cancelled.title", nil); err == nil {
			c.Body, err = r("cancelled.body", prog)
		}
	default:
		err = fmt.Errorf("promptkinds: no elevation copy for state %q", v.state)
	}
	if err != nil {
		return prompthost.Localized{}, err
	}
	facts, err := e.facts(r, v)
	if err != nil {
		return prompthost.Localized{}, err
	}
	return prompthost.Localized{Copy: c, Facts: facts, ActionLabels: labels, ExpiryText: expiryText}, nil
}

func (e *Elevation) facts(r func(string, map[string]string) (string, error), v elevationView) ([]ipc.PromptFact, error) {
	var out []ipc.PromptFact
	for _, f := range []struct{ key, value string }{
		{"fact.program", e.program},
		{"fact.publisher", e.pub},
		{"fact.commandLine", e.cmdline},
		{"fact.reason", v.reason},
	} {
		if f.value == "" {
			continue
		}
		label, err := r(f.key, nil)
		if err != nil {
			return nil, err
		}
		out = append(out, ipc.PromptFact{Label: label, Value: f.value})
	}
	return out, nil
}

// elevationProgramName is the base name of a Windows or Unix path.
func elevationProgramName(path string) string {
	p := strings.TrimSpace(path)
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		p = p[i+1:]
	}
	return strings.TrimSpace(p)
}

// factText makes a captured or server string safe as a fact value: line
// breaks and tabs become spaces, other control and format runes (bidi
// overrides, zero-width) are removed, a brace becomes its full-width form
// (a renderer fills {remaining} and {time:<ms>} in facts too), and the
// result is capped. Unlike an identity name it keeps mixed scripts: a path
// or a reason is not a name.
func factText(raw string, max int) string {
	var b strings.Builder
	for _, r := range raw {
		switch {
		case r == '\n' || r == '\r' || r == '\t' || r == '\v' || r == '\f':
			b.WriteByte(' ')
		case r == '{':
			b.WriteRune('｛')
		case r == '}':
			b.WriteRune('｝')
		case r == unicode.ReplacementChar, unicode.In(r, unicode.Cc, unicode.Cf, unicode.Co, unicode.Cs):
		default:
			b.WriteRune(r)
		}
	}
	return capRunes(strings.TrimSpace(b.String()), max)
}
