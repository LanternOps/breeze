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

// open registers a dialog for id and returns its entry.
func (r *pamDialogRegistry) open(id string, cancel context.CancelFunc) *openPamDialog {
	d := &openPamDialog{cancel: cancel, done: make(chan struct{})}
	r.mu.Lock()
	if r.entries == nil {
		r.entries = make(map[string]*openPamDialog)
	}
	r.entries[id] = d
	r.mu.Unlock()
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
	log.Info("pam: elevation dialog close requested", "dialogId", req.DialogID,
		"wasOpen", result.WasOpen, "closed", result.Closed)
	if err := c.conn.SendTyped(env.ID, ipc.TypePamCloseDialogResult, result); err != nil {
		log.Warn("failed to send PAM dialog close result", "id", env.ID, "error", err)
	}
}

// supportsPamDialogCloseForAuth is advertised at auth: only the SYSTEM helper
// shows the PAM dialog, and it honours pam_close_dialog (#10370).
func supportsPamDialogCloseForAuth(role ipc.HelperRole) bool {
	return role == ipc.HelperRoleSystem
}
