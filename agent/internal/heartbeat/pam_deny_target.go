package heartbeat

import (
	"errors"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Deny-path dismissal (#10370).
//
// On a dialog timeout the broker gives up on the "Elevation Request" dialog
// before the helper's own countdown ends, so the dialog is still on screen —
// topmost and holding the foreground — when the deny path dismisses
// consent.exe. The old untargeted dismissal pressed Escape into whatever had
// focus: the Breeze dialog took it (Escape maps to IDCANCEL there) and the
// UAC prompt stayed up. Two changes keep the dismissal on the UAC prompt:
//
//   - the helper is asked to take its own dialog down, and confirm it is gone,
//     before the dismissal runs (closePamDialog);
//   - when the request's own consent.exe is known, the dismissal targets that
//     instance (#10177): a close request addressed to its window, which does
//     not depend on focus, and an Escape only while it owns the foreground.

const (
	// pamDenyDismissIDSuffix gives the deny dismissal its own IPC id. The
	// dialog round-trip used the bare request id, and a late
	// pam_dialog_result must never reach the dismissal's waiter.
	pamDenyDismissIDSuffix = "-deny"
	// pamCloseDialogIDSuffix is the close command's IPC id suffix.
	pamCloseDialogIDSuffix = "-close-dialog"
	// pamCloseDialogTimeout bounds the close round-trip. The helper waits at
	// most a few seconds for its window to go; consent.exe is still on screen
	// meanwhile, so this must stay short.
	pamCloseDialogTimeout = 5 * time.Second
)

type pamDismissFunc func(session *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error)

// denyDismisser picks the deny path's dismissal. It targets the request's own
// consent.exe when its identity is known and the helper is in the requester's
// session; otherwise it is the untargeted dismissal. A helper that cannot
// target (ErrPamTargetedDismissUnsupported, returned before anything is sent)
// falls back to the untargeted dismissal. No other targeted failure falls
// back: consent_not_foreground, for one, means an Escape would reach some
// other window. nil means no dismissal IPC is available.
func (h *Heartbeat) denyDismisser(session *sessionbroker.Session, requestID, targetWinSession string, consent etwlua.ConsentInstance) pamDismissFunc {
	untargeted := pamDismissFunc(h.pamDismissConsent)
	if untargeted == nil && h.sessionBroker != nil {
		untargeted = h.sessionBroker.DismissPamConsent
	}
	targeted := h.pamDismissConsentInstance
	if targeted == nil && h.sessionBroker != nil {
		targeted = h.sessionBroker.DismissPamConsentInstance
	}

	// The instance is only meaningful in the requester's own session, and only
	// a helper running there can verify and close it.
	canTarget := targeted != nil && !consent.IsZero() && targetWinSession != "" &&
		session != nil && session.WinSessionID == targetWinSession
	if !canTarget {
		return untargeted
	}

	instance := ipc.PamConsentInstance{PID: consent.PID, CreatedUnixNano: consent.CreatedAt.UnixNano()}
	return func(s *sessionbroker.Session, id string, timeout time.Duration) (ipc.PamDismissConsentResult, error) {
		res, err := targeted(s, id, instance, timeout)
		if !errors.Is(err, sessionbroker.ErrPamTargetedDismissUnsupported) {
			return res, err
		}
		if untargeted == nil {
			return res, err
		}
		log.Info("pam: helper cannot dismiss one specific UAC prompt; denying with the untargeted dismissal",
			"elevationRequestId", requestID, "helperPid", s.PID)
		return untargeted(s, id, timeout)
	}
}

// closePamDialog asks the helper to take down its own elevation dialog for
// dialogID and waits, bounded, for it to report the window gone. Best-effort:
// every failure is logged and the deny proceeds — the targeted dismissal does
// not depend on focus, and the untargeted one is no worse off than before.
func (h *Heartbeat) closePamDialog(session *sessionbroker.Session, dialogID string) {
	if session == nil {
		return
	}
	if !session.SupportsPamDialogClose {
		log.Info("pam: helper cannot close its elevation dialog on request; it may still be open while consent.exe is dismissed",
			"elevationRequestId", dialogID, "helperPid", session.PID)
		return
	}
	closeDialog := h.pamCloseDialog
	if closeDialog == nil {
		if h.sessionBroker == nil {
			return
		}
		closeDialog = h.sessionBroker.ClosePamDialog
	}

	res, err := closeDialog(session, dialogID+pamCloseDialogIDSuffix, dialogID, pamCloseDialogTimeout)
	switch {
	case err != nil:
		log.Warn("pam: could not close the elevation dialog before denying; it may still be open",
			"elevationRequestId", dialogID, "error", err.Error())
	case !res.Closed:
		log.Warn("pam: elevation dialog did not close before denying; it may still be open",
			"elevationRequestId", dialogID, "reason", res.Reason)
	case res.WasOpen:
		log.Info("pam: closed the elevation dialog before denying", "elevationRequestId", dialogID)
	default:
		log.Debug("pam: elevation dialog had already closed", "elevationRequestId", dialogID)
	}
}
