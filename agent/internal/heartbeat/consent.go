package heartbeat

import (
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// consentOutcomeUnknown is the agent-side outcome for a prompt that was (or
// may have been) shown but produced no valid answer: a lost or garbled reply,
// the helper going away after confirming the prompt, or a version 1 helper
// that stayed silent. It always blocks — the answer may have been Deny.
const consentOutcomeUnknown = "unknown"

// Consent reasons reported to the API (consentReason on a start that
// proceeded, reason on a consent_denied result). See
// apps/api/src/routes/remote/helpers.ts.
const (
	consentReasonUser              = "user"               // the signed-in user clicked Allow / Deny
	consentReasonTimeout           = "timeout"            // the prompt was shown and not answered
	consentReasonNoUserSession     = "no_user_session"    // nobody is signed in to the captured session
	consentReasonHelperUnreachable = "helper_unreachable" // someone is (or may be) signed in but could not be asked
	consentReasonNoUser            = "no_user"            // no valid answer came back
)

// consentAttempt is what soliciting consent produced (solicitConsent).
type consentAttempt struct {
	// outcome is an ipc.ConsentOutcome* value or consentOutcomeUnknown.
	outcome string
	// detail optionally says why the prompt was unavailable or the answer
	// unknown (lowercase snake_case; reported to the API as consentDetail).
	detail string
	// helper is the helper session the prompt was sent to (nil when none).
	helper *sessionbroker.Session
}

// consentVerdict is the gate's decision plus what the API records about it.
type consentVerdict struct {
	proceed   bool
	reason    string
	outcome   string
	occupancy string // only set when the prompt could not be shown
	detail    string
	helper    *sessionbroker.Session
}

// decideConsent encodes the decision matrix.
//
//   - A click (granted / denied) is honored directly, reason "user".
//   - A prompt confirmed on screen whose countdown ran out follows the
//     policy's consentUnavailableBehavior, reason "timeout" — but only when
//     the user could see it (visible). A locked or disconnected screen is
//     handled as a prompt that could not be shown.
//   - A prompt that could not be shown follows the policy only when nobody is
//     signed in to the captured session (reason "no_user_session"). When
//     someone is, or that cannot be established, it is always refused
//     (reason "helper_unreachable"): nobody gets to skip a person who is
//     there just because their prompt failed.
//   - Anything else (no valid answer to a shown prompt) is refused, reason
//     "no_user". A lost Deny must never become an Allow.
//
// occupancy and visible are only evaluated for the outcomes that need them.
func decideConsent(att consentAttempt, unavailableBehavior string, occupancy func() string, visible func() bool) consentVerdict {
	v := consentVerdict{outcome: att.outcome, detail: att.detail, helper: att.helper}
	proceedAllowed := unavailableBehavior == "proceed"
	switch att.outcome {
	case ipc.ConsentOutcomeGranted:
		v.proceed, v.reason = true, consentReasonUser
		return v
	case ipc.ConsentOutcomeDenied:
		v.proceed, v.reason = false, consentReasonUser
		return v
	case ipc.ConsentOutcomePresentedExpired:
		if visible() {
			v.proceed, v.reason = proceedAllowed, consentReasonTimeout
			return v
		}
		if v.detail == "" {
			v.detail = "prompt_not_visible"
		}
		return decideUnshown(v, proceedAllowed, occupancy)
	case ipc.ConsentOutcomeUnavailable:
		return decideUnshown(v, proceedAllowed, occupancy)
	default:
		v.proceed, v.reason = false, consentReasonNoUser
		return v
	}
}

func decideUnshown(v consentVerdict, proceedAllowed bool, occupancy func() string) consentVerdict {
	v.occupancy = occupancy()
	if v.occupancy == occupancyUnoccupied {
		v.proceed, v.reason = proceedAllowed, consentReasonNoUserSession
		return v
	}
	v.proceed, v.reason = false, consentReasonHelperUnreachable
	return v
}
