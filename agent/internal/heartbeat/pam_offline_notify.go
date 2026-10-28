package heartbeat

import (
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/etwlua"
)

// The offline notice (#8928 D3): the live elevation submit failed while the
// user's UAC prompt is still on screen, so nobody at IT will see the request.
// The user is told so, and that the Windows prompt still accepts admin
// credentials. The event itself stays queued for the server's records.

// pamOfflineNoticeWindow rate-limits the offline notice to one per program and
// user, so a flapping network does not stack toasts on every retry.
const pamOfflineNoticeWindow = 5 * time.Minute

// pamOfflineNoticeLimiter allows one shown offline notice per key per
// pamOfflineNoticeWindow. Only a shown notice spends the slot: reserve holds
// it while the send is in flight (so two concurrent submit failures cannot
// both toast) and release frees it again when the send failed.
type pamOfflineNoticeLimiter struct {
	mu    sync.Mutex
	now   func() time.Time
	slots map[string]time.Time
}

func newPamOfflineNoticeLimiter(now func() time.Time) *pamOfflineNoticeLimiter {
	if now == nil {
		now = time.Now
	}
	return &pamOfflineNoticeLimiter{now: now, slots: make(map[string]time.Time)}
}

// reserve takes key's slot and returns true, or returns false when a notice
// for key was shown (or is being sent) inside the window.
func (l *pamOfflineNoticeLimiter) reserve(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	for k, at := range l.slots {
		if now.Sub(at) >= pamOfflineNoticeWindow {
			delete(l.slots, k)
		}
	}
	if _, held := l.slots[key]; held {
		return false
	}
	l.slots[key] = now
	return true
}

// release gives back a slot whose notice was not shown.
func (l *pamOfflineNoticeLimiter) release(key string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	delete(l.slots, key)
}

// pamOfflineRateLimiter returns the offline-notice limiter, creating it on
// first use unless a test installed one.
func (h *Heartbeat) pamOfflineRateLimiter() *pamOfflineNoticeLimiter {
	h.pamOfflineLimiterOnce.Do(func() {
		if h.pamOfflineLimiter == nil {
			h.pamOfflineLimiter = newPamOfflineNoticeLimiter(time.Now)
		}
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
	limiter := h.pamOfflineRateLimiter()
	if !limiter.reserve(key) {
		log.Debug("pam: offline notice rate-limited", "user", ev.SubjectUsername, "path", ev.TargetExecutablePath)
		return
	}
	targetWinSession := strconv.FormatUint(uint64(ev.SubjectSessionID), 10)
	title, body := pamCopyOffline(pamProgramName(ev.TargetExecutablePath), h.lastSupportName())
	if err := h.notifyPamUser(title, body, targetWinSession); err != nil {
		// Not shown: give the slot back so the next submit failure can try.
		limiter.release(key)
		log.Warn("pam: elevation submit failed; offline notice not shown", "targetWinSession", targetWinSession,
			"notShownReason", pamNoticeNotShownReason(err), "error", err.Error())
		return
	}
	log.Info("pam: elevation submit failed; showed offline notice", "targetWinSession", targetWinSession)
}
