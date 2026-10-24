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

// consentKey is a comparable form of etwlua.ConsentInstance.
type consentKey struct {
	pid   uint32
	nanos int64
}

func keyOf(instance etwlua.ConsentInstance) consentKey {
	return consentKey{pid: instance.PID, nanos: instance.CreatedAt.UnixNano()}
}

// pendingPamConsents maps an elevation request id to the consent.exe prompt
// it was raised from. The zero value is ready to use.
type pendingPamConsents struct {
	mu      sync.Mutex
	entries map[string]pendingPamConsent
	// conflicted remembers instances two different requests were attributed
	// to. Attribution picked the wrong prompt for at least one of them, so
	// neither may be dismissed on approval; the value is when it was seen.
	conflicted map[consentKey]time.Time
	now        func() time.Time // test seam; nil means time.Now
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
	for k, at := range p.conflicted {
		if now.Sub(at) > pendingPamConsentTTL {
			delete(p.conflicted, k)
		}
	}
}

func (p *pendingPamConsents) initLocked() {
	if p.entries == nil {
		p.entries = make(map[string]pendingPamConsent)
	}
	if p.conflicted == nil {
		p.conflicted = make(map[consentKey]time.Time)
	}
}

// evictOldestLocked makes room for one more entry. Caller holds p.mu.
func (p *pendingPamConsents) evictOldestLocked() {
	oldestID, oldestAt := "", time.Time{}
	for id, e := range p.entries {
		if oldestID == "" || e.recordedAt.Before(oldestAt) {
			oldestID, oldestAt = id, e.recordedAt
		}
	}
	log.Debug("pam: parked-prompt record evicted at capacity", "elevationRequestId", oldestID)
	delete(p.entries, oldestID)
}

func (p *pendingPamConsents) record(requestID, winSession string, instance etwlua.ConsentInstance) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.clock()
	p.initLocked()
	p.pruneLocked(now)

	key := keyOf(instance)
	if _, bad := p.conflicted[key]; bad {
		log.Warn("pam: consent.exe already claimed by more than one request; its prompt will not be dismissed on approval",
			"elevationRequestId", requestID, "consentPid", instance.PID)
		return
	}
	for otherID, e := range p.entries {
		if otherID != requestID && keyOf(e.instance) == key {
			delete(p.entries, otherID)
			p.conflicted[key] = now
			log.Warn("pam: two requests attributed to the same consent.exe; neither prompt will be dismissed on approval",
				"elevationRequestId", requestID, "otherElevationRequestId", otherID, "consentPid", instance.PID)
			return
		}
	}

	if _, exists := p.entries[requestID]; !exists && len(p.entries) >= maxPendingPamConsents {
		p.evictOldestLocked()
	}
	p.entries[requestID] = pendingPamConsent{winSession: winSession, instance: instance, recordedAt: now}
}

// take removes and returns the record. The caller either finishes with it or
// hands it back with restore, so concurrent applies for one request never
// both drive the desktop.
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

// restore hands back a record whose prompt may still be open, keeping its
// original recordedAt so the TTL still bounds it. A newer record for the same
// request, or a conflict seen meanwhile, wins.
func (p *pendingPamConsents) restore(requestID string, e pendingPamConsent) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.initLocked()
	if _, exists := p.entries[requestID]; exists {
		return
	}
	if _, bad := p.conflicted[keyOf(e.instance)]; bad {
		return
	}
	if len(p.entries) >= maxPendingPamConsents {
		p.evictOldestLocked()
	}
	p.entries[requestID] = e
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
// from. Without both a resolved requester session and an unambiguous
// consent.exe identity there is nothing safe to target later, so nothing is
// recorded — and the approved launch will leave the prompt open, which is
// worth seeing at default log level.
func (h *Heartbeat) recordPendingPamConsent(requestID, targetWinSession string, instance etwlua.ConsentInstance) {
	if requestID == "" || targetWinSession == "" || instance.IsZero() {
		log.Info("pam: parked request has no unambiguous consent.exe identity; its UAC prompt will stay open after approval",
			"elevationRequestId", requestID, "targetWinSession", targetWinSession,
			"sessionResolved", targetWinSession != "", "consentIdentified", !instance.IsZero())
		return
	}
	h.pamPendingConsents.record(requestID, targetWinSession, instance)
}

// dismissApprovedPamConsent closes the parked request's own UAC prompt after a
// server-approved launch has been verified active. Best-effort and bounded:
// one attempt per apply, one pamDismissTimeout plus at most
// pamApprovedConsentQuiesceWait. Every failure leaves the prompt where it was —
// the pre-#8995 behaviour — and is logged with the reason. Unless the prompt
// is known gone, the record is handed back so a redelivered apply can retry.
func (h *Heartbeat) dismissApprovedPamConsent(requestID string) {
	pending, ok := h.pamPendingConsents.take(requestID)
	if !ok {
		log.Debug("pam: approved elevation launched; no recorded consent prompt to dismiss",
			"elevationRequestId", requestID)
		return
	}
	promptGone := false
	defer func() {
		if !promptGone {
			h.pamPendingConsents.restore(requestID, pending)
		}
	}()

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
		res        ipc.PamDismissConsentResult
		err        error
		skipped    bool
		unquiesced bool
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
		var uncertain *sessionbroker.PamDismissUncertainError
		if errors.As(err, &uncertain) && uncertain.Quiesced != nil {
			// The helper may still be about to press Escape. Keep the lock —
			// so no other actuation types into a prompt meanwhile — until it
			// proves it finished, bounded so a hung helper cannot pin PAM.
			// This deliberately does NOT engage the fail-closed gate
			// denyConsent uses: that gate protects a DENIED prompt from
			// receiving credentials, and its recovery probes with the
			// untargeted Escape this path exists to avoid. This prompt's
			// request was approved and has already launched.
			res, err, unquiesced = h.awaitApprovedConsentQuiescence(uncertain)
		}
	}()

	switch {
	case skipped:
		log.Warn("pam: approved elevation launched; UAC prompt left open while the PAM dismissal gate is engaged",
			"elevationRequestId", requestID)
	case errors.Is(err, sessionbroker.ErrPamTargetedDismissUnsupported):
		log.Warn("pam: approved elevation launched; the PAM helper is too old to dismiss one specific UAC prompt, so it was left open",
			"elevationRequestId", requestID, "helperPid", session.PID)
	case unquiesced:
		log.Warn("pam: approved elevation launched; dismissing the user's UAC prompt timed out and the helper never reported back — outcome unknown, prompt may still be open",
			"elevationRequestId", requestID, "error", err.Error())
	case err != nil:
		log.Warn("pam: approved elevation launched; dismissing the user's UAC prompt failed, it may still be open",
			"elevationRequestId", requestID, "error", err.Error())
	case res.Success:
		promptGone = true
		log.Info("pam: approved elevation launched; dismissed the user's UAC prompt",
			"elevationRequestId", requestID, "consentPid", pending.instance.PID)
	case res.Reason == pamactuator.ReasonNoConsentWindow:
		promptGone = true
		log.Info("pam: approved elevation launched; the user's UAC prompt had already closed",
			"elevationRequestId", requestID)
	default:
		log.Warn("pam: approved elevation launched; the user's UAC prompt could not be dismissed and may still be open",
			"elevationRequestId", requestID, "dismiss_reason", res.Reason, "dismiss_message", res.DetailMessage)
	}
}

// awaitApprovedConsentQuiescence waits (bounded) for the late helper response
// to an uncertain targeted dismissal. Caller holds pamActuateMu. It returns the
// helper's proven result when one arrives; otherwise the original error and
// unquiesced=true.
func (h *Heartbeat) awaitApprovedConsentQuiescence(uncertain *sessionbroker.PamDismissUncertainError) (ipc.PamDismissConsentResult, error, bool) {
	wait := h.pamApprovedConsentQuiesceWait
	if wait <= 0 {
		wait = pamDismissTimeout
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case outcome, ok := <-uncertain.Quiesced:
		if !ok || !outcome.Proven {
			return ipc.PamDismissConsentResult{}, uncertain, true
		}
		if outcome.Err != nil {
			return ipc.PamDismissConsentResult{}, outcome.Err, false
		}
		return outcome.Result, nil, false
	case <-timer.C:
		return ipc.PamDismissConsentResult{}, uncertain, true
	case <-h.stopChan:
		return ipc.PamDismissConsentResult{}, uncertain, true
	}
}
