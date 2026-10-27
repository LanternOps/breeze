package promptkinds

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
	"github.com/breeze-rmm/agent/internal/prompthost"
)

// restart.prompt / restart.final constructors (#10190 W05, plan Task 5.1,
// spec §3.3; closes #10181).
//
// The restart policy is unchanged: which rungs exist, which may be
// postponed, how a postponement re-plans and the deadline all stay in
// agent/internal/patching. This file only decides what the person sees and
// turns their answer into a call on the reboot manager.
//
// One card per restart campaign (restart:<campaign>):
//   - Postpone offered → pending decision: postpone (safe, the default,
//     labelled with the resulting time) and restart_now (proceed).
//   - Postpone not offered (policy off, budget spent, or too close to the
//     deadline) → still a pending decision: ok (safe, the default: "got it",
//     the card collapses and the restart stays where it is) and restart_now
//     (proceed). A card is never left with Restart now as its only button:
//     a native dialog makes its first button the default, so Enter would
//     restart the machine.
//   - The closing rung (the OS countdown) replaces it with restart.final
//     (restart:<campaign>:final): focus steal, OK only.
//
// The consequence sentence travels in copy.consequence, which the host
// localizes per session; timing.expiry is left unset (its text would not be).
//
// MSP copy (patch policy reboot_prompt_title/body/button) fills the title,
// the body and the restart_now label; its {{countdown}} becomes the
// renderer's live {remaining}. Any other {{…}} stays literal (the API and
// patching.SanitizeRebootPromptText refuse it upstream). It never fills the
// identity header, the Postpone label, the consequence or the budget line.

const (
	actionPostpone   = "postpone"
	actionRestartNow = "restart_now"

	restartNamespace       = "restart"
	restartPresentWithinMs = 10_000

	// Audit renderer values (RebootStatusReport.lastUserAction.renderer).
	RendererAssist   = "assist"
	RendererNative   = "native"
	RendererHeadless = "headless"
)

// RestartPromptKind is restart.prompt@1. Transitions are nil: the reboot
// manager judges every action against the live schedule, and the content
// after a decision (a new time, a spent budget) comes from it, not from a
// table.
var RestartPromptKind = prompthost.KindSpec{Name: "restart.prompt", Version: 1}

// RestartFinalKind is restart.final@1: the closing card while the OS
// countdown runs. ok acknowledges it.
var RestartFinalKind = prompthost.KindSpec{
	Name:    "restart.final",
	Version: 1,
	Transitions: map[ipc.PromptState]map[string]ipc.PromptState{
		ipc.PromptStatePending: {actionOK: ipc.PromptStateApproved},
	},
}

// RestartPromptInput is one rung's view of the schedule.
type RestartPromptInput struct {
	// Campaign identifies the operator's restart (one Schedule; stable across
	// the person's postponements). Unique across agent restarts.
	Campaign uint64
	// ScheduledAt is when the restart fires.
	ScheduledAt time.Time
	// PostponeUntil is the time a Postpone would move the restart to, as
	// patching.ComputeDeferral clamps it; zero = Postpone is not offered.
	PostponeUntil time.Time
	// DeferralAllowed and DeferralsLeft drive the budget line.
	DeferralAllowed bool
	DeferralsLeft   int
	// Operator copy, already sanitised (patching.SanitizeRebootPromptText).
	OperatorTitle, OperatorBody, OperatorButton string
	// Partner is the sanitised MSP name ("" = the catalog's generic name).
	Partner string
	// Legacy is today's warning for this rung, sent to an owner whose
	// session cannot draw the card.
	Legacy ipc.NotifyRequest
}

// RestartPrompts builds restart prompts whose actions call the reboot
// manager. The caller sets Owners (and IdentityRef) before Show.
type RestartPrompts struct {
	// Postpone applies a Postpone for the campaign and returns the schedule
	// as it now stands. An error is a refusal the person sees as nothing
	// changing (rejected_invalid): the restart was cancelled, replaced, or
	// the deadline left no room.
	Postpone func(campaign uint64, renderer string) (RestartPromptInput, error)
	// RestartNow applies Restart now for the campaign.
	RestartNow func(campaign uint64, renderer string) error
	// Refresh changes the open card in place (prompthost.Host.Refresh).
	Refresh func(p prompthost.Prompt) error
	// Notify sends today's toast to one owner's session. Required for the
	// legacy path of a mixed-session device.
	Notify func(o prompthost.Owner, req ipc.NotifyRequest) error
}

var errRestartAction = errors.New("promptkinds: action not offered by this restart prompt")

// RestartPromptID is the card's prompt id for a campaign.
func RestartPromptID(campaign uint64) string { return fmt.Sprintf("restart:%d", campaign) }

// RestartFinalID is the closing card's prompt id for a campaign.
func RestartFinalID(campaign uint64) string { return fmt.Sprintf("restart:%d:final", campaign) }

// RestartedNoticeID is the after-restart list entry's prompt id.
func RestartedNoticeID(campaign uint64) string { return fmt.Sprintf("notice:restarted:%d", campaign) }

// RendererName maps a renderer's helper role to the audit's renderer value.
func RendererName(role ipc.HelperRole) string {
	if role == ipc.HelperRoleAssist {
		return RendererAssist
	}
	return RendererNative
}

// RestartPrompt builds the campaign's card for one rung.
func (r RestartPrompts) RestartPrompt(in RestartPromptInput) prompthost.Prompt {
	id := RestartPromptID(in.Campaign)
	offerPostpone := !in.PostponeUntil.IsZero()
	safe := actionOK
	if offerPostpone {
		safe = actionPostpone
	}
	actions := []ipc.PromptAction{
		{ID: safe, Label: safe, Role: ipc.PromptRoleSafe},
		{ID: actionRestartNow, Label: actionRestartNow, Role: ipc.PromptRoleProceed},
	}
	at := timeToken(in.ScheduledAt)
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title := operatorText(in.OperatorTitle)
		if title == "" {
			t, err := promptcatalog.Render(loc, restartNamespace, "prompt.title", nil)
			if err != nil {
				return prompthost.Localized{}, err
			}
			title = t
		}
		body := operatorText(in.OperatorBody)
		if body == "" {
			partner, err := partnerName(loc, in.Partner)
			if err != nil {
				return prompthost.Localized{}, err
			}
			if body, err = promptcatalog.Render(loc, restartNamespace, "prompt.body", map[string]string{"partner": partner}); err != nil {
				return prompthost.Localized{}, err
			}
		}
		consequence, err := promptcatalog.Render(loc, restartNamespace, "prompt.consequence", map[string]string{"at": at})
		if err != nil {
			return prompthost.Localized{}, err
		}
		detail, err := budgetLine(loc, in)
		if err != nil {
			return prompthost.Localized{}, err
		}
		labels := map[string]string{}
		if button := operatorText(in.OperatorButton); button != "" {
			labels[actionRestartNow] = button
		} else if labels[actionRestartNow], err = promptcatalog.Render(loc, restartNamespace, "action.restartNow", nil); err != nil {
			return prompthost.Localized{}, err
		}
		if offerPostpone {
			if labels[actionPostpone], err = promptcatalog.Render(loc, restartNamespace, "action.postponeUntil", map[string]string{"at": timeToken(in.PostponeUntil)}); err != nil {
				return prompthost.Localized{}, err
			}
		} else if labels[actionOK], err = promptcatalog.Render(loc, restartNamespace, "action.ok", nil); err != nil {
			return prompthost.Localized{}, err
		}
		return prompthost.Localized{
			Copy:         ipc.PromptCopy{Title: title, Body: body, Consequence: consequence, StateDetail: detail},
			ActionLabels: labels,
		}, nil
	}
	show := ipc.PromptShow{
		PromptID:        id,
		Kind:            RestartPromptKind.Name,
		KindVersion:     RestartPromptKind.Version,
		State:           ipc.PromptStatePending,
		Presentation:    ipc.PromptPresentationCard,
		Actions:         actions,
		DefaultActionID: safe,
		Timing: ipc.PromptTiming{
			PresentWithinMs: restartPresentWithinMs,
			DeadlineUnixMs:  in.ScheduledAt.UnixMilli(),
		},
		Focus:     ipc.PromptFocusNoActivate,
		ListEntry: ipc.PromptListEntry{Persistent: true, ExpiresAtUnixMs: in.ScheduledAt.UnixMilli()},
		Locale:    string(promptcatalog.LocaleEN),
		Direction: "ltr",
	}
	r.applyEN(&show, localize)
	legacy := in.Legacy
	return prompthost.Prompt{
		ID:   id,
		Kind: RestartPromptKind,
		Show: show,
		Legacy: func(o prompthost.Owner) error {
			return r.notify(o, legacy)
		},
		OnActionRenderer: func(actionID string, _ prompthost.Owner, role ipc.HelperRole) (prompthost.ActionOutcome, error) {
			return r.decide(in.Campaign, actionID, RendererName(role))
		},
		Localize: localize,
	}
}

// decide applies one answer on the restart card. Postpone re-plans and
// changes the card in place (Refresh: new time, new budget, the card the
// person just answered collapses rather than re-opening, #4941). Restart now
// moves the card to approved; the closing rung that the re-plan fires at
// once replaces it with restart.final.
func (r RestartPrompts) decide(campaign uint64, actionID, renderer string) (prompthost.ActionOutcome, error) {
	switch actionID {
	case actionOK:
		// "Got it": the person saw the card. Nothing changes — the restart
		// stays where it is and the card stays in the list; the renderer
		// collapses it.
		return prompthost.ActionOutcome{Accepted: true}, nil
	case actionPostpone:
		if r.Postpone == nil {
			return prompthost.ActionOutcome{}, errors.New("promptkinds: no reboot manager to postpone")
		}
		next, err := r.Postpone(campaign, renderer)
		if err != nil {
			log.Info("restart postponement refused", "campaign", campaign, "reason", err.Error())
			return prompthost.ActionOutcome{Accepted: false}, nil
		}
		if r.Refresh != nil {
			if err := r.Refresh(r.RestartPrompt(next)); err != nil {
				// The postponement stands (the manager re-planned and the
				// next rung re-shows the card); only this card's text is late.
				log.Warn("restart card not refreshed after a postponement", "campaign", campaign, "error", err.Error())
			}
		}
		return prompthost.ActionOutcome{Accepted: true}, nil
	case actionRestartNow:
		if r.RestartNow == nil {
			return prompthost.ActionOutcome{}, errors.New("promptkinds: no reboot manager to restart")
		}
		if err := r.RestartNow(campaign, renderer); err != nil {
			log.Info("restart now refused", "campaign", campaign, "reason", err.Error())
			return prompthost.ActionOutcome{Accepted: false}, nil
		}
		approved := ipc.PromptStateApproved
		none := []ipc.PromptAction{}
		return prompthost.ActionOutcome{Accepted: true, Patch: &prompthost.Patch{State: &approved, Actions: &none}}, nil
	}
	return prompthost.ActionOutcome{}, errRestartAction
}

// RestartFinal builds the closing card: the OS countdown to at is running.
func (r RestartPrompts) RestartFinal(campaign uint64, at time.Time) prompthost.Prompt {
	id := RestartFinalID(campaign)
	token := timeToken(at)
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := promptcatalog.Render(loc, restartNamespace, "final.title", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		body, err := promptcatalog.Render(loc, restartNamespace, "final.body", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		consequence, err := promptcatalog.Render(loc, restartNamespace, "final.consequence", map[string]string{"at": token})
		if err != nil {
			return prompthost.Localized{}, err
		}
		ok, err := promptcatalog.Render(loc, restartNamespace, "action.ok", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		return prompthost.Localized{Copy: ipc.PromptCopy{Title: title, Body: body, Consequence: consequence}, ActionLabels: map[string]string{actionOK: ok}}, nil
	}
	show := ipc.PromptShow{
		PromptID:        id,
		Kind:            RestartFinalKind.Name,
		KindVersion:     RestartFinalKind.Version,
		State:           ipc.PromptStatePending,
		Presentation:    ipc.PromptPresentationCard,
		Actions:         []ipc.PromptAction{{ID: actionOK, Label: actionOK, Role: ipc.PromptRoleSafe}},
		DefaultActionID: actionOK,
		Timing:          ipc.PromptTiming{PresentWithinMs: restartPresentWithinMs, DeadlineUnixMs: at.UnixMilli()},
		// A time-critical closing card: it may take focus, once per focus
		// interval (spec §3.2; the renderer enforces the interval and never
		// steals from a full-screen or presenting app).
		Focus:     ipc.PromptFocusSteal,
		ListEntry: ipc.PromptListEntry{Persistent: true, ExpiresAtUnixMs: at.UnixMilli()},
		Locale:    string(promptcatalog.LocaleEN),
		Direction: "ltr",
	}
	r.applyEN(&show, localize)
	return prompthost.Prompt{
		ID:       id,
		Kind:     RestartFinalKind,
		Show:     show,
		OnAction: acknowledgeOnly,
		Localize: localize,
	}
}

// RestartCancelled is the card (restart.prompt or restart.final, by id and
// kind) after an operator cancelled the restart: terminal, no actions, and
// "Restart cancelled by <MSP>" stays in the list.
func (r RestartPrompts) RestartCancelled(id string, kind prompthost.KindSpec, partner string) prompthost.Prompt {
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := promptcatalog.Render(loc, restartNamespace, "cancelled.title", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		name, err := partnerName(loc, partner)
		if err != nil {
			return prompthost.Localized{}, err
		}
		body, err := promptcatalog.Render(loc, restartNamespace, "cancelled.body", map[string]string{"partner": name})
		if err != nil {
			return prompthost.Localized{}, err
		}
		return prompthost.Localized{Copy: ipc.PromptCopy{Title: title, Body: body}, ActionLabels: map[string]string{}}, nil
	}
	show := ipc.PromptShow{
		PromptID:     id,
		Kind:         kind.Name,
		KindVersion:  kind.Version,
		State:        ipc.PromptStateCancelled,
		Presentation: ipc.PromptPresentationCard,
		Actions:      []ipc.PromptAction{},
		Timing:       ipc.PromptTiming{PresentWithinMs: restartPresentWithinMs},
		Focus:        ipc.PromptFocusNoActivate,
		// The list keeps the outcome for the host's default list lifetime.
		ListEntry: ipc.PromptListEntry{Persistent: true},
		Locale:    string(promptcatalog.LocaleEN),
		Direction: "ltr",
	}
	r.applyEN(&show, localize)
	return prompthost.Prompt{ID: id, Kind: kind, Show: show, Localize: localize}
}

// RestartedNotice is the after-the-fact entry "Your computer restarted at
// <time> …", written to each owner's list before the OS restart and shown,
// list-only, at their next sign-in (spec §3.2). A notice.info outcome.
func (r RestartPrompts) RestartedNotice(campaign uint64, at time.Time) prompthost.Prompt {
	id := RestartedNoticeID(campaign)
	token := timeToken(at)
	localize := func(loc promptcatalog.Locale) (prompthost.Localized, error) {
		title, err := promptcatalog.Render(loc, restartNamespace, "afterRestart.title", nil)
		if err != nil {
			return prompthost.Localized{}, err
		}
		body, err := promptcatalog.Render(loc, restartNamespace, "afterRestart.body", map[string]string{"at": token})
		if err != nil {
			return prompthost.Localized{}, err
		}
		return prompthost.Localized{Copy: ipc.PromptCopy{Title: title, Body: body}, ActionLabels: map[string]string{}}, nil
	}
	show := ipc.PromptShow{
		PromptID:     id,
		Kind:         NoticeInfo.Name,
		KindVersion:  NoticeInfo.Version,
		State:        ipc.PromptStateApproved,
		Presentation: ipc.PromptPresentationListOnly,
		Actions:      []ipc.PromptAction{},
		Timing:       ipc.PromptTiming{PresentWithinMs: noticePresentWithinMs},
		Focus:        ipc.PromptFocusNoActivate,
		ListEntry:    ipc.PromptListEntry{Persistent: true},
		Locale:       string(promptcatalog.LocaleEN),
		Direction:    "ltr",
	}
	r.applyEN(&show, localize)
	return prompthost.Prompt{ID: id, Kind: NoticeInfo, Show: show, Localize: localize}
}

// applyEN fills Show with the en rendering. An en failure is a build defect
// (the catalog is embedded and tested); the empty title it leaves is refused
// by the host's validation, so the caller takes its legacy path.
func (r RestartPrompts) applyEN(show *ipc.PromptShow, localize func(promptcatalog.Locale) (prompthost.Localized, error)) {
	l, err := localize(promptcatalog.LocaleEN)
	if err != nil {
		log.Error("restart copy could not be rendered; the restart warning takes its legacy path", "promptId", show.PromptID, "error", err.Error())
		return
	}
	show.Copy, show.Facts = l.Copy, l.Facts
	for i := range show.Actions {
		if label, ok := l.ActionLabels[show.Actions[i].ID]; ok {
			show.Actions[i].Label = label
		}
	}
}

func (r RestartPrompts) notify(o prompthost.Owner, req ipc.NotifyRequest) error {
	if r.Notify == nil {
		return errors.New("promptkinds: no legacy notifier")
	}
	if req.Title == "" && req.Body == "" {
		return errors.New("promptkinds: no legacy warning for this rung")
	}
	return r.Notify(o, req)
}

// budgetLine is the postponement budget the card states, or "" when the
// policy offers no postponement at all (a non-deferrable restart says
// nothing about postponing, as today).
func budgetLine(loc promptcatalog.Locale, in RestartPromptInput) (string, error) {
	if !in.DeferralAllowed {
		return "", nil
	}
	switch {
	case in.PostponeUntil.IsZero() || in.DeferralsLeft <= 0:
		return promptcatalog.Render(loc, restartNamespace, "prompt.budgetNone", nil)
	case in.DeferralsLeft == 1:
		return promptcatalog.Render(loc, restartNamespace, "prompt.budgetOne", nil)
	}
	return promptcatalog.Render(loc, restartNamespace, "prompt.budgetMany", map[string]string{"count": fmt.Sprint(in.DeferralsLeft)})
}

// partnerName is the MSP name a sentence names, or the catalog's generic
// "Your IT support team" in loc.
func partnerName(loc promptcatalog.Locale, partner string) (string, error) {
	if name := capRunes(promptcatalog.SanitizeIdentityName(partner), maxTechnicianRunes); name != "" {
		return name, nil
	}
	return promptcatalog.Render(loc, "common", "identity.generic", nil)
}

// operatorText turns operator copy into card copy: every literal
// {{countdown}} becomes the renderer's live {remaining}; everything else,
// including any other {{…}}, is kept as written.
func operatorText(s string) string {
	s = strings.TrimSpace(s)
	return strings.ReplaceAll(s, "{{countdown}}", "{remaining}")
}

// timeToken is the renderer-owned wall-clock placeholder for t.
func timeToken(t time.Time) string { return fmt.Sprintf("{time:%d}", t.UnixMilli()) }
