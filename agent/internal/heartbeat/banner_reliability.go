package heartbeat

import (
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// Session banner delivery (#10316).
//
// The on-screen "technician is connected" banner is closed only by a
// banner_hide envelope, and that envelope is fire-and-forget: the helpers
// never answer it. A hide that found no helper (lookup miss, a helper
// reconnecting as the session ended) or whose write failed left the banner up
// until the helper process restarted. Two safety nets close that gap:
//
//   - Bounded re-send. A hide for a banner this agent showed is sent now and
//     again on a fixed schedule (defaultBannerHideRetryDelays), re-resolving
//     the helper each time, so a helper that comes back gets it. Hides are
//     idempotent, so re-sending one that already landed is harmless.
//   - Liveness sweep. Every bannerSweepInterval the agent checks each banner it
//     showed against the places a desktop session lives (an owning helper that
//     is still connected, the in-process WebRTC manager, the WebSocket stream
//     manager). A banner whose session is in none of them on
//     bannerSweepMissesToHide sweeps in a row is hidden: its end was never
//     seen, or never reached a helper.
//
// Neither may hide a live session's banner. The assist helper draws one banner
// window for every session and closes it on any banner_hide, whatever session
// id it carries, so a hide is held back while another session's banner is up
// where the hide would land (bannerHideConflictLocked). A session shown again
// (a viewer reconnecting under the same id) cancels its pending re-sends.

// defaultBannerHideRetryDelays are the re-send times after the first hide,
// measured from that first hide. About two minutes in all, enough to outlast
// a helper restart.
var defaultBannerHideRetryDelays = []time.Duration{
	2 * time.Second,
	5 * time.Second,
	15 * time.Second,
	30 * time.Second,
	60 * time.Second,
	120 * time.Second,
}

const (
	// bannerSweepInterval paces the liveness sweep.
	bannerSweepInterval = 30 * time.Second
	// bannerSweepMissesToHide is how many sweeps in a row must find a banner's
	// session gone before it is hidden, so a session caught mid-handoff (an
	// owner being replaced) is never mistaken for an ended one.
	bannerSweepMissesToHide = 2
)

// bannerTracker is the agent's record of the banners it asked a helper to
// show. Its mutex also serializes every banner_show/banner_hide send, so the
// wire order matches the decision order: a hide that checked "no other banner
// is up" cannot overtake a show that then raised one.
type bannerTracker struct {
	mu sync.Mutex
	// shown: desktop session id -> banner shown and not yet ended.
	shown map[string]*shownBanner
	// pending: desktop session id -> hide still being re-sent.
	pending map[string]*pendingBannerHide
}

type shownBanner struct {
	target string // the Windows session it was shown in ("" = untargeted)
	misses int    // consecutive sweeps that found its session gone
}

type pendingBannerHide struct {
	target    string
	delivered bool // at least one send reached a helper
}

// bannerUISession resolves the helper that draws the banner for target.
func (h *Heartbeat) bannerUISession(target string) *sessionbroker.Session {
	if h.bannerUISessionFn != nil {
		return h.bannerUISessionFn(target)
	}
	return h.consentUISessionForTarget(target)
}

// sendBannerShow tells the consent-UI helper (assist app, or the native
// user-helper as fallback) to display the on-screen session indicator
// banner, and records it so its end is re-sent and swept (see above). See
// consentUISessionForTarget for the targeting semantics.
func (h *Heartbeat) sendBannerShow(sessionID string, prompt *ipc.DesktopPrompt, targetWinSession string) {
	if h.sessionBroker == nil {
		return
	}
	b := &h.banners
	b.mu.Lock()
	defer b.mu.Unlock()
	session := h.bannerUISession(targetWinSession)
	if session == nil {
		log.Warn("no consent-ui-capable helper for session banner", "sessionId", sessionID)
		return
	}
	if b.shown == nil {
		b.shown = make(map[string]*shownBanner)
	}
	b.shown[sessionID] = &shownBanner{target: targetWinSession}
	// Shown again: re-sends owed to an earlier end of this id would now
	// take down the live banner.
	delete(b.pending, sessionID)
	req := ipc.BannerShowRequest{
		SessionID:       sessionID,
		Label:           bannerLabel(prompt),
		StartedAtUnixMs: time.Now().UnixMilli(),
	}
	if err := session.SendNotify("banner-show-"+sessionID, ipc.TypeBannerShow, req); err != nil {
		log.Warn("failed to send banner show", "sessionId", sessionID, "error", err.Error())
	}
}

// sendBannerHide tells the consent-UI helper to remove the session banner. A
// banner this agent showed gets the bounded re-send schedule; any other call
// (the unconditional hides on the stream stop paths) is a single send, as
// before. targetWinSession is used only when no banner was recorded: a
// recorded banner is hidden where it was shown.
func (h *Heartbeat) sendBannerHide(sessionID, targetWinSession string) {
	h.hideBanner(sessionID, targetWinSession, nil)
}

// hideBanner is sendBannerHide; a non-nil expect hides only while expect is
// still the session's recorded banner (the sweep's decision must not land on
// a banner shown again after it was made).
func (h *Heartbeat) hideBanner(sessionID, targetWinSession string, expect *shownBanner) {
	if h.sessionBroker == nil {
		return
	}
	b := &h.banners
	b.mu.Lock()
	rec, wasShown := b.shown[sessionID]
	if expect != nil && rec != expect {
		b.mu.Unlock()
		log.Debug("swept banner hide skipped: the session was shown again", "sessionId", sessionID)
		return
	}
	if wasShown {
		delete(b.shown, sessionID)
		targetWinSession = rec.target
	}
	sent, held := h.sendBannerHideLocked(sessionID, targetWinSession, false)
	var p *pendingBannerHide
	if wasShown && !held {
		p = &pendingBannerHide{target: targetWinSession, delivered: sent}
		if b.pending == nil {
			b.pending = make(map[string]*pendingBannerHide)
		}
		b.pending[sessionID] = p
	}
	delays := h.bannerHideRetryDelays
	b.mu.Unlock()
	if p == nil {
		return
	}
	if delays == nil {
		delays = defaultBannerHideRetryDelays
	}
	go h.resendBannerHide(sessionID, p, delays)
}

// sendBannerHideLocked sends one banner_hide. held reports that it was not
// sent because another session's banner is up where it would land; sent
// that a helper took it. A re-send logs a missing helper at Debug: a helper
// restarting is what the re-sends are for, and resendBannerHide warns once if
// none of them ever lands. Callers hold h.banners.mu.
func (h *Heartbeat) sendBannerHideLocked(sessionID, target string, resend bool) (sent, held bool) {
	if other := h.banners.bannerHideConflictLocked(sessionID, target); other != "" {
		log.Info("session banner hide held: another session's banner is up",
			"sessionId", sessionID, "liveSessionId", other, "resend", resend)
		return false, true
	}
	session := h.bannerUISession(target)
	if session == nil {
		if resend {
			log.Debug("no consent-ui-capable helper for banner hide re-send", "sessionId", sessionID, "targetWinSession", target)
		} else {
			log.Warn("no consent-ui-capable helper to hide session banner", "sessionId", sessionID, "targetWinSession", target)
		}
		return false, false
	}
	if err := session.SendNotify("banner-hide-"+sessionID, ipc.TypeBannerHide, map[string]any{"sessionId": sessionID}); err != nil {
		log.Warn("failed to send banner hide", "sessionId", sessionID, "error", err.Error())
		return false, false
	}
	return true, false
}

// bannerHideConflictLocked returns another session whose banner is up where a
// hide for target could land, or "". An untargeted banner or hide resolves to
// the machine-preferred helper, which may be any session's, so "" conflicts
// with everything.
func (b *bannerTracker) bannerHideConflictLocked(sessionID, target string) string {
	for id, rec := range b.shown {
		if id == sessionID {
			continue
		}
		if target == "" || rec.target == "" || rec.target == target {
			return id
		}
	}
	return ""
}

// resendBannerHide re-sends p's hide on the delays schedule (offsets from
// now). It stops early when the session is shown again, or when another
// session's banner comes up where the hide would land.
func (h *Heartbeat) resendBannerHide(sessionID string, p *pendingBannerHide, delays []time.Duration) {
	start := time.Now()
	b := &h.banners
	for _, d := range delays {
		timer := time.NewTimer(time.Until(start.Add(d)))
		select {
		case <-timer.C:
		case <-h.stopChan:
			timer.Stop()
			return
		}
		b.mu.Lock()
		if b.pending[sessionID] != p {
			b.mu.Unlock()
			return
		}
		sent, held := h.sendBannerHideLocked(sessionID, p.target, true)
		if held {
			delete(b.pending, sessionID)
			b.mu.Unlock()
			return
		}
		if sent {
			p.delivered = true
		}
		b.mu.Unlock()
	}
	b.mu.Lock()
	if b.pending[sessionID] == p {
		delete(b.pending, sessionID)
	}
	delivered := p.delivered
	b.mu.Unlock()
	if !delivered {
		log.Warn("session banner hide never reached a helper; the banner may stay up until the helper restarts",
			"sessionId", sessionID, "targetWinSession", p.target)
	}
}

// desktopSessionLive reports whether a desktop session still exists anywhere
// this agent runs one: an owning helper that is still connected, the
// in-process WebRTC manager, or the WebSocket stream manager.
func (h *Heartbeat) desktopSessionLive(sessionID string) bool {
	if h.desktopOwnerSession(sessionID) != nil {
		return true
	}
	if h.desktopMgr != nil && h.desktopMgr.HasSession(sessionID) {
		return true
	}
	if h.wsDesktopMgr != nil && h.wsDesktopMgr.HasSession(sessionID) {
		return true
	}
	return false
}

// sweepSessionBanners hides every recorded banner whose desktop session has
// been gone for bannerSweepMissesToHide sweeps in a row. Liveness is read
// without h.banners.mu held: the session managers' stop paths end in
// sendBannerHide, which takes it.
func (h *Heartbeat) sweepSessionBanners() {
	b := &h.banners
	b.mu.Lock()
	ids := make([]string, 0, len(b.shown))
	for id := range b.shown {
		ids = append(ids, id)
	}
	b.mu.Unlock()
	if len(ids) == 0 {
		return
	}

	live := make(map[string]bool, len(ids))
	for _, id := range ids {
		live[id] = h.desktopSessionLive(id)
	}

	gone := map[string]*shownBanner{}
	b.mu.Lock()
	for _, id := range ids {
		rec, ok := b.shown[id]
		if !ok {
			continue // ended meanwhile
		}
		if live[id] {
			rec.misses = 0
			continue
		}
		rec.misses++
		if rec.misses >= bannerSweepMissesToHide {
			gone[id] = rec
		}
	}
	b.mu.Unlock()

	for id, rec := range gone {
		log.Warn("session banner outlived its desktop session; hiding it", "sessionId", id)
		h.hideBanner(id, "", rec)
	}
}

// startSessionBannerSweep runs sweepSessionBanners until the agent stops.
func (h *Heartbeat) startSessionBannerSweep() {
	go func() {
		ticker := time.NewTicker(bannerSweepInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				h.sweepSessionBanners()
			case <-h.stopChan:
				return
			}
		}
	}()
}
