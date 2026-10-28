package heartbeat

import (
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
	"github.com/breeze-rmm/agent/internal/ipc"
)

// The offline notice (#8928 D3): the live elevation submit failed while the
// user's UAC prompt is still on screen, so nobody at IT will see the request.
// The user is told so, and that the Windows prompt still accepts admin
// credentials. The event itself stays queued for the server's records.

// pamOfflineNoticeWindow rate-limits the offline notice to one per program and
// user, so a flapping network does not stack toasts on every retry.
const pamOfflineNoticeWindow = 5 * time.Minute

// pamOfflineRateLimiter returns the offline-notice limiter, creating it on
// first use.
func (h *Heartbeat) pamOfflineRateLimiter() *ipc.RateLimiter {
	h.pamOfflineLimiterOnce.Do(func() {
		h.pamOfflineLimiter = ipc.NewRateLimiter(1, pamOfflineNoticeWindow)
	})
	return h.pamOfflineLimiter
}

// NotifyElevationSubmitFailed implements etwlua.PamRunner. It runs on the
// etwlua loop goroutine, which has no recover() above it, so a panic is
// contained here rather than taking down the agent.
func (h *Heartbeat) NotifyElevationSubmitFailed(ev etwlua.Event) {
	defer func() {
		if r := recover(); r != nil {
			log.Error("pam: panic while showing the offline notice", "panic", r)
		}
	}()

	// Zero and 0xFFFFFFFF mean the requester session is unresolved. The
	// console fallback the PAM dialog uses could put this notice in front of
	// a different user, so skip it — before spending the rate-limit slot.
	if ev.SubjectSessionID == 0 || ev.SubjectSessionID == 0xFFFFFFFF {
		log.Debug("pam: elevation submit failed; requester session unknown, offline notice skipped")
		return
	}
	key := strings.ToLower(ev.TargetExecutablePath) + "|" + ev.SubjectUsername
	if !h.pamOfflineRateLimiter().Allow(key) {
		log.Debug("pam: offline notice rate-limited", "user", ev.SubjectUsername, "path", ev.TargetExecutablePath)
		return
	}
	targetWinSession := strconv.FormatUint(uint64(ev.SubjectSessionID), 10)
	title, body := pamCopyOffline(pamProgramName(ev.TargetExecutablePath), h.lastSupportName())
	h.notifyPamUser(title, body, targetWinSession)
	log.Info("pam: elevation submit failed; showed offline notice", "targetWinSession", targetWinSession)
}
