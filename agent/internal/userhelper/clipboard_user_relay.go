package userhelper

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
)

// clipboardReadTimeout bounds one read through the service. The service waits
// up to 5 s for the user helper (clipboard proxy), so this leaves it room to
// answer with that failure rather than be cut off. A var so tests can shorten it.
var clipboardReadTimeout = 7 * time.Second

// systemHelperReadsClipboardViaUser reports whether this helper's desktop
// sessions read the clipboard through the user helper (#8393). Only the
// Windows system helper does: it runs as SYSTEM in the user's session, where
// the PNG and JFIF data the user copies is listed but cannot be read. Every
// other helper already runs as the user.
func systemHelperReadsClipboardViaUser(goos string, role ipc.HelperRole) bool {
	return goos == "windows" && role == ipc.HelperRoleSystem
}

// wireDesktopClipboard gives this helper's desktop sessions their clipboard.
// Off the Windows system helper it leaves the default, the local clipboard.
func (c *Client) wireDesktopClipboard(goos string) {
	if !systemHelperReadsClipboardViaUser(goos, c.role) {
		return
	}
	c.desktopMgr.mgr.ClipboardProvider = func(sessionID string) clipboard.Provider {
		return clipboard.NewUserClipboardFallback(
			clipboard.NewSystemClipboard(),
			func() (clipboard.Content, error) { return c.readClipboardViaService(sessionID) },
			clipboard.SequenceNumber,
		)
	}
}

// readClipboardViaService asks the service to read the clipboard through the
// user-role helper in this Windows session, for the desktop session sessionID.
func (c *Client) readClipboardViaService(sessionID string) (clipboard.Content, error) {
	reqID := fmt.Sprintf("clip-read-%d", c.clipReadSeq.Add(1))
	respCh := c.registerPendingResponse(reqID)
	// Safe after resolvePendingResponse, which removes the entry before
	// delivering, so this finds nothing to close.
	defer c.unregisterPendingResponse(reqID)

	conn := c.currentConn()
	if conn == nil {
		return clipboard.Content{}, errors.New("clipboard read: not connected to the service")
	}
	req := ipc.DesktopClipboardReadRequest{SessionID: sessionID}
	if err := conn.SendTyped(reqID, ipc.TypeDesktopClipboardRead, req); err != nil {
		return clipboard.Content{}, fmt.Errorf("clipboard read request: %w", err)
	}

	timer := time.NewTimer(clipboardReadTimeout)
	defer timer.Stop()
	select {
	case <-c.stopChan:
		return clipboard.Content{}, errors.New("clipboard read: IPC stopped")
	case env, ok := <-respCh:
		if !ok || env == nil {
			return clipboard.Content{}, errors.New("clipboard read: IPC closed before the service answered")
		}
		if env.Error != "" {
			return clipboard.Content{}, fmt.Errorf("clipboard read: service error: %s", env.Error)
		}
		var res ipc.DesktopClipboardReadResult
		if err := json.Unmarshal(env.Payload, &res); err != nil {
			return clipboard.Content{}, fmt.Errorf("clipboard read: invalid answer: %w", err)
		}
		return clipboard.ContentFromRelayResult(res)
	case <-timer.C:
		return clipboard.Content{}, fmt.Errorf("clipboard read: no answer from the service within %s", clipboardReadTimeout)
	}
}

// handleDesktopClipboardReadResult delivers the service's answer to the read
// waiting for it. An answer that arrives after its read gave up is dropped.
func (c *Client) handleDesktopClipboardReadResult(env *ipc.Envelope) {
	if !c.resolvePendingResponse(env) {
		log.Debug("late desktop_clipboard_read_result dropped", "id", env.ID)
	}
}
