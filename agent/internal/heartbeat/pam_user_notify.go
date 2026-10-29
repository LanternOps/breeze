package heartbeat

import (
	"errors"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
)

// PAM end-user outcome notices (#8928).
//
// When a standard user approves a `pending` elevation in the PAM dialog, the
// request is handed to IT. The agent remembers that hand-off here, keyed by
// the server's request ID, so it can tell the user what happened next:
//
//   - approved: pam_apply_v2 reaches verified_active (handlers_actuate.go);
//   - approved but couldn't start: pam_apply_v2 ends failed;
//   - denied / expired: the server's pam_request_notify (handlers_pam_notify.go).
//
// Every outcome notice needs a tracker entry, so auto-approve, policy-deny and
// requests from before an agent restart never toast. The program name and
// support name come from this tracker, never from a server payload.
//
// The tracker is memory-only by design: after a restart the agent cannot tie
// a server request back to a Windows session reliably (ETW SubjectUsername is
// DOMAIN\user and does not match the helper's Session.Username), so it shows
// nothing rather than toasting the wrong person.

// pamTrackedRequestTTL bounds how long a hand-off is remembered. It equals the
// server's pam_request_notify deliverBy window: a notice about an older
// request is noise.
const pamTrackedRequestTTL = 60 * time.Minute

// maxPamTrackedRequests bounds tracker memory against a flood of unanswered
// requests, mirroring maxPendingPamConsents. Eviction only costs a toast.
const maxPamTrackedRequests = 64

const (
	// pamProgramNameMaxRunes matches the copy cap for {p} (MAX_PATH).
	pamProgramNameMaxRunes = 260
	// pamSupportNameMaxRunes matches the server's branding NAME_MAX.
	pamSupportNameMaxRunes = 120
	// pamNotifyReasonMaxRunes is the server's payload cap for the deny reason;
	// the agent refuses anything longer rather than trusting a truncation.
	pamNotifyReasonMaxRunes = 500
	pamProgramFallback      = "the program"
	pamSupportFallback      = "IT"
)

type pamTrackedRequest struct {
	WinSession  string
	Program     string
	SupportName string
	// Notified is set by ClaimNotify: at most one outcome notice per request.
	Notified bool
	expires  time.Time
}

// pamRequestTracker is a mutex-guarded map of the requests the user handed to
// IT, keyed by server request ID and pruned on every write.
type pamRequestTracker struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]pamTrackedRequest
}

func newPamRequestTracker(now func() time.Time) *pamRequestTracker {
	if now == nil {
		now = time.Now
	}
	return &pamRequestTracker{now: now, entries: make(map[string]pamTrackedRequest)}
}

func pamTrackerKey(requestID string) string {
	return strings.ToLower(strings.TrimSpace(requestID))
}

// pruneLocked drops expired entries. Caller holds t.mu.
func (t *pamRequestTracker) pruneLocked(now time.Time) {
	for id, e := range t.entries {
		if !now.Before(e.expires) {
			delete(t.entries, id)
		}
	}
}

// MarkAwaiting records that the user handed requestID to IT. Re-marking a
// request keeps its Notified flag, so a re-fired flow for the same server
// request can never re-arm a second outcome notice.
func (t *pamRequestTracker) MarkAwaiting(requestID, winSession, program, supportName string) {
	key := pamTrackerKey(requestID)
	if key == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	t.pruneLocked(now)
	prev, exists := t.entries[key]
	if !exists && len(t.entries) >= maxPamTrackedRequests {
		t.evictOldestLocked()
	}
	t.entries[key] = pamTrackedRequest{
		WinSession:  winSession,
		Program:     program,
		SupportName: supportName,
		Notified:    exists && prev.Notified,
		expires:     now.Add(pamTrackedRequestTTL),
	}
}

// evictOldestLocked makes room for one more entry. Caller holds t.mu.
func (t *pamRequestTracker) evictOldestLocked() {
	oldestID, oldest := "", time.Time{}
	for id, e := range t.entries {
		if oldestID == "" || e.expires.Before(oldest) {
			oldestID, oldest = id, e.expires
		}
	}
	log.Debug("pam: tracked hand-off evicted at capacity; its outcome notice will not show", "elevationRequestId", oldestID)
	delete(t.entries, oldestID)
}

// Get returns the live entry for requestID. An expired entry reads as absent.
func (t *pamRequestTracker) Get(requestID string) (pamTrackedRequest, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[pamTrackerKey(requestID)]
	if !ok || !t.now().Before(e.expires) {
		return pamTrackedRequest{}, false
	}
	return e, true
}

// ClaimNotify returns the entry and true exactly once per tracked request,
// marking it Notified. It returns false for an untracked, expired or already
// notified request. The entry stays tracked (until Remove or its TTL) so a
// redelivered command cannot claim it again.
func (t *pamRequestTracker) ClaimNotify(requestID string) (pamTrackedRequest, bool) {
	key := pamTrackerKey(requestID)
	t.mu.Lock()
	defer t.mu.Unlock()
	e, ok := t.entries[key]
	if !ok || !t.now().Before(e.expires) || e.Notified {
		return pamTrackedRequest{}, false
	}
	e.Notified = true
	t.entries[key] = e
	return e, true
}

// ReleaseNotify undoes a ClaimNotify whose notice could not be shown, so the
// one-notice budget is spent only by a notice the user actually got. It is a
// no-op for an untracked request.
func (t *pamRequestTracker) ReleaseNotify(requestID string) {
	key := pamTrackerKey(requestID)
	t.mu.Lock()
	defer t.mu.Unlock()
	if e, ok := t.entries[key]; ok {
		e.Notified = false
		t.entries[key] = e
	}
}

// Remove forgets requestID.
func (t *pamRequestTracker) Remove(requestID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, pamTrackerKey(requestID))
}

func (t *pamRequestTracker) lenForTest() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.entries)
}

// pamTracker returns the heartbeat's request tracker, creating it on first use.
func (h *Heartbeat) pamTracker() *pamRequestTracker {
	h.pamRequestsOnce.Do(func() {
		if h.pamRequests == nil {
			h.pamRequests = newPamRequestTracker(time.Now)
		}
	})
	return h.pamRequests
}

// truncateRunes caps s at max runes.
func truncateRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	n := 0
	for i := range s {
		if n == max {
			return s[:i]
		}
		n++
	}
	return s
}

// stripControlRunes removes control characters (C0, DEL, C1) so a display
// name can never carry line breaks or terminal escapes into a notice.
func stripControlRunes(s string) string {
	if strings.IndexFunc(s, unicode.IsControl) < 0 {
		return s
	}
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

// pamProgramName is the {p} of the notice copy: the base name of a target
// path, split on both / and \ (a Windows path parsed on any OS), capped at 260
// runes. An empty result reads "the program".
func pamProgramName(path string) string {
	p := strings.TrimSpace(stripControlRunes(path))
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		p = p[i+1:]
	}
	p = strings.TrimSpace(truncateRunes(p, pamProgramNameMaxRunes))
	if p == "" {
		return pamProgramFallback
	}
	return p
}

// clampSupportName trims and caps a server-supplied support name without the
// "IT" fallback. It is what the agent stores.
func clampSupportName(s string) string {
	return strings.TrimSpace(truncateRunes(strings.TrimSpace(stripControlRunes(s)), pamSupportNameMaxRunes))
}

// pamSupportName is the {s} of the notice copy: the clamped support name, or
// "IT" when there is none.
func pamSupportName(s string) string {
	if c := clampSupportName(s); c != "" {
		return c
	}
	return pamSupportFallback
}

// Notice copy (#8928 Global Constraints). {p} and {s} are normalized here so
// every caller gets the same fallbacks.

// pamCopyWaiting is shown when the user hands a request to IT (PR 2).
func pamCopyWaiting(p, s string) (title, body string) {
	p, s = pamProgramName(p), pamSupportName(s)
	return "Request sent to " + s, p + " needs approval from " + s + ". You'll get a notification when they respond."
}

func pamCopyApproved(p, s string) (title, body string) {
	p, s = pamProgramName(p), pamSupportName(s)
	return "Request approved", p + " was approved by " + s + " and is starting."
}

func pamCopyLaunchFailed(p, s string) (title, body string) {
	p, s = pamProgramName(p), pamSupportName(s)
	return "Request approved", p + " was approved but couldn't start. Contact " + s + "."
}

func pamCopyDenied(p, s, reason string) (title, body string) {
	p, s = pamProgramName(p), pamSupportName(s)
	body = p + " was denied by " + s + "."
	if r := strings.TrimSpace(reason); r != "" {
		body += "\nReason: " + r
	}
	return "Request denied", body
}

func pamCopyExpired(p, s string) (title, body string) {
	p, s = pamProgramName(p), pamSupportName(s)
	return "Request expired", "Your request for " + p + " expired before " + s + " responded. Try again or contact " + s + "."
}

func pamCopyOffline(p, s string) (title, body string) {
	p, s = pamProgramName(p), pamSupportName(s)
	return "Couldn't reach " + s, "Breeze couldn't send the request for " + p + ". If you have administrator credentials, enter them in the Windows prompt."
}

// errPamNoticeNoTargetSession: a PAM notice with no target Windows session.
var errPamNoticeNoTargetSession = errors.New("pam notice has no target session")

// notifyPamUser shows one PAM outcome notice in winSession and returns nil
// only when the notice was handed to a helper in that session. An empty
// session is refused rather than routed to the machine-global notify-helper
// preference: these notices carry the program name and the technician's deny
// reason, and must reach only the user who asked. Callers log "showed" and
// spend their one-notice budget only on a nil return.
func (h *Heartbeat) notifyPamUser(title, body, winSession string) error {
	if winSession == "" {
		log.Warn("pam: outcome notice has no target session; not shown", "title", title)
		return errPamNoticeNoTargetSession
	}
	if sink := h.pamNotifySink; sink != nil {
		return sink(title, body, winSession)
	}
	return h.sendSessionNotifyTitled(title, body, winSession)
}

// pamNoticeNotShownReason is the stable notShownReason a command result
// carries when notifyPamUser failed.
func pamNoticeNotShownReason(err error) string {
	switch {
	case errors.Is(err, errPamNoticeNoTargetSession):
		return "no_target_session"
	case errors.Is(err, errNoticeNoSessionBroker):
		return "no_session_broker"
	case errors.Is(err, errNoticeNoNotifyHelper):
		return "no_notify_helper"
	case errors.Is(err, errNoticeEmptyBody):
		return "empty_body"
	default:
		return "send_failed"
	}
}

// pamUserDecisionFailureCode reports whether a failed pam_apply_v2 ended on
// one of #8971's user-decision codes. The user already chose (declined the
// request locally, or is still choosing), so an "approved but couldn't start"
// notice would contradict them. #8971: these codes may not exist in this
// build yet; they are compared as literals so the guard holds from the day
// that PR lands.
func pamUserDecisionFailureCode(code string) bool {
	switch code {
	case "user_declined", "user_decision_pending", "user_decline_record_untrusted": // #8971
		return true
	}
	return false
}

// notifyPamApplyOutcome shows the approved / approved-but-couldn't-start
// notice for a pam_apply_v2 result, at most once per tracked request:
// pam_apply_v2 is redelivered on reconnect and on a generation bump, and
// ClaimNotify makes every redelivery after the first shown notice silent. A
// notice that could not be delivered releases its claim, so a redelivery can
// try again. Untracked requests (auto-approve, before a restart) and
// non-terminal states show nothing.
func (h *Heartbeat) notifyPamApplyOutcome(requestID string, result pamlifetime.Result, technician string) {
	var copyFn func(p, s string) (string, string)
	var kind string
	var state ipc.PromptState
	switch result.State {
	case pamlifetime.ResultVerifiedActive:
		copyFn, kind, state = pamCopyApproved, "approved", ipc.PromptStateApproved
	case pamlifetime.ResultFailed:
		if pamUserDecisionFailureCode(result.FailureCode) {
			return
		}
		copyFn, kind, state = pamCopyLaunchFailed, "approved-but-couldn't-start", ipc.PromptStateFailed
	default:
		return
	}
	// #10190 W07: the elevation prompt shows the outcome; when Assist holds
	// it, the notice is not shown too (its one-notice budget is spent).
	onAssist := h.elevationOutcome(requestID, state, technician, "")
	tracker := h.pamTracker()
	entry, ok := tracker.ClaimNotify(requestID)
	if !ok || onAssist {
		return
	}
	title, body := copyFn(entry.Program, entry.SupportName)
	if err := h.notifyPamUser(title, body, entry.WinSession); err != nil {
		tracker.ReleaseNotify(requestID)
		log.Warn("pam: "+kind+" notice not shown; a redelivered pam_apply_v2 may retry it",
			"elevationRequestId", requestID, "failureCode", result.FailureCode,
			"targetWinSession", entry.WinSession, "notShownReason", pamNoticeNotShownReason(err), "error", err.Error())
		return
	}
	log.Info("pam: showed "+kind+" notice", "elevationRequestId", requestID,
		"failureCode", result.FailureCode, "targetWinSession", entry.WinSession)
}
