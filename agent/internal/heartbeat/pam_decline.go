package heartbeat

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamdecline"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// pamDeclineFileName sits next to pam-lifetime-ledger.json, so it inherits
// that directory's SYSTEM-only ACL on Windows.
const pamDeclineFileName = "pam-declined-requests.json"

// pamDeclineStore returns the decline record. A Heartbeat built without New
// (tests) gets a memory-only store on first use.
func (h *Heartbeat) pamDeclineStore() *pamdecline.Store {
	h.pamDeclinesMu.Lock()
	defer h.pamDeclinesMu.Unlock()
	if h.pamDeclines == nil {
		h.pamDeclines = pamdecline.NewStore("", nil)
	}
	return h.pamDeclines
}

// loadPamDeclineStore swaps in the file-backed store. A corrupt file has been
// moved aside and fences every remote apply for pamdecline.UntrustedLoadFence;
// that is loud on purpose.
func (h *Heartbeat) loadPamDeclineStore(path string) {
	store := pamdecline.NewStore(path, nil)
	switch err := store.Load(); {
	case err == nil:
	case errors.Is(err, pamdecline.ErrCorrupt):
		log.Error("pam: decline record was corrupt and has been moved aside; refusing every remote elevation apply for 24h",
			"path", path, "fence", pamdecline.UntrustedLoadFence.String(), "error", err.Error())
	default:
		log.Error("pam: decline record loaded but could not be rewritten; declines are enforced in memory",
			"path", path, "error", err.Error())
	}
	h.pamDeclinesMu.Lock()
	h.pamDeclines = store
	h.pamDeclinesMu.Unlock()
}

// kickPamWithdrawDrain wakes the withdraw drain without blocking.
func (h *Heartbeat) kickPamWithdrawDrain() {
	select {
	case h.pamWithdrawKick <- struct{}{}:
	default:
	}
}

// pamDeclineWaitBound is how long an apply waits for an open dialog's answer:
// the whole dialog round trip plus the dismissal after it.
func (h *Heartbeat) pamDeclineWaitBound() time.Duration {
	if h.pamDeclineWait > 0 {
		return h.pamDeclineWait
	}
	return pamDialogTimeout + pamDismissTimeout
}

// awaitPamDecline is the apply paths' first check. It waits (outside any
// lock) while the user still has the dialog open, then reports whether the
// apply must be refused and with which failure code.
func (h *Heartbeat) awaitPamDecline(requestID string) (refuse bool, code string) {
	ctx, cancel := context.WithTimeout(context.Background(), h.pamDeclineWaitBound())
	defer cancel()
	return h.pamDeclineStore().Await(ctx, requestID)
}

// pamDeclineChecker gives the lifetime manager a non-blocking re-check that
// always reads the current store (SetStatePath swaps it).
type pamDeclineChecker struct{ h *Heartbeat }

func (c pamDeclineChecker) Check(requestID string) (bool, string) {
	return c.h.pamDeclineStore().Check(requestID)
}

// installPamDeclineChecker hands the lifetime manager its non-blocking
// re-check. Every manager this package builds supports it; one that does not
// would leave the wait in the handler as the only guard, so say so loudly.
func (h *Heartbeat) installPamDeclineChecker() {
	if h.pamLifetimeManager == nil {
		return
	}
	setter, ok := h.pamLifetimeManager.(interface {
		SetDeclineChecker(pamlifetime.DeclineChecker)
	})
	if !ok {
		log.Error("pam: lifetime manager cannot check the user's declines; a declined request is refused only by the apply wait")
		return
	}
	setter.SetDeclineChecker(pamDeclineChecker{h})
}

// pamWithdrawReason maps the dialog round trip to the reason sent to the
// server. No helper change is needed: the helper's own countdown expiry
// answers Approved=false, DismissedByUser=false.
func pamWithdrawReason(dialog ipc.PamDialogResult, dialogErr error) pamdecline.Reason {
	if dialogErr != nil {
		if errors.Is(dialogErr, sessionbroker.ErrCommandTimeout) {
			return pamdecline.ReasonUserTimeout
		}
		return pamdecline.ReasonDialogError
	}
	if !dialog.Approved && !dialog.DismissedByUser {
		return pamdecline.ReasonUserTimeout
	}
	return pamdecline.ReasonUserDenied
}

// pamDecision tracks one RunPamFlow's entry in the decline store.
type pamDecision struct {
	h         *Heartbeat
	requestID string
	recorded  bool
}

// beginPamDecision records that the dialog for requestID is about to be
// shown. It runs before the helper-session lookup, so an approval that
// arrives while the agent looks for a helper already waits.
func (h *Heartbeat) beginPamDecision(requestID, serverStatus string) (d *pamDecision, alreadyDeclined bool) {
	id := strings.ToLower(requestID)
	d = &pamDecision{h: h, requestID: id}
	already, err := h.pamDeclineStore().BeginAwaiting(id, serverStatus)
	switch {
	case err == nil:
		d.recorded = true
	case errors.Is(err, pamdecline.ErrPersist):
		// Kept in memory: still refused in this process.
		d.recorded = true
		log.Error("pam: could not persist the awaiting decision; enforced in memory only",
			"elevationRequestId", requestID, "error", err.Error())
	default:
		log.Error("pam: could not record the awaiting decision; a remote approval will not wait for this dialog",
			"elevationRequestId", requestID, "error", err.Error())
	}
	return d, already
}

// release forgets an entry whose dialog was never shown.
func (d *pamDecision) release() {
	if d == nil || !d.recorded {
		return
	}
	if err := d.h.pamDeclineStore().Release(d.requestID); err != nil {
		log.Error("pam: could not release the awaiting decision", "elevationRequestId", d.requestID, "error", err.Error())
	}
}

// consent records the user's Approve: the only answer that permits an apply.
func (d *pamDecision) consent() {
	if d == nil || !d.recorded {
		return
	}
	if err := d.h.pamDeclineStore().Consent(d.requestID); err != nil {
		log.Error("pam: could not record the user's approval durably", "elevationRequestId", d.requestID, "error", err.Error())
	}
}

// decline records that the user did not approve. Called BEFORE consent.exe
// is dismissed, so an approval landing during the dismissal is refused.
func (d *pamDecision) decline(reason pamdecline.Reason) {
	if d == nil {
		return
	}
	if err := d.h.pamDeclineStore().Decline(d.requestID, reason); err != nil {
		if errors.Is(err, pamdecline.ErrPersist) {
			log.Error("pam: could not persist the user's decline; enforced in memory until restart",
				"elevationRequestId", d.requestID, "reason", string(reason), "error", err.Error())
		} else {
			log.Error("pam: could not record the user's decline", "elevationRequestId", d.requestID,
				"reason", string(reason), "error", err.Error())
			return
		}
	}
	log.Info("pam: recorded the user's decline", "elevationRequestId", d.requestID, "reason", string(reason))
}

// finish runs when RunPamFlow returns (or unwinds from a recovered panic): an
// entry still awaiting means the flow ended without an answer, which is never
// consent.
func (d *pamDecision) finish() {
	if d == nil || !d.recorded {
		return
	}
	declined, err := d.h.pamDeclineStore().DeclineIfAwaiting(d.requestID, pamdecline.ReasonDialogError)
	if err != nil && !errors.Is(err, pamdecline.ErrPersist) {
		log.Error("pam: could not close the unanswered decision", "elevationRequestId", d.requestID, "error", err.Error())
		return
	}
	if declined {
		log.Warn("pam: elevation flow ended without the user's answer; recorded as declined",
			"elevationRequestId", d.requestID)
		d.h.kickPamWithdrawDrain()
	}
}
