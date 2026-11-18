package pamactuator

import (
	"errors"
	"strings"
)

// errConsentProcessGone: no process holds the PID any more.
var errConsentProcessGone = errors.New("no process with this PID")

// ConsentInstanceExited reports whether the recorded consent.exe has
// positively gone away: exited, or its PID now belongs to a process created
// at another instant. An error means it could not be determined (or the PID
// is now some other image); a caller must then treat the prompt as still up.
// It is safe to call from the agent service: unlike the helper's targeted
// dismissal it does not require the caller to be in the prompt's session.
func ConsentInstanceExited(inst ConsentInstance) (bool, error) {
	return consentExitedFrom(inst, readConsentProcessFacts)
}

func consentExitedFrom(inst ConsentInstance, read func(pid uint32) (consentProcessFacts, error)) (bool, error) {
	if !inst.valid() {
		return false, errors.New("invalid consent.exe instance")
	}
	facts, err := read(inst.PID)
	if errors.Is(err, errConsentProcessGone) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	return consentProcessExited(inst, facts)
}

// consentProcessExited is consentProcessMatches without the session rule:
// (true, nil) only on positive evidence the recorded prompt is gone.
func consentProcessExited(inst ConsentInstance, facts consentProcessFacts) (bool, error) {
	if !facts.CreatedAt.Equal(inst.CreatedAt) {
		return true, nil
	}
	if facts.ExitCode != stillActiveExitCode {
		return true, nil
	}
	base := facts.ImagePath
	if i := strings.LastIndexAny(base, `\/`); i >= 0 {
		base = base[i+1:]
	}
	if !strings.EqualFold(base, "consent.exe") {
		return false, errConsentInstanceWrongImage
	}
	return false, nil
}
