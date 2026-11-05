package heartbeat

import (
	"encoding/json"
	"errors"
	"fmt"
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
	"github.com/breeze-rmm/agent/internal/websocket"
)

// W06 (#10190, plan Task 6.3): remote consent and the session indicator go
// through the prompt host only when all three switches are on — this build
// constructs the kind, the session's renderer advertised it at its live
// authentication, and the server enables it. Otherwise each takes exactly
// today's call: consent_request v2, banner_show.

const remoteTestSession = "6f1c2d9e-0a4b-4c3d-9e8f-123456789abc"

// remoteProbe is a helper probe for one user (one uid / Windows session).
// kinds nil means the helper predates the prompt contract.
func remoteProbe(t *testing.T, role ipc.HelperRole, uid uint32, scopes []string, kinds []string) *helperProbe {
	t.Helper()
	p := newHelperProbe(t, role, "dana", strconv.Itoa(int(uid)), scopes)
	p.session.UID = uid
	p.session.ConsentProtocolVersion = ipc.ConsentProtocolVersion
	if kinds != nil {
		p.session.ApplyPromptAuthForTest(role, ipc.AuthRequest{PromptProtocolVersion: 1, PromptKinds: kinds})
	}
	return p
}

// w06NativeKinds is what this build's native user-helper advertises on
// Windows (taken from production, not from the machine running the test).
func w06NativeKinds() []string {
	_, kinds := userhelper.NativePromptAdvertisementOn(ipc.HelperRoleUser, "windows", true)
	return kinds
}

// The native user-helper of this build, advertising what it advertises in
// production.
func newNativeHelper(t *testing.T) *helperProbe {
	kinds := w06NativeKinds()
	return remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, kinds)
}

func newAssist(t *testing.T, kinds []string) *helperProbe {
	return remoteProbe(t, ipc.HelperRoleAssist, 501, []string{"notify", ipc.ScopeConsentUI, ipc.ScopeAssist}, kinds)
}

func consentPrompt(behavior string, timeoutMs int) *ipc.DesktopPrompt {
	tech, org := "Dana Reyes", "Northwind IT"
	return &ipc.DesktopPrompt{Mode: "consent", TechnicianName: &tech, OrgName: &org, ConsentUnavailableBehavior: behavior, ConsentTimeoutMs: timeoutMs}
}

func solicitAsync(h *Heartbeat, prompt *ipc.DesktopPrompt) <-chan consentAttempt {
	out := make(chan consentAttempt, 1)
	go func() { out <- h.solicitConsent(remoteTestSession, prompt, "") }()
	return out
}

func waitAttempt(t *testing.T, ch <-chan consentAttempt) consentAttempt {
	t.Helper()
	select {
	case a := <-ch:
		return a
	case <-time.After(10 * time.Second):
		t.Fatal("no consent attempt")
	}
	return consentAttempt{}
}

func rendererSend(t *testing.T, h *Heartbeat, p *helperProbe, typ string, payload any) any {
	t.Helper()
	raw, _ := json.Marshal(payload)
	_, reply := h.promptHost.HandleRendererMessage(p.session, typ, raw)
	return reply
}

func presentShow(t *testing.T, h *Heartbeat, p *helperProbe, s ipc.PromptShow) {
	t.Helper()
	rendererSend(t, h, p, ipc.TypePromptPresented, ipc.PromptPresented{PromptID: s.PromptID, Rev: s.Rev, Lease: s.Lease, Visible: true})
}

func actOn(t *testing.T, h *Heartbeat, p *helperProbe, s ipc.PromptShow, rev uint64, action string) ipc.PromptActionResult {
	t.Helper()
	return rendererSend(t, h, p, ipc.TypePromptAction, ipc.PromptActionRequest{PromptID: s.PromptID, Rev: rev, Lease: s.Lease, ActionID: action, Via: ipc.PromptViaClick}).(ipc.PromptActionResult)
}

func firstShow(t *testing.T, p *helperProbe) ipc.PromptShow {
	t.Helper()
	eventually(t, func() bool { return promptShows(p) >= 1 }, "a prompt_show")
	return decodeShow(t, envelopesOf(p, ipc.TypePromptShow)[0])
}

// TestConsentRendererReported: each outcome through the prompt host carries
// the renderer that drew it (assist | native), which runConsentGate logs at
// INFO (the API's strict result object has no renderer field yet).
func TestConsentRendererReported(t *testing.T) {
	for _, tc := range []struct {
		name         string
		assist       bool
		answer       string // allow | deny | "" (let it expire)
		wantOutcome  string
		wantRenderer string
	}{
		{"native allow", false, "allow", ipc.ConsentOutcomeGranted, "native"},
		{"native deny", false, "deny", ipc.ConsentOutcomeDenied, "native"},
		{"native expiry", false, "", ipc.ConsentOutcomePresentedExpired, "native"},
		{"assist allow", true, "allow", ipc.ConsentOutcomeGranted, "assist"},
		{"assist deny", true, "deny", ipc.ConsentOutcomeDenied, "assist"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withConsentSeams(t, occupancyOccupied, true)
			clock := &shiftClock{}
			drawer := newNativeHelper(t)
			if tc.assist {
				drawer = newAssist(t, []string{"remote.consent@1"})
			}
			h := noticeHeartbeatAt(t, clock, []string{"remote.consent"}, drawer)
			ch := solicitAsync(h, consentPrompt("block", 30_000))
			s := firstShow(t, drawer)
			if s.Kind != "remote.consent" || s.DefaultActionID != "deny" || !strings.HasPrefix(s.PromptID, "consent:") {
				t.Fatalf("show = %s %s default %q", s.PromptID, s.Kind, s.DefaultActionID)
			}
			presentShow(t, h, drawer, s)
			if tc.answer != "" {
				if res := actOn(t, h, drawer, s, s.Rev, tc.answer); res.Result != ipc.PromptActionAccepted {
					t.Fatalf("%s = %+v", tc.answer, res)
				}
			} else {
				clock.advance(31 * time.Second)
				h.promptHost.Tick()
			}
			att := waitAttempt(t, ch)
			if att.outcome != tc.wantOutcome || att.renderer != tc.wantRenderer || att.helper != drawer.session {
				t.Fatalf("attempt = %+v, want %s by %s", att, tc.wantOutcome, tc.wantRenderer)
			}
			assertNone(t, drawer, ipc.TypeConsentRequest, "the prompt path replaces consent_request")
		})
	}
}

// TestConsentAssistLossNotReasked: Assist is killed mid-consent. The v2
// unavailable/unknown outcome and the decision matrix apply; the person is
// never asked again on the native helper.
func TestConsentAssistLossNotReasked(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	assist := newAssist(t, []string{"remote.consent@1"})
	native := newNativeHelper(t)
	h := noticeHeartbeat(t, []string{"remote.consent"}, assist, native)
	ch := solicitAsync(h, consentPrompt("proceed", 30_000))
	s := firstShow(t, assist)
	presentShow(t, h, assist, s)
	h.promptHost.PromptRendererDisconnected(assist.session)
	att := waitAttempt(t, ch)
	if att.outcome != consentOutcomeUnknown || att.detail != "helper_disconnected" || att.renderer != "assist" {
		t.Fatalf("attempt = %+v, want unknown/helper_disconnected by assist", att)
	}
	v := decideConsent(att, "proceed", func() string { return occupancyOccupied }, func() bool { return true })
	if v.proceed {
		t.Fatalf("a lost Assist consent must never proceed: %+v", v)
	}
	for i := 0; i < 3; i++ {
		h.promptHost.Tick()
	}
	assertNone(t, native, ipc.TypePromptShow, "the consent was re-asked on the native helper")
	assertNone(t, native, ipc.TypeConsentRequest, "the consent was re-asked through the legacy path")
}

// TestConsentKindDisabledTakesTheExactLegacyCall: with any switch off the
// request is exactly today's consent_request v2 on today's helper.
func TestConsentKindDisabledTakesTheExactLegacyCall(t *testing.T) {
	for _, tc := range []struct {
		name    string
		enabled []string
		kinds   []string
		noHost  bool
	}{
		{"server kill switch off", []string{}, []string{"remote.consent@1"}, false},
		{"server enables another kind only", []string{"notice.info"}, []string{"remote.consent@1"}, false},
		{"helper advertises notice.info only (W04 build)", []string{"remote.consent"}, []string{"notice.info@1"}, false},
		{"helper predates the prompt contract", []string{"remote.consent"}, nil, false},
		{"no prompt host", []string{"remote.consent"}, []string{"remote.consent@1"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			withConsentSeams(t, occupancyOccupied, true)
			native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, tc.kinds)
			h := noticeHeartbeat(t, tc.enabled, native)
			if tc.noHost {
				h.promptHost = nil
			}
			att := waitAttempt(t, solicitAsync(h, consentPrompt("block", 2000)))
			reqs := envelopesOf(native, ipc.TypeConsentRequest)
			if len(reqs) != 1 || reqs[0].ID != "consent-"+remoteTestSession {
				t.Fatalf("legacy consent_request envelopes = %+v", reqs)
			}
			var req ipc.ConsentRequest
			_ = json.Unmarshal(reqs[0].Payload, &req)
			if req.ProtocolVersion != ipc.ConsentProtocolVersion || req.TimeoutMs != 2000 || req.OnTimeout != "block" || req.TechnicianName != "Dana Reyes" || req.OrgName != "Northwind IT" || len(req.Nonce) != 32 {
				t.Fatalf("legacy request = %+v", req)
			}
			// The probe never acknowledges: today's v2 outcome.
			if att.outcome != ipc.ConsentOutcomeUnavailable || att.detail != "no_presentation" || att.renderer != "native" {
				t.Fatalf("attempt = %+v", att)
			}
			// The prompt host never saw it (not even a withdrawn record).
			if h.promptHost != nil {
				if err := h.promptHost.Close("consent:"+req.Nonce, ipc.PromptCloseWithdrawn); !errors.Is(err, prompthost.ErrUnknownPrompt) {
					t.Fatalf("a disabled consent reached the prompt host (close = %v)", err)
				}
			}
			assertNone(t, native, ipc.TypePromptShow, "a disabled consent")
		})
	}
}

// The W06 consent rule: an old Assist (it advertises nothing) next to this
// build's native helper — the native helper draws the consent, and the old
// Assist is sent nothing.
func TestConsentOldAssistLosesToNewNativeHelper(t *testing.T) {
	withConsentSeams(t, occupancyOccupied, true)
	oldAssist := newAssist(t, nil)
	native := newNativeHelper(t)
	h := noticeHeartbeat(t, []string{"remote.consent"}, oldAssist, native)
	ch := solicitAsync(h, consentPrompt("block", 30_000))
	s := firstShow(t, native)
	presentShow(t, h, native, s)
	actOn(t, h, native, s, s.Rev, "deny")
	if att := waitAttempt(t, ch); att.outcome != ipc.ConsentOutcomeDenied || att.renderer != "native" || att.helper != native.session {
		t.Fatalf("attempt = %+v", att)
	}
	assertNone(t, oldAssist, ipc.TypeConsentRequest, "the old Assist")
	assertNone(t, oldAssist, ipc.TypePromptShow, "the old Assist")
}

// Skew matrix in the W04 style: Assist generation × native generation ×
// kill switch. The prompt path is taken exactly when the switch is on and
// some live renderer advertised remote.consent@1; then Assist draws it when
// it can, else the native helper. Otherwise today's consent_request goes to
// today's helper (Assist when connected).
func TestConsentSkewMatrix(t *testing.T) {
	nativeNow := w06NativeKinds()
	assists := map[string][]string{"none": nil, "old": {}, "new": {"remote.consent@1"}}
	natives := map[string][]string{"w04": {"notice.info@1"}, "w06": nativeNow}
	for _, an := range []string{"none", "old", "new"} {
		for _, nn := range []string{"w04", "w06"} {
			for _, on := range []bool{true, false} {
				t.Run(fmt.Sprintf("assist=%s native=%s enabled=%v", an, nn, on), func(t *testing.T) {
					withConsentSeams(t, occupancyOccupied, true)
					native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, natives[nn])
					probes := []*helperProbe{native}
					var assist *helperProbe
					if an != "none" {
						assist = newAssist(t, assists[an])
						probes = append(probes, assist)
					}
					enabled := []string{}
					if on {
						enabled = []string{"remote.consent"}
					}
					h := noticeHeartbeat(t, enabled, probes...)
					ch := solicitAsync(h, consentPrompt("block", 1000))

					var wantPrompt, wantLegacy *helperProbe
					switch {
					case on && an == "new":
						wantPrompt = assist
					case on && nn == "w06":
						wantPrompt = native
					case assist != nil:
						wantLegacy = assist
					default:
						wantLegacy = native
					}
					if wantPrompt != nil {
						s := firstShow(t, wantPrompt)
						presentShow(t, h, wantPrompt, s)
						actOn(t, h, wantPrompt, s, s.Rev, "deny")
					}
					waitAttempt(t, ch)
					for _, p := range probes {
						shows, reqs := promptShows(p), len(envelopesOf(p, ipc.TypeConsentRequest))
						if (p == wantPrompt) != (shows == 1) || (p == wantLegacy) != (reqs == 1) || shows > 1 || reqs > 1 {
							t.Fatalf("%s: shows %d, consent_requests %d (want prompt=%v legacy=%v)", p.session.HelperRole, shows, reqs, p == wantPrompt, p == wantLegacy)
						}
					}
				})
			}
		}
	}
}

// TestSessionIndicatorKindDisabledTakesTheExactBannerShow: banner_show is
// unchanged with any switch off.
func TestSessionIndicatorKindDisabledTakesTheExactBannerShow(t *testing.T) {
	for _, tc := range []struct {
		name    string
		enabled []string
		kinds   []string
	}{
		{"server kill switch off", []string{}, []string{"remote.session@1"}},
		{"helper does not advertise the kind", []string{"remote.session"}, []string{"notice.info@1"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, tc.kinds)
			h := noticeHeartbeat(t, tc.enabled, native)
			prompt := consentPrompt("block", 30_000)
			prompt.Mode, prompt.ShowIndicator, prompt.AllowUserEndSession = "notify", true, true
			before := time.Now().UnixMilli()
			h.afterDesktopStart(remoteTestSession, prompt, "")
			t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
			eventually(t, func() bool { return len(envelopesOf(native, ipc.TypeBannerShow)) == 1 }, "the legacy banner_show")
			env := envelopesOf(native, ipc.TypeBannerShow)[0]
			var req ipc.BannerShowRequest
			_ = json.Unmarshal(env.Payload, &req)
			if env.ID != "banner-show-"+remoteTestSession || req.SessionID != remoteTestSession || req.Label != "Dana Reyes from Northwind IT is connected" || req.StartedAtUnixMs < before {
				t.Fatalf("banner_show = %s %+v", env.ID, req)
			}
			assertNone(t, native, ipc.TypePromptShow, "a disabled indicator")
			if h.promptHost.IsOpen(promptkinds.RemoteSessionPromptID(remoteTestSession)) {
				t.Fatal("a disabled indicator reached the prompt host")
			}
		})
	}
}

func TestSessionIndicatorThroughThePromptHost(t *testing.T) {
	native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
	h := noticeHeartbeat(t, []string{"remote.session"}, native)
	prompt := consentPrompt("block", 30_000)
	prompt.Mode, prompt.ShowIndicator = "notify", true
	h.afterDesktopStart(remoteTestSession, prompt, "")
	s := firstShow(t, native)
	if s.PromptID != "session:"+remoteTestSession || s.Presentation != ipc.PromptPresentationIndicator {
		t.Fatalf("show = %s %s", s.PromptID, s.Presentation)
	}
	for _, a := range s.Actions {
		if a.ID == "end_session" {
			t.Fatal("end_session offered by a server that did not send allowUserEndSession")
		}
	}
	assertNone(t, native, ipc.TypeBannerShow, "the prompt path replaces banner_show")
	presentShow(t, h, native, s)

	h.handleConsentSessionEnd(remoteTestSession)
	eventually(t, func() bool { return len(envelopesOf(native, ipc.TypePromptClose)) == 1 }, "the indicator close")
	var c ipc.PromptClose
	_ = json.Unmarshal(envelopesOf(native, ipc.TypePromptClose)[0].Payload, &c)
	if c.Reason != ipc.PromptCloseWithdrawn || c.PromptID != s.PromptID {
		t.Fatalf("close = %+v, want withdrawn", c)
	}
}

// A viewer reconnect re-offers on the same session id (POST
// /remote/sessions/:id/offer): the second start must get the prompt-path
// pill again, not today's banner (a resolved close would tombstone it 24 h).
func TestSessionIndicatorReshownForAReconnectOnTheSameSessionID(t *testing.T) {
	native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
	h := noticeHeartbeat(t, []string{"remote.session"}, native)
	prompt := consentPrompt("block", 30_000)
	prompt.Mode, prompt.ShowIndicator, prompt.AllowUserEndSession = "notify", true, true
	t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
	for i := 1; i <= 2; i++ {
		h.afterDesktopStart(remoteTestSession, prompt, "")
		eventually(t, func() bool { return promptShows(native) == i }, fmt.Sprintf("pill #%d", i))
		s := decodeShow(t, envelopesOf(native, ipc.TypePromptShow)[i-1])
		presentShow(t, h, native, s)
		h.handleConsentSessionEnd(remoteTestSession) // the stop
		eventually(t, func() bool { return len(envelopesOf(native, ipc.TypePromptClose)) == i }, fmt.Sprintf("close #%d", i))
	}
	assertNone(t, native, ipc.TypeBannerShow, "the reconnect fell back to banner_show")
	// Assist drops a rev it already passed, also across a close: the
	// re-shown pill continues past the closed one's last rev.
	var firstClose ipc.PromptClose
	_ = json.Unmarshal(envelopesOf(native, ipc.TypePromptClose)[0].Payload, &firstClose)
	if second := decodeShow(t, envelopesOf(native, ipc.TypePromptShow)[1]); second.Rev <= firstClose.Rev {
		t.Fatalf("re-shown at rev %d after a close at rev %d", second.Rev, firstClose.Rev)
	}
}

// The indicator is not pinned to an MSP scope: an org move during a live
// session must not take down the only sign that a technician is connected.
func TestSessionIndicatorSurvivesAScopeChange(t *testing.T) {
	h, _, _ := identityHeartbeat(t, fixtureLogoHandler(t))
	native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
	broker := newTestBrokerWithSessions(t, native.session)
	h.sessionBroker = broker
	h.promptHost = prompthost.New(prompthost.Deps{Broker: prompthost.NewBrokerDirectory(broker), Identity: h.promptIdentity})
	promptkinds.Register(h.promptHost)
	on := &PromptHostSettings{EnabledKinds: []string{"remote.session"}}
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeA), PromptHost: on})
	prompt := consentPrompt("block", 30_000)
	prompt.Mode, prompt.ShowIndicator = "notify", true
	h.afterDesktopStart(remoteTestSession, prompt, "")
	t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
	s := firstShow(t, native)
	if s.IdentityRef != nil {
		t.Fatalf("the indicator carries %+v", s.IdentityRef)
	}
	h.processHeartbeatResponse(&HeartbeatResponse{PromptIdentity: identityBlock(hbScopeB), PromptHost: on})
	assertNone(t, native, ipc.TypePromptClose, "the scope change took the indicator down")
	if !h.promptHost.IsOpen(s.PromptID) {
		t.Fatal("the indicator must stay open for the life of the session")
	}
}

func TestDesktopUserEndResultIsTheContractEnvelope(t *testing.T) {
	raw, err := json.Marshal(desktopUserEndResult(remoteTestSession))
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]any
	_ = json.Unmarshal(raw, &got)
	want := map[string]any{
		"type":      "command_result",
		"commandId": "desk-userend-" + remoteTestSession,
		"status":    "completed",
		"exitCode":  float64(0),
		"result":    map[string]any{"event": "ended_by_user", "sessionId": remoteTestSession},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("desk-userend = %s", raw)
	}
}

// TestEndedByUserReported: End session → confirm sends the desk-userend
// result FIRST, then runs the stop_desktop routine (here: desktop_stop to
// the helper that owns the capture).
func TestEndedByUserReported(t *testing.T) {
	var mu sync.Mutex
	var order []string
	var userEnd []websocket.CommandResult
	prev := desktopUserEndSender
	desktopUserEndSender = func(_ *Heartbeat, r websocket.CommandResult) error {
		mu.Lock()
		order = append(order, "userend")
		userEnd = append(userEnd, r)
		mu.Unlock()
		return nil
	}
	t.Cleanup(func() { desktopUserEndSender = prev })

	ownerServer, ownerClient := createTestSocketPair(t)
	ownerConn := ipc.NewConn(ownerClient)
	owner := sessionbroker.NewSession(ipc.NewConn(ownerServer), 501, "501", "dana", "quartz", "helper-capture", []string{"desktop"})
	owner.HelperRole = ipc.HelperRoleSystem
	go owner.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go func() {
		for {
			env, err := ownerConn.Recv()
			if err != nil {
				return
			}
			if env.Type == ipc.TypeDesktopStop {
				mu.Lock()
				order = append(order, "desktop_stop")
				mu.Unlock()
				_ = ownerConn.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopStop, Payload: json.RawMessage(`{"stopped":true}`)})
			}
		}
	}()
	t.Cleanup(func() { _ = owner.Close(); _ = ownerConn.Close() })

	native := remoteProbe(t, ipc.HelperRoleUser, 501, []string{"notify", ipc.ScopeConsentUIFallback}, []string{"remote.session@1"})
	sessions := []*sessionbroker.Session{native.session, owner}
	broker := newTestBrokerWithSessions(t, sessions...)
	h := &Heartbeat{sessionBroker: broker, isHeadless: true}
	h.promptHost = prompthost.New(prompthost.Deps{Broker: prompthost.NewBrokerDirectory(broker)})
	promptkinds.Register(h.promptHost)
	broker.SetPromptSink(h.promptHost)
	h.promptHost.SetEnabledKinds([]string{"remote.session"})
	h.rememberDesktopOwner(remoteTestSession, owner.SessionID)

	prompt := consentPrompt("block", 30_000)
	prompt.Mode, prompt.ShowIndicator, prompt.AllowUserEndSession = "notify", true, true
	h.afterDesktopStart(remoteTestSession, prompt, "")
	t.Cleanup(func() { takeDesktopPrompt(remoteTestSession) })
	s := firstShow(t, native)
	presentShow(t, h, native, s)

	res := actOn(t, h, native, s, s.Rev, "end_session")
	if res.Result != ipc.PromptActionAccepted {
		t.Fatalf("end_session = %+v", res)
	}
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	early := len(order)
	mu.Unlock()
	if early != 0 {
		t.Fatalf("end_session alone ended the session: %v", order)
	}
	if res := actOn(t, h, native, s, res.Rev, "end_confirm"); res.Result != ipc.PromptActionAccepted {
		t.Fatalf("end_confirm = %+v", res)
	}
	eventually(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(order) == 2 }, "the user-end report and the stop")
	mu.Lock()
	defer mu.Unlock()
	if !reflect.DeepEqual(order, []string{"userend", "desktop_stop"}) {
		t.Fatalf("order = %v, want the desk-userend result before the stop", order)
	}
	if len(userEnd) != 1 || !reflect.DeepEqual(userEnd[0], desktopUserEndResult(remoteTestSession)) {
		t.Fatalf("user-end result = %+v", userEnd)
	}
}
