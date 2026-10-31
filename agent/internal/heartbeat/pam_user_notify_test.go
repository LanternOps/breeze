package heartbeat

import (
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"
)

// pamFakeClock is a mutex-guarded settable clock for the tracker tests.
type pamFakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newPamFakeClock() *pamFakeClock {
	return &pamFakeClock{now: time.Date(2026, 10, 27, 12, 0, 0, 0, time.UTC)}
}

func (c *pamFakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *pamFakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// pamNotifyCall is one notice captured by the pamNotifySink test seam.
type pamNotifyCall struct {
	Title, Body, WinSession string
}

// pamNotifyRecorder installs a recording pamNotifySink on h. Calls holds the
// notices that were shown; while FailWith has set an error, every send fails
// with it, is counted in Attempts and is not recorded as shown.
type pamNotifyRecorder struct {
	mu       sync.Mutex
	calls    []pamNotifyCall
	attempts int
	fail     error
}

func recordPamNotices(h *Heartbeat) *pamNotifyRecorder {
	r := &pamNotifyRecorder{}
	h.pamNotifySink = func(title, body, winSession string) error {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.attempts++
		if r.fail != nil {
			return r.fail
		}
		r.calls = append(r.calls, pamNotifyCall{Title: title, Body: body, WinSession: winSession})
		return nil
	}
	return r
}

func (r *pamNotifyRecorder) Calls() []pamNotifyCall {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]pamNotifyCall(nil), r.calls...)
}

// FailWith makes every later send fail with err; nil restores success.
func (r *pamNotifyRecorder) FailWith(err error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.fail = err
}

func (r *pamNotifyRecorder) Attempts() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.attempts
}

const (
	pamNotifyTestRequestA = "40000000-0000-4000-8000-00000000000a"
	pamNotifyTestRequestB = "40000000-0000-4000-8000-00000000000b"
)

// Entries are keyed by the server request ID, never by the program: two
// requests for the same program (inside the 30s ETW dedupe window) are two
// independent entries.
func TestTrackerKeysByRequestID(t *testing.T) {
	tr := newPamRequestTracker(newPamFakeClock().Now)
	tr.MarkAwaiting(pamNotifyTestRequestA, "3", "mmc.exe", "Contoso IT")
	tr.MarkAwaiting(pamNotifyTestRequestB, "4", "mmc.exe", "Contoso IT")

	a, ok := tr.Get(pamNotifyTestRequestA)
	if !ok || a.WinSession != "3" || a.Program != "mmc.exe" || a.SupportName != "Contoso IT" || a.Notified {
		t.Fatalf("entry A = %+v ok=%v", a, ok)
	}
	b, ok := tr.Get(pamNotifyTestRequestB)
	if !ok || b.WinSession != "4" {
		t.Fatalf("entry B = %+v ok=%v", b, ok)
	}

	// Claiming A must not affect B.
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestA); !ok {
		t.Fatal("first claim of A must succeed")
	}
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestB); !ok {
		t.Fatal("claim of B must be independent of A")
	}

	tr.Remove(pamNotifyTestRequestA)
	if _, ok := tr.Get(pamNotifyTestRequestA); ok {
		t.Fatal("A must be gone after Remove")
	}
	if _, ok := tr.Get(pamNotifyTestRequestB); !ok {
		t.Fatal("removing A must not remove B")
	}
	if _, ok := tr.Get("40000000-0000-4000-8000-0000000000ff"); ok {
		t.Fatal("unknown request must be absent")
	}
}

func TestTrackerExpires(t *testing.T) {
	clock := newPamFakeClock()
	tr := newPamRequestTracker(clock.Now)
	tr.MarkAwaiting(pamNotifyTestRequestA, "3", "mmc.exe", "")

	clock.Advance(pamTrackedRequestTTL - time.Second)
	if _, ok := tr.Get(pamNotifyTestRequestA); !ok {
		t.Fatal("entry must still be present just inside the TTL")
	}

	clock.Advance(2 * time.Second)
	if _, ok := tr.Get(pamNotifyTestRequestA); ok {
		t.Fatal("expired entry must read as absent")
	}
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestA); ok {
		t.Fatal("expired entry must not be claimable")
	}

	// Pruned on write: the expired entry is physically dropped by the next
	// MarkAwaiting, so the map cannot grow without bound.
	tr.MarkAwaiting(pamNotifyTestRequestB, "4", "cmd.exe", "")
	if n := tr.lenForTest(); n != 1 {
		t.Fatalf("tracker holds %d entries after a pruning write, want 1", n)
	}
}

func TestClaimNotifyOnce(t *testing.T) {
	tr := newPamRequestTracker(newPamFakeClock().Now)
	tr.MarkAwaiting(pamNotifyTestRequestA, "3", "mmc.exe", "Contoso IT")

	entry, ok := tr.ClaimNotify(pamNotifyTestRequestA)
	if !ok || entry.Program != "mmc.exe" || entry.WinSession != "3" || entry.SupportName != "Contoso IT" {
		t.Fatalf("first claim = %+v ok=%v", entry, ok)
	}
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestA); ok {
		t.Fatal("second claim must fail")
	}
	got, ok := tr.Get(pamNotifyTestRequestA)
	if !ok || !got.Notified {
		t.Fatalf("claimed entry must stay tracked and read Notified=true, got %+v ok=%v", got, ok)
	}

	// Re-marking an already-notified request (a re-fired flow for the same
	// server request) must not re-arm a second toast.
	tr.MarkAwaiting(pamNotifyTestRequestA, "3", "mmc.exe", "Contoso IT")
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestA); ok {
		t.Fatal("re-marking a notified request must not allow another claim")
	}

	if _, ok := tr.ClaimNotify("40000000-0000-4000-8000-0000000000ff"); ok {
		t.Fatal("untracked request must not be claimable")
	}
}

func TestPamCopy(t *testing.T) {
	type pair struct{ title, body string }
	two := func(title, body string) pair { return pair{title, body} }

	cases := []struct {
		name string
		got  pair
		want pair
	}{
		{"waiting", two(pamCopyWaiting("mmc.exe", "Contoso IT")), pair{
			"Request sent to Contoso IT",
			"mmc.exe needs approval from Contoso IT. You'll get a notification when they respond.",
		}},
		{"waiting/IT", two(pamCopyWaiting("mmc.exe", "")), pair{
			"Request sent to IT",
			"mmc.exe needs approval from IT. You'll get a notification when they respond.",
		}},
		{"approved", two(pamCopyApproved("mmc.exe", "Contoso IT")), pair{
			"Request approved",
			"mmc.exe was approved by Contoso IT and is starting.",
		}},
		{"approved/IT", two(pamCopyApproved("mmc.exe", "")), pair{
			"Request approved",
			"mmc.exe was approved by IT and is starting.",
		}},
		{"launch failed", two(pamCopyLaunchFailed("mmc.exe", "Contoso IT")), pair{
			"Request approved",
			"mmc.exe was approved but couldn't start. Contact Contoso IT.",
		}},
		{"launch failed/IT", two(pamCopyLaunchFailed("mmc.exe", "")), pair{
			"Request approved",
			"mmc.exe was approved but couldn't start. Contact IT.",
		}},
		{"denied with reason", two(pamCopyDenied("mmc.exe", "Contoso IT", "Use the self-service portal.")), pair{
			"Request denied",
			"mmc.exe was denied by Contoso IT.\nReason: Use the self-service portal.",
		}},
		{"denied with reason/IT", two(pamCopyDenied("mmc.exe", "", "Not today")), pair{
			"Request denied",
			"mmc.exe was denied by IT.\nReason: Not today",
		}},
		{"denied without reason", two(pamCopyDenied("mmc.exe", "Contoso IT", "")), pair{
			"Request denied",
			"mmc.exe was denied by Contoso IT.",
		}},
		{"denied blank reason", two(pamCopyDenied("mmc.exe", "", "  \n ")), pair{
			"Request denied",
			"mmc.exe was denied by IT.",
		}},
		{"expired", two(pamCopyExpired("mmc.exe", "Contoso IT")), pair{
			"Request expired",
			"Your request for mmc.exe expired before Contoso IT responded. Try again or contact Contoso IT.",
		}},
		{"expired/IT", two(pamCopyExpired("mmc.exe", "")), pair{
			"Request expired",
			"Your request for mmc.exe expired before IT responded. Try again or contact IT.",
		}},
		{"offline", two(pamCopyOffline("mmc.exe", "Contoso IT")), pair{
			"Couldn't reach Contoso IT",
			"Breeze couldn't send the request for mmc.exe. If you have administrator credentials, enter them in the Windows prompt.",
		}},
		{"offline/IT", two(pamCopyOffline("mmc.exe", "")), pair{
			"Couldn't reach IT",
			"Breeze couldn't send the request for mmc.exe. If you have administrator credentials, enter them in the Windows prompt.",
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Fatalf("got  %q / %q\nwant %q / %q", tc.got.title, tc.got.body, tc.want.title, tc.want.body)
			}
		})
	}
}

func TestPamProgramName(t *testing.T) {
	long := strings.Repeat("é", 300) + ".exe"
	cases := []struct {
		in, want string
	}{
		{`C:\Windows\System32\mmc.exe`, "mmc.exe"},
		{`C:/Program Files/Foo/foo.exe`, "foo.exe"},
		{`\\server\share\tools\setup.exe`, "setup.exe"},
		{`C:\mixed/sep\thing.exe`, "thing.exe"},
		{"plain.exe", "plain.exe"},
		{"  spaced.exe  ", "spaced.exe"},
		{"", "the program"},
		{"   ", "the program"},
		{`C:\Windows\`, "the program"},
		{long, strings.Repeat("é", 260)},
	}
	for _, tc := range cases {
		if got := pamProgramName(tc.in); got != tc.want {
			t.Errorf("pamProgramName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestPamSupportName(t *testing.T) {
	cases := []struct{ in, want string }{
		{"Contoso IT", "Contoso IT"},
		{"  Contoso IT \n", "Contoso IT"},
		{"", "IT"},
		{"   ", "IT"},
		{strings.Repeat("ü", 130), strings.Repeat("ü", 120)},
	}
	for _, tc := range cases {
		if got := pamSupportName(tc.in); got != tc.want {
			t.Errorf("pamSupportName(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

// notifyPamUser routes through the test seam when one is installed, and
// reports (not panics) a heartbeat with no session broker as not shown.
func TestNotifyPamUserUsesSinkAndToleratesNoBroker(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	if err := h.notifyPamUser("Request approved", "mmc.exe was approved by IT and is starting.", "7"); err != nil {
		t.Fatalf("notifyPamUser = %v, want nil", err)
	}
	calls := rec.Calls()
	if len(calls) != 1 || calls[0] != (pamNotifyCall{"Request approved", "mmc.exe was approved by IT and is starting.", "7"}) {
		t.Fatalf("sink calls = %+v", calls)
	}

	bare := &Heartbeat{}
	err := bare.notifyPamUser("Request approved", "body", "7") // must not panic
	if !errors.Is(err, errNoticeNoSessionBroker) {
		t.Fatalf("no-broker notifyPamUser = %v, want errNoticeNoSessionBroker", err)
	}
	if got := pamNoticeNotShownReason(err); got != "no_session_broker" {
		t.Fatalf("reason = %q, want no_session_broker", got)
	}
}

// A PAM notice carries the deny reason: with no target session it is dropped,
// never routed to the machine-global preferred helper (another user's session
// on a multi-session host), and reported as not shown.
func TestNotifyPamUserRefusesEmptySession(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	err := h.notifyPamUser("Request denied", "mmc.exe was denied by IT.\nReason: no", "")
	if !errors.Is(err, errPamNoticeNoTargetSession) {
		t.Fatalf("notifyPamUser = %v, want errPamNoticeNoTargetSession", err)
	}
	if calls := rec.Calls(); len(calls) != 0 {
		t.Fatalf("notice with no session was shown: %+v", calls)
	}
}

// A failed send is surfaced to the caller with a stable reason code.
func TestNotifyPamUserReportsSendFailure(t *testing.T) {
	h := &Heartbeat{}
	rec := recordPamNotices(h)
	rec.FailWith(errNoticeNoNotifyHelper)
	err := h.notifyPamUser("Request approved", "body", "7")
	if !errors.Is(err, errNoticeNoNotifyHelper) {
		t.Fatalf("notifyPamUser = %v, want errNoticeNoNotifyHelper", err)
	}
	for in, want := range map[error]string{
		errPamNoticeNoTargetSession:                     "no_target_session",
		errNoticeNoSessionBroker:                        "no_session_broker",
		errNoticeNoNotifyHelper:                         "no_notify_helper",
		errors.New("pipe closed"):                       "send_failed",
		fmt.Errorf("wrap: %w", errNoticeNoNotifyHelper): "no_notify_helper",
	} {
		if got := pamNoticeNotShownReason(in); got != want {
			t.Errorf("pamNoticeNotShownReason(%v) = %q, want %q", in, got, want)
		}
	}
}

// The one-notice budget is spent only by a notice that was shown: a claim
// whose send failed can be released and claimed again.
func TestReleaseNotifyReArmsAClaim(t *testing.T) {
	tr := newPamRequestTracker(newPamFakeClock().Now)
	tr.MarkAwaiting(pamNotifyTestRequestA, "3", "mmc.exe", "Contoso IT")
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestA); !ok {
		t.Fatal("first claim failed")
	}
	tr.ReleaseNotify(pamNotifyTestRequestA)
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestA); !ok {
		t.Fatal("a released claim must be claimable again")
	}
	if _, ok := tr.ClaimNotify(pamNotifyTestRequestA); ok {
		t.Fatal("an unreleased claim must stay spent")
	}
	tr.ReleaseNotify("40000000-0000-4000-8000-0000000000ff") // untracked: no-op, no panic
	if n := tr.lenForTest(); n != 1 {
		t.Fatalf("ReleaseNotify of an untracked request created an entry: len=%d", n)
	}
}
