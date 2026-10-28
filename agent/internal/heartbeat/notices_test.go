package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/prompthost"
	"github.com/breeze-rmm/agent/internal/promptkinds"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
	"github.com/breeze-rmm/agent/internal/userhelper"
)

// W04 (#10190, plan Task 4.1): the safe-mode, session-ended and macOS
// permission notices go through the prompt host only when all three switches
// are on — the agent build constructs notice.info (promptkinds.Register), the
// session's renderer advertised notice.info@1 at its live authentication,
// and the server enables it. Otherwise each takes its exact legacy call.

// noticeProbe is a native user-helper probe that may advertise notice.info@1.
func noticeProbe(t *testing.T, username string, uid uint32, advertises bool) *helperProbe {
	t.Helper()
	scopes := []string{"notify", "tray"}
	if advertises {
		scopes = append(scopes, ipc.ScopePrompt)
	}
	// One Windows session per user: the notify fan-out keeps one helper per session.
	p := newHelperProbe(t, ipc.HelperRoleUser, username, strconv.Itoa(int(uid)), scopes)
	p.session.UID = uid
	if advertises {
		p.session.ApplyPromptAuthForTest(ipc.HelperRoleUser, ipc.AuthRequest{PromptProtocolVersion: 1, PromptKinds: []string{"notice.info@1"}})
	}
	return p
}

// noticeHeartbeat wires a real prompt host over a real broker holding the
// probes, as heartbeat.go does in production.
func noticeHeartbeat(t *testing.T, enabled []string, probes ...*helperProbe) *Heartbeat {
	t.Helper()
	return noticeHeartbeatAt(t, nil, enabled, probes...)
}

// shiftClock is the real clock moved forward by a test-controlled offset
// (the notices take their deadlines from the real clock).
type shiftClock struct {
	mu     sync.Mutex
	offset time.Duration
}

func (c *shiftClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.offset)
}

func (c *shiftClock) advance(d time.Duration) {
	c.mu.Lock()
	c.offset += d
	c.mu.Unlock()
}

func noticeHeartbeatAt(t *testing.T, clock prompthost.Clock, enabled []string, probes ...*helperProbe) *Heartbeat {
	t.Helper()
	sessions := make([]*sessionbroker.Session, 0, len(probes))
	for _, p := range probes {
		sessions = append(sessions, p.session)
	}
	broker := newTestBrokerWithSessions(t, sessions...)
	h := &Heartbeat{sessionBroker: broker}
	h.promptHost = prompthost.New(prompthost.Deps{Broker: prompthost.NewBrokerDirectory(broker), Clock: clock})
	promptkinds.Register(h.promptHost)
	broker.SetPromptSink(h.promptHost)
	h.promptHost.SetEnabledKinds(enabled)
	return h
}

func envelopesOf(p *helperProbe, typ string) []*ipc.Envelope {
	var out []*ipc.Envelope
	for _, e := range p.envelopes() {
		if e.Type == typ {
			out = append(out, e)
		}
	}
	return out
}

func decodeShow(t *testing.T, e *ipc.Envelope) ipc.PromptShow {
	t.Helper()
	var s ipc.PromptShow
	if err := json.Unmarshal(e.Payload, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

func decodeNotify(t *testing.T, e *ipc.Envelope) ipc.NotifyRequest {
	t.Helper()
	var n ipc.NotifyRequest
	if err := json.Unmarshal(e.Payload, &n); err != nil {
		t.Fatal(err)
	}
	return n
}

// settle gives fire-and-forget sends time to land, then asserts nothing of
// the given type arrived.
func assertNone(t *testing.T, p *helperProbe, typ, why string) {
	t.Helper()
	time.Sleep(100 * time.Millisecond)
	if n := len(envelopesOf(p, typ)); n != 0 {
		t.Fatalf("%s: got %d %s", why, n, typ)
	}
}

func TestNoticeFallsBackToLegacyWhenDisabled(t *testing.T) {
	wantToast := ipc.NotifyRequest{Title: "Safe Mode Reboot", Body: "System will reboot into Safe Mode with Networking in 15 minutes. Please save all work.", Urgency: "critical"}
	cases := []struct {
		name       string
		enabled    []string
		advertises bool
		noHost     bool
	}{
		{"server kill switch off", []string{}, true, false},
		{"server enables another kind only", []string{"restart.prompt"}, true, false},
		{"renderer is an old helper that advertised nothing", []string{"notice.info"}, false, false},
		{"no prompt host (no broker-side host)", []string{"notice.info"}, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			probe := noticeProbe(t, "dana", 501, tc.advertises)
			h := noticeHeartbeat(t, tc.enabled, probe)
			if tc.noHost {
				h.promptHost = nil
			}
			h.notifySafeModeReboot(15)
			eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypeNotify)) == 1 }, "the legacy safe-mode toast")
			// Exactly today's call: the broker broadcast, not a per-session
			// legacy send from the prompt host.
			if id := envelopesOf(probe, ipc.TypeNotify)[0].ID; !strings.HasPrefix(id, "notify-bcast-") {
				t.Fatalf("legacy toast envelope %q did not come from BroadcastNotification", id)
			}
			if got := decodeNotify(t, envelopesOf(probe, ipc.TypeNotify)[0]); got.Title != wantToast.Title || got.Body != wantToast.Body || got.Urgency != wantToast.Urgency || got.FallbackDialog {
				t.Fatalf("legacy toast = %+v, want today's %+v", got, wantToast)
			}
			assertNone(t, probe, ipc.TypePromptShow, "a disabled notice")
		})
	}
}

func TestSafeModeNoticeUsesThePromptHostWhenAllSwitchesOn(t *testing.T) {
	probe := noticeProbe(t, "dana", 501, true)
	h := noticeHeartbeat(t, []string{"notice.info"}, probe)
	before := time.Now()
	h.notifySafeModeReboot(15)
	eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypePromptShow)) == 1 }, "the notice prompt_show")
	s := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[0])
	if s.Kind != "notice.info" || s.KindVersion != 1 || !strings.HasPrefix(s.PromptID, "notice:safe_mode:") {
		t.Fatalf("show = %s %s@%d", s.PromptID, s.Kind, s.KindVersion)
	}
	var at int64
	if _, err := fmt.Sscanf(s.PromptID, "notice:safe_mode:%d", &at); err != nil {
		t.Fatal(err)
	}
	if d := time.UnixMilli(at).Sub(before); d < 15*time.Minute-time.Second || d > 15*time.Minute+5*time.Second {
		t.Fatalf("the notice names the reboot moment: %v after the command", d)
	}
	if !strings.Contains(s.Copy.Body, fmt.Sprintf("{time:%d}", at)) {
		t.Fatalf("body = %q", s.Copy.Body)
	}
	assertNone(t, probe, ipc.TypeNotify, "the prompt path replaces the toast")
}

func TestSafeModeNoticeMixesPathsPerSession(t *testing.T) {
	newer := noticeProbe(t, "dana", 501, true)
	older := noticeProbe(t, "sam", 502, false)
	h := noticeHeartbeat(t, []string{"notice.info"}, newer, older)
	h.notifySafeModeReboot(5)
	eventually(t, func() bool { return len(envelopesOf(newer, ipc.TypePromptShow)) == 1 }, "the card for the new helper")
	eventually(t, func() bool { return len(envelopesOf(older, ipc.TypeNotify)) == 1 }, "the legacy toast for the old helper")
	if got := decodeNotify(t, envelopesOf(older, ipc.TypeNotify)[0]); got.Body != promptkinds.LegacySafeModeRebootBody(5) {
		t.Fatalf("old helper toast = %+v", got)
	}
	assertNone(t, newer, ipc.TypeNotify, "the new helper gets the card only")
	assertNone(t, older, ipc.TypePromptShow, "the old helper gets the toast only")
}

func TestSessionEndedNoticeReplacesToastWhenPromptPath(t *testing.T) {
	const sessionID = "6f1c2d9e-0a4b-4c3d-9e8f-123456789abc"
	tech := "Dana Reyes"
	for _, enabled := range []bool{true, false} {
		t.Run(fmt.Sprintf("enabled=%v", enabled), func(t *testing.T) {
			probe := noticeProbe(t, "dana", 501, true)
			kinds := []string{}
			if enabled {
				kinds = []string{"notice.info@1"}
			}
			h := noticeHeartbeat(t, kinds, probe)
			rememberDesktopPrompt(sessionID, &ipc.DesktopPrompt{NotifyOnEnd: true, TechnicianName: &tech})
			markDesktopSessionStartedForTest(sessionID, time.Now().Add(-12*time.Minute-30*time.Second))
			h.handleConsentSessionEnd(sessionID)

			if !enabled {
				eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypeNotify)) == 1 }, "the legacy ended toast")
				if id := envelopesOf(probe, ipc.TypeNotify)[0].ID; !strings.HasPrefix(id, "session-notify-") {
					t.Fatalf("legacy envelope %q did not come from sendSessionNotify", id)
				}
				got := decodeNotify(t, envelopesOf(probe, ipc.TypeNotify)[0])
				if want := sessionNoticeRequest("Remote session ended"); !reflect.DeepEqual(got, want) {
					t.Fatalf("legacy = %+v, want today's %+v", got, want)
				}
				assertNone(t, probe, ipc.TypePromptShow, "a disabled notice")
				return
			}
			eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypePromptShow)) == 1 }, "the ended notice")
			s := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[0])
			if s.PromptID != "notice:session_ended:"+sessionID || s.Copy.Body != "Dana Reyes is no longer connected to your computer." {
				t.Fatalf("show = %s %+v", s.PromptID, s.Copy)
			}
			if len(s.Facts) != 1 || s.Facts[0].Value != "12 min" {
				t.Fatalf("facts = %+v", s.Facts)
			}
			assertNone(t, probe, ipc.TypeNotify, "the card replaces the toast")
		})
	}
}

func TestSessionEndedLegacyToastMatchesPromptkinds(t *testing.T) {
	got, want := sessionNoticeRequest("Remote session ended"), promptkinds.LegacyRemoteSessionEnded()
	same := reflect.DeepEqual(got, want)
	if !same {
		t.Fatalf("the constructor's Legacy drifted from today's call: %+v vs %+v", want, got)
	}
	for _, d := range []int{0, 1, 15} {
		if safeModeRebootNotice(d) != promptkinds.LegacySafeModeRebootBody(d) {
			t.Fatalf("safe-mode body drifted at %d", d)
		}
	}
}

// --- macOS permission notice (TCC skew rule) ---

func tccSession(t *testing.T, flagged bool) *helperProbe {
	t.Helper()
	p := noticeProbe(t, "dana", 501, true)
	p.session.AllowedScopes = append(p.session.AllowedScopes, "desktop")
	p.session.SetAgentHandlesTCCNoticeForTest(flagged)
	return p
}

func TestTCCNoticeOnlyForPromptCapableHelper(t *testing.T) {
	missingFDA := ipc.TCCStatus{ScreenRecording: true, Accessibility: true, FullDiskAccess: false}

	// The broker's rule: only a helper whose live advertisement includes
	// notice.info@1 (and only while notice.info is live) gets the flag.
	for _, gen := range helperGenerations {
		got := sessionbroker.AgentHandlesTCCNoticeForAuth("darwin", ipc.HelperRoleUser, gen.auth(), []string{"desktop", "notify", ipc.ScopePrompt}, true)
		if got != gen.readsFlag {
			t.Fatalf("%s: flag = %v, want %v (only a helper that reads it may be told)", gen.name, got, gen.readsFlag)
		}
	}

	// The agent builds the notice only for a flagged session.
	unflagged := tccSession(t, false)
	h := noticeHeartbeat(t, []string{"notice.info"}, unflagged)
	h.handleTCCNotice(unflagged.session, missingFDA)
	assertNone(t, unflagged, ipc.TypePromptShow, "an unflagged helper reminds by itself")
	assertNone(t, unflagged, ipc.TypeNotify, "an unflagged helper reminds by itself")

	flagged := tccSession(t, true)
	h = noticeHeartbeat(t, []string{"notice.info"}, flagged)
	h.handleTCCNotice(flagged.session, missingFDA)
	eventually(t, func() bool { return len(envelopesOf(flagged, ipc.TypePromptShow)) == 1 }, "the agent's permission notice")
	s := decodeShow(t, envelopesOf(flagged, ipc.TypePromptShow)[0])
	if !strings.HasPrefix(s.PromptID, "notice:tcc:") || len(s.Actions) != 2 || s.Actions[1].ID != "open_settings" {
		t.Fatalf("show = %s %+v", s.PromptID, s.Actions)
	}
}

// helperGeneration is a macOS desktop helper build, described by what it
// advertises at auth (from production code where it exists) and whether it
// reads AuthResponse.AgentHandlesTCCNotice at all.
type helperGeneration struct {
	name      string
	auth      func() ipc.AuthRequest
	readsFlag bool
}

func desktopHelperAuth(protocol int, kinds []string) ipc.AuthRequest {
	return ipc.AuthRequest{BinaryKind: ipc.HelperBinaryDesktopHelper, DesktopContext: ipc.DesktopContextUserSession, PromptProtocolVersion: protocol, PromptKinds: kinds}
}

var helperGenerations = []helperGeneration{
	// Before W02: no prompt protocol at all.
	{"pre-W02 helper", func() ipc.AuthRequest { return desktopHelperAuth(0, nil) }, false},
	// W02/W03 (on main before this wave): protocol 1, zero kinds, and no
	// code that reads the flag. A process of this build can survive an
	// agent update (compatibility order step 7).
	{"W02/W03 helper (protocol 1, no kinds, ignores the flag)", func() ipc.AuthRequest { return desktopHelperAuth(1, []string{}) }, false},
	// This build: what the user-role helper really advertises.
	{"W04 helper", func() ipc.AuthRequest {
		protocol, kinds := userhelper.NativePromptAdvertisement(ipc.HelperRoleUser)
		return desktopHelperAuth(protocol, kinds)
	}, true},
}

func TestNoDoubleTCCNoticeWithOldHelper(t *testing.T) {
	missingFDA := ipc.TCCStatus{ScreenRecording: true, Accessibility: true, FullDiskAccess: false}
	for _, gen := range helperGenerations {
		for _, newAgent := range []bool{false, true} {
			for _, live := range []bool{false, true} {
				name := fmt.Sprintf("%s / newAgent=%v / notice.info live=%v", gen.name, newAgent, live)
				t.Run(name, func(t *testing.T) {
					auth := gen.auth()
					// What the agent puts in the auth response: the broker's
					// own rule. An old agent has no rule and never sets it.
					flag := newAgent && sessionbroker.AgentHandlesTCCNoticeForAuth("darwin", ipc.HelperRoleUser, auth, []string{"desktop", "notify", ipc.ScopePrompt}, live)
					raw, _ := json.Marshal(ipc.AuthResponse{Accepted: true, AgentHandlesTCCNotice: flag})
					var resp ipc.AuthResponse
					_ = json.Unmarshal(raw, &resp)

					// What the helper does with it.
					helperReminds := !gen.readsFlag || userhelper.ShowsOwnTCCReminder(resp)

					// What the agent does with the helper's status.
					agentNotices := false
					if newAgent {
						probe := tccSession(t, flag)
						enabled := []string{}
						if live {
							enabled = []string{"notice.info"}
						}
						h := noticeHeartbeat(t, enabled, probe)
						h.handleTCCNotice(probe.session, missingFDA)
						time.Sleep(100 * time.Millisecond)
						agentNotices = len(envelopesOf(probe, ipc.TypePromptShow))+len(envelopesOf(probe, ipc.TypeNotify)) > 0
					}
					if helperReminds == agentNotices {
						t.Fatalf("exactly one side must remind: helper=%v agent=%v (flag=%v)", helperReminds, agentNotices, flag)
					}
					if wantAgent := newAgent && live && gen.readsFlag; agentNotices != wantAgent {
						t.Fatalf("agent notices = %v, want %v", agentNotices, wantAgent)
					}
				})
			}
		}
	}
}

func TestTCCNoticeShownOnceAndWithdrawnWhenGranted(t *testing.T) {
	probe := tccSession(t, true)
	h := noticeHeartbeat(t, []string{"notice.info"}, probe)
	missing := ipc.TCCStatus{ScreenRecording: true, Accessibility: true, FullDiskAccess: false}
	h.handleTCCNotice(probe.session, missing)
	h.handleTCCNotice(probe.session, missing) // the next 2-minute report
	eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypePromptShow)) >= 1 }, "the notice")
	time.Sleep(100 * time.Millisecond)
	if n := len(envelopesOf(probe, ipc.TypePromptShow)); n != 1 {
		t.Fatalf("a repeated report re-sent the open notice %d times", n)
	}
	id := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[0]).PromptID

	// Granted: the notice is withdrawn.
	h.handleTCCNotice(probe.session, ipc.TCCStatus{ScreenRecording: true, Accessibility: true, FullDiskAccess: true})
	eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypePromptClose)) == 1 }, "the withdrawn notice")
	var c ipc.PromptClose
	_ = json.Unmarshal(envelopesOf(probe, ipc.TypePromptClose)[0].Payload, &c)
	if c.PromptID != id || c.Reason != ipc.PromptCloseWithdrawn {
		t.Fatalf("close = %+v", c)
	}
}

func TestTCCNoticeLegacyIsTheHelpersReminder(t *testing.T) {
	// Flagged at auth, but notice.info was switched off since: the agent
	// sends the reminder the helper would have shown.
	probe := tccSession(t, true)
	h := noticeHeartbeat(t, []string{}, probe)
	h.handleTCCNotice(probe.session, ipc.TCCStatus{ScreenRecording: false, Accessibility: true, FullDiskAccess: false})
	eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypeNotify)) == 1 }, "the reminder toast")
	got := decodeNotify(t, envelopesOf(probe, ipc.TypeNotify)[0])
	if want := promptkinds.LegacyMacPermissionReminder([]string{"Full Disk Access"}); got.Title != want.Title || got.Body != want.Body {
		t.Fatalf("reminder = %+v, want %+v", got, want)
	}
}

func TestTCCNoticeGateFollowsTheKillSwitch(t *testing.T) {
	h := noticeHeartbeat(t, []string{})
	if h.tccNoticeLive() {
		t.Fatal("notice.info is off: no helper may be told to stay quiet")
	}
	h.promptHost.SetEnabledKinds([]string{"notice.info@1"})
	if !h.tccNoticeLive() {
		t.Fatal("notice.info@1 enabled and spoken: the gate is open")
	}
	h.promptHost = nil
	if h.tccNoticeLive() {
		t.Fatal("no prompt host: closed")
	}
}

func TestOpenMacSettingsUsesTheAllowlistAndTheOwnersUID(t *testing.T) {
	var gotUID int
	var gotURL string
	prev := openMacSettingsCmd
	openMacSettingsCmd = func(_ context.Context, uid int, url string) error {
		gotUID, gotURL = uid, url
		return nil
	}
	t.Cleanup(func() { openMacSettingsCmd = prev })
	h := &Heartbeat{}
	if err := h.openMacSettings(prompthost.Owner{UID: 501}, promptkinds.PermissionFullDiskAccess); err != nil {
		t.Fatal(err)
	}
	if gotUID != 501 || gotURL != "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles" {
		t.Fatalf("opened %q for uid %d", gotURL, gotUID)
	}
	gotURL = ""
	if err := h.openMacSettings(prompthost.Owner{UID: 0}, promptkinds.PermissionFullDiskAccess); err == nil || gotURL != "" {
		t.Fatal("root (uid 0) is not a GUI user to open settings for")
	}
	if err := h.openMacSettings(prompthost.Owner{UID: 501}, "x-apple.systempreferences:evil"); err == nil || gotURL != "" {
		t.Fatal("only the allowlisted panes open")
	}
}

var missingFDAOnly = ipc.TCCStatus{ScreenRecording: true, Accessibility: true, FullDiskAccess: false}

func promptShows(p *helperProbe) int { return len(envelopesOf(p, ipc.TypePromptShow)) }

// #10190 W04 review: a notice must not stay open forever. A permission
// notice nobody acknowledged closes as expired after 24 h and comes back at
// the next report while Full Disk Access is still missing.
func TestTCCNoticeExpiresAndRemindsAgain(t *testing.T) {
	clock := &shiftClock{}
	probe := tccSession(t, true)
	h := noticeHeartbeatAt(t, clock, []string{"notice.info"}, probe)
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 1 }, "the notice")
	// The renderer drew it (a probe does not answer by itself).
	s := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[0])
	raw, _ := json.Marshal(ipc.PromptPresented{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, Visible: true})
	h.promptHost.HandleRendererMessage(probe.session, ipc.TypePromptPresented, raw)

	clock.advance(23 * time.Hour)
	h.promptHost.Tick()
	h.handleTCCNotice(probe.session, missingFDAOnly)
	time.Sleep(100 * time.Millisecond)
	if promptShows(probe) != 1 {
		t.Fatal("re-sent before its 24 h lifetime ended")
	}

	clock.advance(2 * time.Hour)
	h.promptHost.Tick()
	eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypePromptClose)) == 1 }, "the expiry close")
	var c ipc.PromptClose
	_ = json.Unmarshal(envelopesOf(probe, ipc.TypePromptClose)[0].Payload, &c)
	if c.Reason != ipc.PromptCloseExpired {
		t.Fatalf("close = %+v, want expired", c)
	}
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 2 }, "the reminder after expiry")
}

func TestTCCNoticeGrantThenRevokeRemindsAgain(t *testing.T) {
	probe := tccSession(t, true)
	h := noticeHeartbeat(t, []string{"notice.info"}, probe)
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 1 }, "the notice")
	h.handleTCCNotice(probe.session, ipc.TCCStatus{ScreenRecording: true, Accessibility: true, FullDiskAccess: true})
	eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypePromptClose)) == 1 }, "the withdrawal")
	// Revoked again within the hour: the same notice id must come back.
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 2 }, "the reminder after a revoke")
}

func TestTCCNoticeAfterOKWaitsADay(t *testing.T) {
	probe := tccSession(t, true)
	h := noticeHeartbeat(t, []string{"notice.info"}, probe)
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 1 }, "the notice")
	s := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[0])
	raw, _ := json.Marshal(ipc.PromptActionRequest{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, ActionID: "ok", Via: ipc.PromptViaClick})
	if _, reply := h.promptHost.HandleRendererMessage(probe.session, ipc.TypePromptAction, raw); reply.(ipc.PromptActionResult).Result != ipc.PromptActionAccepted {
		t.Fatalf("ok = %+v", reply)
	}
	h.handleTCCNotice(probe.session, missingFDAOnly)
	time.Sleep(100 * time.Millisecond)
	if promptShows(probe) != 1 || len(envelopesOf(probe, ipc.TypeNotify)) != 0 {
		t.Fatal("an acknowledged notice came back (or fell back to a toast) within 24 h")
	}
}

func TestTCCNoticeRemindsAgainAfterAScopeChange(t *testing.T) {
	h, _, _ := identityHeartbeat(t, fixtureLogoHandler(t))
	probe := tccSession(t, true)
	broker := newTestBrokerWithSessions(t, probe.session)
	h.sessionBroker = broker
	h.promptHost = prompthost.New(prompthost.Deps{Broker: prompthost.NewBrokerDirectory(broker), Identity: h.promptIdentity})
	promptkinds.Register(h.promptHost)
	on := &PromptHostSettings{EnabledKinds: []string{"notice.info"}}
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeA), PromptHost: on})
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 1 }, "the notice under scope A")

	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeB), PromptHost: on})
	eventually(t, func() bool { return len(envelopesOf(probe, ipc.TypePromptClose)) == 1 }, "the scope-change withdrawal")
	h.handleTCCNotice(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 2 }, "the reminder under the new scope")
	if s := decodeShow(t, envelopesOf(probe, ipc.TypePromptShow)[1]); s.IdentityRef == nil || s.IdentityRef.ScopeID != hbScopeB {
		t.Fatalf("the new notice carries %+v", s.IdentityRef)
	}
}

// A Show the host refuses (here: an invalid prompt) falls back to today's
// call; a Show refused because the notice was decided in the last 24 h does
// not.
func TestShowNoticeFallsBackOnErrorButNotOnTombstone(t *testing.T) {
	probe := noticeProbe(t, "dana", 501, true)
	h := noticeHeartbeat(t, []string{"notice.info"}, probe)
	owner := noticeOwner(probe.session)

	legacy := 0
	bad := h.notices().SafeModeRebootNotice(time.Hour, time.Now().Add(time.Hour))
	bad.Show.Copy.Title = "" // fails the host's validation
	h.showNotice(bad, []prompthost.Owner{owner}, func() { legacy++ })
	if legacy != 1 {
		t.Fatalf("a refused Show must take today's call (legacy=%d)", legacy)
	}

	good := h.notices().RemoteSessionEndedNotice("tomb-1", time.Minute, "")
	h.showNotice(good, []prompthost.Owner{owner}, func() { legacy++ })
	eventually(t, func() bool { return promptShows(probe) == 1 }, "the notice")
	if err := h.promptHost.Close(good.ID, ipc.PromptCloseResolved); err != nil {
		t.Fatal(err)
	}
	h.showNotice(good, []prompthost.Owner{owner}, func() { legacy++ })
	time.Sleep(100 * time.Millisecond)
	if legacy != 1 || promptShows(probe) != 1 {
		t.Fatalf("a decided notice was re-sent (legacy=%d shows=%d)", legacy, promptShows(probe))
	}
}

// The production wiring (startPromptHost, called from New): the host is
// the broker's prompt sink, notice.info@1 is registered, and the TCC skew
// rule's gate and status handler are installed on the broker.
func TestStartPromptHostWiresNoticesAndTheTCCRule(t *testing.T) {
	probe := tccSession(t, true)
	broker := newTestBrokerWithSessions(t, probe.session)
	h := &Heartbeat{sessionBroker: broker}
	h.startPromptHost(t.TempDir())
	if h.promptHost == nil || h.promptListStore == nil {
		t.Fatal("no prompt host or list store")
	}
	if sink, ok := broker.PromptSinkForTest().(*prompthost.Host); !ok || sink != h.promptHost {
		t.Fatal("the prompt host is not the broker's prompt sink: renderer messages (presented, action, closed) would never reach it")
	}
	gate, handler := broker.TCCNoticeHooksForTest()
	if gate == nil || handler == nil {
		t.Fatalf("TCC rule not wired: gate=%v handler=%v", gate != nil, handler != nil)
	}
	if gate() {
		t.Fatal("notice.info is not enabled yet: the gate must be closed")
	}
	h.promptHost.SetEnabledKinds([]string{"notice.info@1"})
	if !gate() {
		t.Fatal("notice.info@1 enabled: the gate must open (the build registered the kind)")
	}
	handler(probe.session, missingFDAOnly)
	eventually(t, func() bool { return promptShows(probe) == 1 }, "the notice through the wired handler")
}

// NewWithVersion cannot be stood up in a unit test (it opens the IPC broker
// for real), so pin structurally that it calls startPromptHost.
func TestNewWithVersionStartsThePromptHost(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "heartbeat.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var fn *ast.FuncDecl
	for _, d := range file.Decls {
		if f, ok := d.(*ast.FuncDecl); ok && f.Name.Name == "NewWithVersion" {
			fn = f
		}
	}
	if fn == nil {
		t.Fatal("NewWithVersion not found in heartbeat.go; update this guard")
	}
	calls := false
	ast.Inspect(fn, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok && sel.Sel.Name == "startPromptHost" {
			calls = true
		}
		return true
	})
	if !calls {
		t.Fatal("NewWithVersion no longer calls startPromptHost: no notice kind, prompt sink or TCC rule in production")
	}
}

// markDesktopSessionStartedForTest backdates a remembered session's start.
func markDesktopSessionStartedForTest(sessionID string, at time.Time) {
	desktopPromptsMu.Lock()
	desktopPromptStarted[sessionID] = at
	desktopPromptsMu.Unlock()
}
