package userhelper

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// pam_close_dialog (#10370): on the deny path the agent takes down this
// helper's own PAM elevation dialog before dismissing consent.exe. The dialog
// is topmost and takes the foreground, so while it is open an Escape meant for
// the UAC prompt lands on it instead.

// showPamDialogFn renders the PAM dialog; a test seam. Ending ctx closes the
// custom window (the MessageBox fallback cannot be closed from outside).
var showPamDialogFn = showPamDialog

// pamDialogCloseWait bounds how long pam_close_dialog waits for the window to
// go. consent.exe is still on screen meanwhile, so it stays short; a var so
// tests can shrink it.
var pamDialogCloseWait = 3 * time.Second

const reasonPamDialogStillOpen = "dialog_still_open"

// pamDialogRegistry tracks the PAM dialogs this helper has open, by the
// envelope id of their pam_request_dialog. The zero value is ready to use.
type pamDialogRegistry struct {
	mu      sync.Mutex
	entries map[string]*openPamDialog
}

type openPamDialog struct {
	cancel context.CancelFunc
	done   chan struct{} // closed once the dialog has returned
}

// open registers a dialog for id and returns its entry. A dialog already open
// under id is closed: the agent only re-sends an id after abandoning its
// waiter, so nobody is listening to the older one, and it would otherwise
// stay up holding the foreground where pam_close_dialog cannot reach it.
//
// Accepted gap: a pam_close_dialog that arrives before its dialog was ever
// registered finds nothing, and the late dialog then opens with no waiter.
// The agent sends the close only after the dialog round-trip failed (a
// timeout is 90 s), so this needs a pam_request_dialog delayed that long.
func (r *pamDialogRegistry) open(id string, cancel context.CancelFunc) *openPamDialog {
	d := &openPamDialog{cancel: cancel, done: make(chan struct{})}
	r.mu.Lock()
	if r.entries == nil {
		r.entries = make(map[string]*openPamDialog)
	}
	stale := r.entries[id]
	r.entries[id] = d
	r.mu.Unlock()
	if stale != nil {
		log.Warn("pam: a newer elevation dialog reused an open dialog's id; closing the older one", "dialogId", id)
		stale.cancel()
	}
	return d
}

// finish marks d returned and drops it, unless a newer dialog took the id.
func (r *pamDialogRegistry) finish(id string, d *openPamDialog) {
	r.mu.Lock()
	if r.entries[id] == d {
		delete(r.entries, id)
	}
	r.mu.Unlock()
	close(d.done)
}

func (r *pamDialogRegistry) lookup(id string) *openPamDialog {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.entries[id]
}

// handlePamCloseDialog takes down the open dialog for the requested id and
// replies once it has returned, or once pamDialogCloseWait passes.
func (c *Client) handlePamCloseDialog(env *ipc.Envelope) {
	// Always answer, so the agent learns why instead of waiting out its
	// timeout (safeGo only logs a panic).
	defer func() {
		if r := recover(); r != nil {
			log.Error("PAM dialog close handler panicked", "id", env.ID, "panic", fmt.Sprintf("%v", r))
			if err := c.conn.SendError(env.ID, ipc.TypePamCloseDialogResult, "PAM dialog close handler panicked"); err != nil {
				log.Warn("failed to send PAM dialog close panic response", "id", env.ID, "error", err)
			}
		}
	}()

	if c.role != ipc.HelperRoleSystem || !c.hasScope(ipc.ScopePam) {
		if err := c.conn.SendError(env.ID, ipc.TypePamCloseDialogResult, "pam_close_dialog requires SYSTEM helper with pam scope"); err != nil {
			log.Warn("failed to send unauthorized PAM dialog close response", "id", env.ID, "error", err)
		}
		return
	}
	var req ipc.PamCloseDialog
	if err := json.Unmarshal(env.Payload, &req); err != nil || req.DialogID == "" {
		msg := "invalid payload: missing dialogId"
		if err != nil {
			msg = fmt.Sprintf("invalid payload: %v", err)
		}
		if sendErr := c.conn.SendError(env.ID, ipc.TypePamCloseDialogResult, msg); sendErr != nil {
			log.Warn("failed to send PAM dialog close payload error", "id", env.ID, "error", sendErr)
		}
		return
	}

	result := ipc.PamCloseDialogResult{Closed: true}
	if d := c.pamDialogs.lookup(req.DialogID); d != nil {
		result.WasOpen = true
		d.cancel()
		timer := time.NewTimer(pamDialogCloseWait)
		select {
		case <-d.done:
		case <-timer.C:
			result.Closed = false
			result.Reason = reasonPamDialogStillOpen
		}
		timer.Stop()
	}
	if result.Closed {
		log.Info("pam: elevation dialog close requested", "dialogId", req.DialogID,
			"wasOpen", result.WasOpen, "closed", true)
	} else {
		// The dialog is still on screen and can take the Escape meant for
		// the UAC prompt (e.g. the MessageBox fallback, which cannot be closed
		// from outside).
		log.Warn("pam: elevation dialog did not close when asked; it may take input meant for the UAC prompt",
			"dialogId", req.DialogID, "reason", result.Reason)
	}
	if err := c.conn.SendTyped(env.ID, ipc.TypePamCloseDialogResult, result); err != nil {
		log.Warn("failed to send PAM dialog close result", "id", env.ID, "error", err)
	}
}

// supportsPamDialogCloseForAuth is advertised at auth: only the SYSTEM helper
// shows the PAM dialog, and it honours pam_close_dialog (#10370).
func supportsPamDialogCloseForAuth(role ipc.HelperRole) bool {
	return role == ipc.HelperRoleSystem
}
