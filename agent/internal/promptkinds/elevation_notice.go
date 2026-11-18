package promptkinds

import (
	"fmt"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/promptcatalog"
)

// ElevationOutcomeNotice renders an elevation outcome as notice text in loc
// (#10696): the toast the agent shows when no renderer holds the elevation
// prompt (no Assist). It is the prompt's own copy — the same elevation.*
// keys, the same named / generic and technician sentence choice, the same
// sanitizing — so a person reads one sentence whichever surface shows it.
//
// program is a captured path or base name; partner the MSP name ("" = the
// generic sentences); technician the approver the server sent (approved
// only); reason the server's deny reason (denied only), appended after the
// body as the localized "Reason" label and the text. A non-terminal state is
// an error.
func ElevationOutcomeNotice(loc promptcatalog.Locale, state ipc.PromptState, program, partner, technician, reason string) (title, body string, err error) {
	if !state.Terminal() {
		return "", "", fmt.Errorf("promptkinds: %q is not an elevation outcome", state)
	}
	e := &Elevation{
		program: factText(elevationProgramName(program), maxElevationProgramRunes),
		partner: promptText(partner, maxTechnicianRunes),
	}
	if e.program == "" {
		e.program = factText(program, maxElevationProgramRunes)
	}
	v := elevationView{state: state}
	switch state {
	case ipc.PromptStateApproved:
		v.technician = promptText(technician, maxTechnicianRunes)
	case ipc.PromptStateDenied:
		v.reason = factText(reason, maxElevationReasonRunes)
	}
	l, err := e.render(loc, v)
	if err != nil {
		return "", "", err
	}
	body = l.Copy.Body
	if v.reason != "" {
		label, err := elevationRender(loc, elevationNamespace, "fact.reason", nil)
		if err != nil {
			return "", "", err
		}
		body += "\n" + label + ": " + v.reason
	}
	return l.Copy.Title, body, nil
}
