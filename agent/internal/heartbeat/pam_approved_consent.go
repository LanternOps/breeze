package heartbeat

import (
	"errors"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamactuator"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Server-approved elevations (#8995).
//
// When a request needs technician approval, RunPamFlow parks it and the user's
// own UAC credential prompt (consent.exe) stays on screen. Approval arrives
// later as pam_apply_v2, which launches the target as ~breeze_elev without
// going through that prompt at all — so nothing ever closed it, and on
// Windows Server it does not time out on its own. The user is left with a
// stale admin-credential prompt for an app that is already running elevated.
//
// The fix records which consent.exe raised the request (PID + creation time,
// in the requester's session) when the flow parks, and dismisses exactly that
// process once pam_apply_v2 has a verified-active launch. It never uses the
// deny path's untargeted Escape: other prompts may be open in the same session
// (one per pending request on hosts that draw UAC on the normal desktop), and
// one of them may belong to a local flow that still needs it.

const (
	// maxPendingPamConsents bounds the record of parked prompts. Each entry is
	// a few dozen bytes; the cap only stops a flood of unanswered requests
	// from growing memory without limit.
	maxPendingPamConsents = 64
	// pendingPamConsentTTL drops records nobody approved. A stale record is
	// harmless (the helper re-verifies PID + creation time and finds the
	// process gone), so this is a memory bound, not a correctness bound.
	pendingPamConsentTTL = 2 * time.Hour
)

type pendingPamConsent struct {
	winSession string
	instance   etwlua.ConsentInstance
	recordedAt time.Time
}

// pendingPamConsents maps an elevation request id to the consent.exe prompt
// it was raised from. The zero value is ready to use.
type pendingPamConsents struct {
	mu      sync.Mutex
	entries map[string]pendingPamConsent
	now     func() time.Time // test seam; nil means time.Now
}

func (p *pendingPamConsents) clock() time.Time {
	if p.now != nil {
		return p.now()
	}
	return time.Now()
}

// pruneLocked drops expired entries. Caller holds p.mu.
func (p *pendingPamConsents) pruneLocked(now time.Time) {
	for id, e := range p.entries {
		if now.Sub(e.recordedAt) > pendingPamConsentTTL {
			delete(p.entries, id)
		}
	}
}

func (p *pendingPamConsents) record(requestID, winSession string, instance etwlua.ConsentInstance) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	if p.entries == nil {
		p.entries = make(map[string]pendingPamConsent)
	}
	p.pruneLocked(now)
	if _, exists := p.entries[requestID]; !exists && len(p.entries) >= maxPendingPamConsents {
		oldestID, oldestAt := "", time.Time{}
		for id, e := range p.entries {
			if oldestID == "" || e.recordedAt.Before(oldestAt) {
				oldestID, oldestAt = id, e.recordedAt
			}
		}
		delete(p.entries, oldestID)
	}
	p.entries[requestID] = pendingPamConsent{winSession: winSession, instance: instance, recordedAt: now}
}

// take removes and returns the record, so each prompt is dismissed at most once.
func (p *pendingPamConsents) take(requestID string) (pendingPamConsent, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneLocked(p.clock())
	e, ok := p.entries[requestID]
	if ok {
		delete(p.entries, requestID)
	}
	return e, ok
}

func (p *pendingPamConsents) peek(requestID string) (pendingPamConsent, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.pruneLocked(p.clock())
	e, ok := p.entries[requestID]
	return e, ok
}

func (p *pendingPamConsents) len() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.entries)
}

// recordPendingPamConsent remembers the consent.exe a parked request was raised
// from. Without both a resolved requester session and a concrete consent.exe
// identity there is nothing safe to target later, so nothing is recorded.
func (h *Heartbeat) recordPendingPamConsent(requestID, targetWinSession string, instance etwlua.ConsentInstance) {
	if requestID == "" || targetWinSession == "" || instance.IsZero() {
		log.Debug("pam: no consent.exe identity for parked request; an approved launch will leave its prompt alone",
			"elevationRequestId", requestID, "targetWinSession", targetWinSession)
		return
	}
	h.pamPendingConsents.record(requestID, targetWinSession, instance)
}

// dismissApprovedPamConsent closes the parked request's own UAC prompt after a
// server-approved launch has been verified active. Best-effort and bounded:
// one attempt, one pamDismissTimeout. Every failure leaves the prompt where it
// was — the pre-#8995 behaviour — and is logged with the reason.
func (h *Heartbeat) dismissApprovedPamConsent(requestID string) {
	pending, ok := h.pamPendingConsents.take(requestID)
	if !ok {
		log.Debug("pam: approved elevation launched; no recorded consent prompt to dismiss",
			"elevationRequestId", requestID)
		return
	}

	find := h.pamFindSession
	if find == nil && h.sessionBroker != nil {
		find = h.sessionBroker.FindCapableSession
	}
	dismiss := h.pamDismissConsentInstance
	if dismiss == nil && h.sessionBroker != nil {
		dismiss = h.sessionBroker.DismissPamConsentInstance
	}
	if find == nil || dismiss == nil {
		log.Warn("pam: approved elevation launched but no session broker; the user's UAC prompt was left open",
			"elevationRequestId", requestID)
		return
	}

	session := find(ipc.ScopePam, pending.winSession)
	if session == nil {
		log.Warn("pam: approved elevation launched but no SYSTEM helper in the requester's session; the user's UAC prompt was left open",
			"elevationRequestId", requestID, "targetWinSession", pending.winSession)
		return
	}
	if session.WinSessionID != pending.winSession {
		// FindCapableSession never falls back for PAM today; this keeps a
		// future change from steering a dismissal into another user's session.
		log.Warn("pam: helper session does not match the prompt's session; the user's UAC prompt was left open",
			"elevationRequestId", requestID, "targetWinSession", pending.winSession, "helperWinSession", session.WinSessionID)
		return
	}

	instance := ipc.PamConsentInstance{PID: pending.instance.PID, CreatedUnixNano: pending.instance.CreatedAt.UnixNano()}
	var (
		res     ipc.PamDismissConsentResult
		err     error
		skipped bool
	)
	func() {
		// Same serialization as denyConsent/actuateElevation: only one stream
		// of input at the consent desktop at a time.
		h.pamActuateMu.Lock()
		defer h.pamActuateMu.Unlock()
		if h.pamDismissalUncertain {
			// Gate recovery owns the consent desktop until it proves it clear.
			skipped = true
			return
		}
		res, err = dismiss(session, requestID+"-approved-consent", instance, pamDismissTimeout)
	}()

	switch {
	case skipped:
		log.Warn("pam: approved elevation launched; UAC prompt left open while the PAM dismissal gate is engaged",
			"elevationRequestId", requestID)
	case errors.Is(err, sessionbroker.ErrPamTargetedDismissUnsupported):
		log.Warn("pam: approved elevation launched; the PAM helper is too old to dismiss one specific UAC prompt, so it was left open",
			"elevationRequestId", requestID, "helperPid", session.PID)
	case err != nil:
		// Deliberately NOT the fail-closed gate denyConsent engages. That gate
		// protects a DENIED prompt from receiving credentials later; this
		// prompt's request was approved and already launched. And a targeted
		// helper only ever presses Escape on the target's own foreground
		// window, so a late keystroke cannot land anywhere else. Engaging the
		// gate would disable PAM over a cosmetic cleanup.
		log.Warn("pam: approved elevation launched; dismissing the user's UAC prompt failed, it may still be open",
			"elevationRequestId", requestID, "error", err.Error())
	case res.Success:
		log.Info("pam: approved elevation launched; dismissed the user's UAC prompt",
			"elevationRequestId", requestID, "consentPid", pending.instance.PID)
	case res.Reason == pamactuator.ReasonNoConsentWindow:
		log.Info("pam: approved elevation launched; the user's UAC prompt had already closed",
			"elevationRequestId", requestID)
	default:
		log.Warn("pam: approved elevation launched; the user's UAC prompt could not be dismissed and may still be open",
			"elevationRequestId", requestID, "dismiss_reason", res.Reason, "dismiss_message", res.DetailMessage)
	}
}
