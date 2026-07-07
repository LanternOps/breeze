package userhelper

import (
	"encoding/json"
	"sync"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Platform seams (swapped in tests).
var (
	showBannerFn = showBannerOS
	hideBannerFn = hideBannerOS
)

var (
	// bannerOpMu serializes the entire show/hide operation — including the
	// showBannerFn/hideBannerFn platform call and the bannerSessionID
	// read/update — so that concurrent banner_show/banner_hide dispatches
	// (each fired in its own goroutine by commandLoop's safeGo, see
	// client.go) can never race. Without this, two concurrent banner_show
	// calls can both observe "no window yet" and both create a native
	// window on Windows (only one HWND survives in bannerHwnd; the other
	// leaks as an unclosable topmost window), and a banner_hide can also
	// observe a stale bannerSessionID while a show for the same session is
	// still in flight. This is a distinct, coarser-grained lock from
	// bannerMu (banner_windows.go), which only guards data
	// (bannerHwnd/bannerLabelU16) shared with the native message-loop
	// goroutine — reusing one mutex for both would deadlock/reenter.
	bannerOpMu sync.Mutex

	bannerSessionID string // session that currently owns the banner ("" = none); guarded by bannerOpMu
)

// handleBannerShow shows (or relabels) the active-session banner. One banner
// window exists at a time; the most recent session owns it.
func handleBannerShow(req ipc.BannerShowRequest) {
	label := stripControl(trimNotifyField(req.Label, maxNotifyTitleBytes))
	if label == "" {
		label = "A technician is connected"
	}
	bannerOpMu.Lock()
	defer bannerOpMu.Unlock()
	if !showBannerFn(label) {
		return // platform has no banner surface (macOS/Linux fallback)
	}
	bannerSessionID = req.SessionID
}

// handleBannerHide hides the banner if the given session owns it. An empty
// session ID force-hides (defensive against malformed daemon payloads).
func handleBannerHide(sessionID string) {
	bannerOpMu.Lock()
	defer bannerOpMu.Unlock()
	owns := sessionID == "" || sessionID == bannerSessionID
	if owns {
		bannerSessionID = ""
		hideBannerFn()
	}
}

func (c *Client) handleBannerShowEnvelope(env *ipc.Envelope) {
	var req ipc.BannerShowRequest
	if err := json.Unmarshal(env.Payload, &req); err != nil {
		log.Warn("invalid banner_show payload", "error", err)
		return
	}
	handleBannerShow(req)
}

func (c *Client) handleBannerHideEnvelope(env *ipc.Envelope) {
	var payload struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(env.Payload, &payload); err != nil {
		log.Warn("invalid banner_hide payload", "error", err)
		return
	}
	handleBannerHide(payload.SessionID)
}
