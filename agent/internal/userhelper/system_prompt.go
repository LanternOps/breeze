package userhelper

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// The SYSTEM helper's prompt renderer (#10190 W07, plan P14).
//
// With UAC on the secure desktop only the SYSTEM helper can draw next to it,
// so it renders elevation.request@1's first question — and nothing else: a
// decision with exactly one safe button (Cancel, the default; Esc and the
// close box) and one proceed button (Send request). It reuses the PAM
// window that today's pam_request_dialog draws, filled with the agent's
// catalog copy, and draws only on the desktop that has input now: if it
// cannot attach to it, nothing is drawn and the agent hears render_failed
// (never a redraw somewhere the person cannot see).

// systemPromptKindsFor is what the SYSTEM helper advertises on goos.
func systemPromptKindsFor(goos string) []string {
	if goos == "windows" {
		return []string{"elevation.request@1"}
	}
	return []string{}
}

// pamDialogContent is what the PAM window shows.
type pamDialogContent struct {
	Headline string
	Subline  string
	Fields   []pamDialogField
	// Note is the consequence line under the fields ("" = none).
	Note         string
	ApproveLabel string
	DenyLabel    string
	// ApproveID and DenyID are the prompt actions the two buttons answer
	// ("" for today's dialog).
	ApproveID string
	DenyID    string
	// Total is the countdown (0 = none).
	Total time.Duration
}

// pamDialogContentFromRequest is today's pam_request_dialog content,
// unchanged.
func pamDialogContentFromRequest(req ipc.PamRequestDialog) pamDialogContent {
	c := pamDialogContent{
		Headline:     pamDialogHeadline(req),
		Subline:      "Breeze intercepted an elevation request on this device.",
		Fields:       pamDialogFields(req),
		ApproveLabel: "&Approve",
		DenyLabel:    "&Deny",
	}
	if req.TimeoutSeconds > 0 {
		c.Total = time.Duration(req.TimeoutSeconds) * time.Second
	}
	return c
}

var errSystemPromptShape = errors.New("the SYSTEM helper draws only a two-button decision (one safe, one proceed)")

// pamDialogContentFromModel fills the PAM window from a prompt.
func pamDialogContentFromModel(m nativePromptModel) (pamDialogContent, error) {
	if !m.Decision || len(m.Buttons) != 2 || m.Buttons[0].Role != ipc.PromptRoleSafe || m.Buttons[1].Role != ipc.PromptRoleProceed || m.CancelID != m.Buttons[0].ID {
		return pamDialogContent{}, errSystemPromptShape
	}
	c := pamDialogContent{
		Headline:     m.Title,
		Subline:      m.Intro,
		Note:         m.Note,
		DenyLabel:    m.Buttons[0].Label,
		DenyID:       m.Buttons[0].ID,
		ApproveLabel: m.Buttons[1].Label,
		ApproveID:    m.Buttons[1].ID,
		Total:        m.Response,
	}
	if !m.Deadline.IsZero() {
		c.Total = time.Until(m.Deadline)
	}
	for _, f := range m.Facts {
		c.Fields = append(c.Fields, pamDialogField{Label: f.Label, Value: pamDialogValue(f.Value)})
	}
	return c, nil
}

// systemPromptOutcome maps the PAM window's result to the prompt outcome:
// the proceed button, the safe action (Deny, Esc, close box), or its own
// countdown (never a decision: the agent's timer decides expiry).
func systemPromptOutcome(c pamDialogContent, res ipc.PamDialogResult) nativeOutcome {
	switch {
	case res.Approved:
		return nativeOutcome{ActionID: c.ApproveID}
	case res.DismissedByUser:
		return nativeOutcome{ActionID: c.DenyID}
	}
	return nativeOutcome{TimedOut: true}
}
