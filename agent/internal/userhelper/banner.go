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
	bannerSessionMu sync.Mutex
	bannerSessionID string // session that currently owns the banner ("" = none)
)

// handleBannerShow shows (or relabels) the active-session banner. One banner
// window exists at a time; the most recent session owns it.
func handleBannerShow(req ipc.BannerShowRequest) {
	label := stripControl(trimNotifyField(req.Label, maxNotifyTitleBytes))
	if label == "" {
		label = "A technician is connected"
	}
	if !showBannerFn(label) {
		return // platform has no banner surface (macOS/Linux fallback)
	}
	bannerSessionMu.Lock()
	bannerSessionID = req.SessionID
	bannerSessionMu.Unlock()
}

// handleBannerHide hides the banner if the given session owns it. An empty
// session ID force-hides (defensive against malformed daemon payloads).
func handleBannerHide(sessionID string) {
	bannerSessionMu.Lock()
	owns := sessionID == "" || sessionID == bannerSessionID
	if owns {
		bannerSessionID = ""
	}
	bannerSessionMu.Unlock()
	if owns {
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
