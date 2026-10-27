package heartbeat

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"strconv"
	"strings"
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
	sessions := make([]*sessionbroker.Session, 0, len(probes))
	for _, p := range probes {
		sessions = append(sessions, p.session)
	}
	broker := newTestBrokerWithSessions(t, sessions...)
	h := &Heartbeat{sessionBroker: broker}
	h.promptHost = prompthost.New(prompthost.Deps{Broker: prompthost.NewBrokerDirectory(broker)})
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

	// The broker's rule: only a helper that advertised the prompt protocol
	// (and only while notice.info is live) gets the flag.
	base := sessionbroker.TCCNoticeHelper{GOOS: "darwin", Scopes: []string{"desktop", "notify"}, DesktopContext: ipc.DesktopContextUserSession}
	old, cur := base, base
	cur.PromptProtocol = 1
	if sessionbroker.AgentHandlesTCCNotice(old, true) || !sessionbroker.AgentHandlesTCCNotice(cur, true) {
		t.Fatal("the flag must follow the helper's prompt protocol")
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

func TestNoDoubleTCCNoticeWithOldHelper(t *testing.T) {
	missingFDA := ipc.TCCStatus{ScreenRecording: true, Accessibility: true, FullDiskAccess: false}
	cases := []struct {
		name                string
		newAgent, newHelper bool
		noticeLive          bool
		wantHelperReminds   bool
		wantAgentNotices    bool
	}{
		{"old agent + old helper", false, false, true, true, false},
		{"old agent + new helper", false, true, true, true, false},
		{"new agent + old helper", true, false, true, true, false},
		{"new agent + new helper, notice.info live", true, true, true, false, true},
		{"new agent + new helper, notice.info off", true, true, false, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			protocol := 0
			if tc.newHelper {
				protocol = 1
			}
			// What the agent puts in the auth response. An old agent has
			// no TCC rule at all, so it never sets the flag.
			flag := tc.newAgent && sessionbroker.AgentHandlesTCCNotice(sessionbroker.TCCNoticeHelper{
				GOOS: "darwin", Scopes: []string{"desktop", "notify"}, DesktopContext: ipc.DesktopContextUserSession, PromptProtocol: protocol,
			}, tc.noticeLive)
			raw, _ := json.Marshal(ipc.AuthResponse{Accepted: true, AgentHandlesTCCNotice: flag})
			var resp ipc.AuthResponse
			_ = json.Unmarshal(raw, &resp)

			// What the helper does with it. An old helper never reads it.
			helperReminds := !tc.newHelper || userhelper.ShowsOwnTCCReminder(resp)

			// What the agent does with the helper's status.
			agentNotices := false
			if tc.newAgent {
				probe := tccSession(t, flag)
				enabled := []string{}
				if tc.noticeLive {
					enabled = []string{"notice.info"}
				}
				h := noticeHeartbeat(t, enabled, probe)
				h.handleTCCNotice(probe.session, missingFDA)
				time.Sleep(100 * time.Millisecond)
				agentNotices = len(envelopesOf(probe, ipc.TypePromptShow))+len(envelopesOf(probe, ipc.TypeNotify)) > 0
			}

			if helperReminds != tc.wantHelperReminds || agentNotices != tc.wantAgentNotices {
				t.Fatalf("helper reminds=%v agent notices=%v, want %v/%v", helperReminds, agentNotices, tc.wantHelperReminds, tc.wantAgentNotices)
			}
			if helperReminds == agentNotices {
				t.Fatalf("exactly one side must remind (helper=%v agent=%v)", helperReminds, agentNotices)
			}
		})
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

// markDesktopSessionStartedForTest backdates a remembered session's start.
func markDesktopSessionStartedForTest(sessionID string, at time.Time) {
	desktopPromptsMu.Lock()
	desktopPromptStarted[sessionID] = at
	desktopPromptsMu.Unlock()
}
