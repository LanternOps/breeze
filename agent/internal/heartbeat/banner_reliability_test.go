package heartbeat

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// #10316: the session banner is closed only by one banner_hide. These tests
// cover the bounded re-send of that hide and the liveness sweep that hides a
// banner whose session is gone, and that neither ever hides a live session.

const (
	bannerTestSession  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	bannerTestSession2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
)

// bannerTestHeartbeat returns a Heartbeat whose consent-UI helper lookup is
// the swappable *helper, so a test can take the helper away and bring a new
// one back the way a helper reconnect does.
func bannerTestHeartbeat(t *testing.T, helper *atomic.Pointer[sessionbroker.Session]) *Heartbeat {
	t.Helper()
	h := &Heartbeat{
		desktopMgr:   desktop.NewSessionManager(),
		wsDesktopMgr: desktop.NewWsSessionManager(),
	}
	h.sessionBroker = newTestBrokerWithSessions(t)
	h.bannerUISessionFn = func(string) *sessionbroker.Session { return helper.Load() }
	h.bannerHideRetryDelays = []time.Duration{20 * time.Millisecond, 40 * time.Millisecond, 60 * time.Millisecond}
	return h
}

// recvWithin returns the next envelope, or nil when none arrives in d.
func (c *consentHelper) recvWithin(d time.Duration) *ipc.Envelope {
	_ = c.client.SetReadDeadline(time.Now().Add(d))
	env, err := c.client.Recv()
	if err != nil {
		return nil
	}
	return env
}

func bannerHideSessionID(t *testing.T, env *ipc.Envelope) string {
	t.Helper()
	var p struct {
		SessionID string `json:"sessionId"`
	}
	if err := json.Unmarshal(env.Payload, &p); err != nil {
		t.Fatalf("bad banner_hide payload: %v", err)
	}
	return p.SessionID
}

func bannerTestPrompt() *ipc.DesktopPrompt {
	return &ipc.DesktopPrompt{Mode: "notify", TechnicianName: mustString("Test Tech"), ShowIndicator: true}
}

// A hide that finds no helper (lookup miss, helper reconnecting) is not
// dropped: it is re-sent to the helper that comes back.
func TestBannerHideIsResentToAHelperThatComesBack(t *testing.T) {
	first := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(first.session)
	h := bannerTestHeartbeat(t, &cur)

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	if env := first.recv(t); env == nil || env.Type != ipc.TypeBannerShow {
		t.Fatalf("expected banner_show, got %+v", env)
	}

	// Wide enough that a loaded -race host cannot run out the schedule
	// before the helper is back.
	h.bannerHideRetryDelays = []time.Duration{150 * time.Millisecond, 300 * time.Millisecond, 600 * time.Millisecond}
	second := newConsentHelper(t, []string{ipc.ScopeConsentUI})

	cur.Store(nil) // the helper is gone when the session ends
	h.sendBannerHide(bannerTestSession, "")
	cur.Store(second.session)
	env := second.recvWithin(2 * time.Second)
	if env == nil || env.Type != ipc.TypeBannerHide {
		t.Fatalf("the hide must be re-sent to the helper that came back, got %+v", env)
	}
	if got := bannerHideSessionID(t, env); got != bannerTestSession {
		t.Fatalf("banner_hide sessionId = %q", got)
	}
}

// The re-sends are bounded: after the schedule runs out nothing more is sent.
func TestBannerHideResendsAreBounded(t *testing.T) {
	helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(helper.session)
	h := bannerTestHeartbeat(t, &cur)

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	_ = helper.recv(t)
	h.sendBannerHide(bannerTestSession, "")

	hides := 0
	for env := helper.recvWithin(500 * time.Millisecond); env != nil; env = helper.recvWithin(500 * time.Millisecond) {
		if env.Type == ipc.TypeBannerHide {
			hides++
		}
	}
	if want := 1 + len(h.bannerHideRetryDelays); hides != want {
		t.Fatalf("hides sent = %d, want %d (one now plus one per retry delay)", hides, want)
	}
}

// A banner hide must never land while another session's banner is up in the
// same place: the assist helper draws one banner window for every session,
// so that hide would take down the live session's indicator.
func TestBannerHideNeverHidesAnotherLiveSessionsBanner(t *testing.T) {
	helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(helper.session)
	h := bannerTestHeartbeat(t, &cur)

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	_ = helper.recv(t)
	h.sendBannerShow(bannerTestSession2, bannerTestPrompt(), "")
	_ = helper.recv(t)

	h.sendBannerHide(bannerTestSession, "")
	if env := helper.recvWithin(300 * time.Millisecond); env != nil {
		t.Fatalf("no hide may be sent while another session's banner is live, got %s", env.Type)
	}

	h.sendBannerHide(bannerTestSession2, "")
	env := helper.recvWithin(2 * time.Second)
	if env == nil || env.Type != ipc.TypeBannerHide || bannerHideSessionID(t, env) != bannerTestSession2 {
		t.Fatalf("the last session's end must hide the banner, got %+v", env)
	}
}

// A session shown again (viewer reconnect under the same id) cancels the
// re-sends still owed to its earlier end.
func TestBannerReshowCancelsPendingHides(t *testing.T) {
	helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(helper.session)
	h := bannerTestHeartbeat(t, &cur)
	// The first re-send must not fire before the re-show on a slow host.
	h.bannerHideRetryDelays = []time.Duration{300 * time.Millisecond, 600 * time.Millisecond}

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	_ = helper.recv(t)
	h.sendBannerHide(bannerTestSession, "")
	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	if env := helper.recv(t); env == nil || env.Type != ipc.TypeBannerHide {
		t.Fatalf("expected the immediate hide, got %+v", env)
	}
	if env := helper.recv(t); env == nil || env.Type != ipc.TypeBannerShow {
		t.Fatalf("expected the re-show, got %+v", env)
	}

	for env := helper.recvWithin(time.Second); env != nil; env = helper.recvWithin(time.Second) {
		if env.Type == ipc.TypeBannerHide {
			t.Fatal("a re-shown session's banner must not be hidden by its earlier end's re-sends")
		}
	}
}

// Fallback for an end the agent never saw: a banner whose session no longer
// exists anywhere is hidden after two sweeps in a row find it gone.
func TestBannerSweepHidesABannerWhoseSessionIsGone(t *testing.T) {
	helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(helper.session)
	h := bannerTestHeartbeat(t, &cur)

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	_ = helper.recv(t)

	h.sweepSessionBanners()
	if env := helper.recvWithin(200 * time.Millisecond); env != nil {
		t.Fatalf("one missed sweep must not hide the banner yet, got %s", env.Type)
	}
	h.sweepSessionBanners()
	env := helper.recvWithin(2 * time.Second)
	if env == nil || env.Type != ipc.TypeBannerHide || bannerHideSessionID(t, env) != bannerTestSession {
		t.Fatalf("a banner with no live session must be hidden, got %+v", env)
	}
}

// The sweep never hides a live session's banner, whichever path carries it:
// a helper-owned WebRTC session or a WebSocket stream.
func TestBannerSweepKeepsLiveSessionsBanners(t *testing.T) {
	for _, tc := range []struct {
		name string
		live func(t *testing.T, h *Heartbeat, owner *sessionbroker.Session)
	}{
		{"helper-owned", func(t *testing.T, h *Heartbeat, owner *sessionbroker.Session) {
			h.sessionBroker = newTestBrokerWithSessions(t, owner)
			h.rememberDesktopOwner(bannerTestSession, owner.SessionID)
		}},
		{"websocket stream", func(t *testing.T, h *Heartbeat, _ *sessionbroker.Session) {
			setUnexportedField(t, h.wsDesktopMgr, "sessions", map[string]*desktop.WsStreamSession{bannerTestSession: {}})
		}},
		{"in-process webrtc", func(t *testing.T, h *Heartbeat, _ *sessionbroker.Session) {
			setUnexportedField(t, h.desktopMgr, "sessions", map[string]*desktop.Session{bannerTestSession: {}})
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
			var cur atomic.Pointer[sessionbroker.Session]
			cur.Store(helper.session)
			h := bannerTestHeartbeat(t, &cur)
			tc.live(t, h, helper.session)

			h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
			_ = helper.recv(t)
			for i := 0; i < 4; i++ {
				h.sweepSessionBanners()
			}
			if env := helper.recvWithin(300 * time.Millisecond); env != nil {
				t.Fatalf("a live session's banner must never be hidden by the sweep, got %s", env.Type)
			}
		})
	}
}

// An owner helper that disconnected took its capture with it: the session is
// gone even though the owner map still names it.
func TestBannerSweepTreatsADisconnectedOwnerAsGone(t *testing.T) {
	helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(helper.session)
	h := bannerTestHeartbeat(t, &cur)
	// Owner recorded, but the broker no longer has that helper session.
	h.desktopOwners.Store(bannerTestSession, "helper-that-left")

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	_ = helper.recv(t)
	h.sweepSessionBanners()
	h.sweepSessionBanners()
	env := helper.recvWithin(2 * time.Second)
	if env == nil || env.Type != ipc.TypeBannerHide {
		t.Fatalf("a banner whose owner helper is gone must be hidden, got %+v", env)
	}
}

// A re-send owed to an ended session is abandoned once another session's
// banner comes up where it would land.
func TestBannerHideResendIsHeldWhenAnotherBannerComesUp(t *testing.T) {
	helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(helper.session)
	h := bannerTestHeartbeat(t, &cur)
	h.bannerHideRetryDelays = []time.Duration{300 * time.Millisecond, 600 * time.Millisecond}

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	h.sendBannerHide(bannerTestSession, "")
	h.sendBannerShow(bannerTestSession2, bannerTestPrompt(), "")
	for _, want := range []string{ipc.TypeBannerShow, ipc.TypeBannerHide, ipc.TypeBannerShow} {
		if env := helper.recv(t); env == nil || env.Type != want {
			t.Fatalf("expected %s, got %+v", want, env)
		}
	}
	if env := helper.recvWithin(time.Second); env != nil {
		t.Fatalf("a re-send must not hide the newer session's banner, got %s", env.Type)
	}
}

// Banners in different Windows sessions never hold each other's hides; an
// untargeted banner holds every hide, since an untargeted send can land in
// any session.
func TestBannerHideConflictFollowsTheTargetSession(t *testing.T) {
	for _, tc := range []struct {
		name        string
		otherTarget string
		wantHide    bool
	}{
		{"other Windows session", "2", true},
		{"same Windows session", "1", false},
		{"untargeted other banner", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
			var cur atomic.Pointer[sessionbroker.Session]
			cur.Store(helper.session)
			h := bannerTestHeartbeat(t, &cur)

			h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "1")
			_ = helper.recv(t)
			h.sendBannerShow(bannerTestSession2, bannerTestPrompt(), tc.otherTarget)
			_ = helper.recv(t)

			h.sendBannerHide(bannerTestSession, "1")
			env := helper.recvWithin(300 * time.Millisecond)
			if got := env != nil && env.Type == ipc.TypeBannerHide; got != tc.wantHide {
				t.Fatalf("hide sent = %v, want %v", got, tc.wantHide)
			}
		})
	}
}

// Only consecutive misses count: a session seen live again starts over.
func TestBannerSweepMissesResetWhenTheSessionIsSeenAgain(t *testing.T) {
	helper := newConsentHelper(t, []string{ipc.ScopeConsentUI})
	var cur atomic.Pointer[sessionbroker.Session]
	cur.Store(helper.session)
	h := bannerTestHeartbeat(t, &cur)

	h.sendBannerShow(bannerTestSession, bannerTestPrompt(), "")
	_ = helper.recv(t)

	h.sweepSessionBanners() // gone: miss 1
	setUnexportedField(t, h.wsDesktopMgr, "sessions", map[string]*desktop.WsStreamSession{bannerTestSession: {}})
	h.sweepSessionBanners() // live: reset
	setUnexportedField(t, h.wsDesktopMgr, "sessions", map[string]*desktop.WsStreamSession{})
	h.sweepSessionBanners() // gone: miss 1 again
	if env := helper.recvWithin(300 * time.Millisecond); env != nil {
		t.Fatalf("misses must reset when the session is seen live, got %s", env.Type)
	}
}
