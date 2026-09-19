package sessionbroker

import (
	"sort"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// fakeNotifySession builds the shape the broker's admission path publishes for a
// lifecycle helper: SessionID/WinSessionID/HelperRole are written once before the
// session becomes visible, so a test can set them as struct literals.
func fakeNotifySession(sessionID, winSessionID string, role ipc.HelperRole) *Session {
	return &Session{
		SessionID:    sessionID,
		WinSessionID: winSessionID,
		HelperRole:   role,
	}
}

func sessionIDs(sessions []*Session) []string {
	ids := make([]string, 0, len(sessions))
	for _, s := range sessions {
		ids = append(ids, s.SessionID)
	}
	sort.Strings(ids)
	return ids
}

func equalStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// TestSelectNotifyTargetsOnePerWindowsSession is the #4940 contract.
//
// In always-on lifecycle mode the broker spawns TWO helpers into every active
// Windows session (helperKey 1-system and 1-user) and both hold the "notify"
// scope, so they share one screen and one signed-in human. Fanning a notification
// out to both draws the reboot-deferral dialog twice — two taskbar entries, one
// stacked on the other — and the loser keeps its modal dialog open for the whole
// countdown after the decision has already been made elsewhere.
func TestSelectNotifyTargetsOnePerWindowsSession(t *testing.T) {
	tests := []struct {
		name string
		in   []*Session
		want []string
	}{
		{
			// The reported defect: both console helpers answer canNotify=true.
			name: "user and system helper in the same session",
			in: []*Session{
				fakeNotifySession("helper-sys", "1", ipc.HelperRoleSystem),
				fakeNotifySession("helper-user", "1", ipc.HelperRoleUser),
			},
			want: []string{"helper-user"},
		},
		{
			// Order independence: b.sessions is a map, so the input order is
			// random in production and must not decide the winner.
			name: "user and system helper in the same session, reversed",
			in: []*Session{
				fakeNotifySession("helper-user", "1", ipc.HelperRoleUser),
				fakeNotifySession("helper-sys", "1", ipc.HelperRoleSystem),
			},
			want: []string{"helper-user"},
		},
		{
			// The logon-screen / no-user-token case: a system helper is the only
			// thing running in the session, and it can still draw the dialog.
			name: "only a system helper in the session",
			in: []*Session{
				fakeNotifySession("helper-sys", "1", ipc.HelperRoleSystem),
			},
			want: []string{"helper-sys"},
		},
		{
			// A multi-session host has one screen per Windows session; each is a
			// different human and each must still be told.
			name: "helpers in different sessions are each targeted",
			in: []*Session{
				fakeNotifySession("helper-1-user", "1", ipc.HelperRoleUser),
				fakeNotifySession("helper-1-sys", "1", ipc.HelperRoleSystem),
				fakeNotifySession("helper-2-user", "2", ipc.HelperRoleUser),
				fakeNotifySession("helper-2-sys", "2", ipc.HelperRoleSystem),
			},
			want: []string{"helper-1-user", "helper-2-user"},
		},
		{
			// RDS shape: the console session has both roles, a disconnected RDP
			// session kept its SYSTEM helper only.
			name: "mixed roles across sessions",
			in: []*Session{
				fakeNotifySession("helper-1-sys", "1", ipc.HelperRoleSystem),
				fakeNotifySession("helper-1-user", "1", ipc.HelperRoleUser),
				fakeNotifySession("helper-7-sys", "7", ipc.HelperRoleSystem),
			},
			want: []string{"helper-1-user", "helper-7-sys"},
		},
		{
			// Linux and macOS helpers report no Windows session id: the broker
			// stores the "0" the non-Windows currentWinSessionID stub returns.
			// Merging on it would collapse every helper on the host into one and
			// silently stop warning the other logged-in users — delivery, not
			// de-duplication, is the safe direction when the screen is unknown.
			name: "helpers without a windows session id are never merged",
			in: []*Session{
				fakeNotifySession("helper-a", "0", ipc.HelperRoleUser),
				fakeNotifySession("helper-b", "0", ipc.HelperRoleSystem),
				fakeNotifySession("helper-c", "", ipc.HelperRoleUser),
				fakeNotifySession("helper-d", "", ipc.HelperRoleSystem),
			},
			want: []string{"helper-a", "helper-b", "helper-c", "helper-d"},
		},
		{
			name: "no sessions",
			in:   nil,
			want: []string{},
		},
		{
			// Two same-role helpers in one session are already refused by
			// admission (errDuplicateHelperKey), so the tie-break is a
			// belt-and-braces determinism guarantee rather than a live path.
			name: "same role twice in one session keeps the newest connection",
			in: []*Session{
				{SessionID: "helper-old", WinSessionID: "1", HelperRole: ipc.HelperRoleSystem, ConnectedAt: time.Now().Add(-time.Hour)},
				{SessionID: "helper-new", WinSessionID: "1", HelperRole: ipc.HelperRoleSystem, ConnectedAt: time.Now()},
			},
			want: []string{"helper-new"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sessionIDs(selectNotifyTargets(tt.in))
			if !equalStrings(got, tt.want) {
				t.Errorf("selectNotifyTargets() targeted %v, want %v", got, tt.want)
			}
		})
	}
}

// TestSelectNotifyTargetsPrefersTheUserRoleHelper pins the preference itself: the
// user-role helper runs AS the signed-in user, so its dialog is owned by the
// person who has to act on it. The system-role helper draws into the same session
// from the SYSTEM account and is the fallback, not the choice.
func TestSelectNotifyTargetsPrefersTheUserRoleHelper(t *testing.T) {
	for _, other := range []ipc.HelperRole{ipc.HelperRoleSystem, ipc.HelperRoleAssist, ""} {
		t.Run("user over "+string(other), func(t *testing.T) {
			got := selectNotifyTargets([]*Session{
				fakeNotifySession("helper-other", "1", other),
				fakeNotifySession("helper-user", "1", ipc.HelperRoleUser),
			})
			if len(got) != 1 || got[0].SessionID != "helper-user" {
				t.Errorf("selectNotifyTargets() = %v, want only the user-role helper", sessionIDs(got))
			}
		})
	}
}

// bindWindowsHelper marks an already-registered test probe as a lifecycle helper
// in the given interactive Windows session. The broker writes both fields during
// admission, before the session is published, so setting them from the test
// goroutine before the request is the same ordering a real helper produces.
func bindWindowsHelper(s *Session, winSessionID string, role ipc.HelperRole) {
	s.WinSessionID = winSessionID
	s.HelperRole = role
}

// firstEnvelopeIsNotify reports whether a probe was asked for a notification,
// using the sentinel-after-the-fact idiom from broker_notify_test.go: a session's
// writes are ordered, so reading the first envelope decides it without a sleep.
// The caller must have pushed notifySentinelType down every session AFTER the
// broker call returned.
func firstEnvelopeIsNotify(t *testing.T, p *decisionProbe) bool {
	t.Helper()
	env := p.waitForEnvelopes(t, 1)[0]
	switch env.Type {
	case ipc.TypeNotify:
		return true
	case notifySentinelType:
		return false
	default:
		t.Fatalf("%s: unexpected first envelope type %q", p.name, env.Type)
		return false
	}
}

func sendNotifySentinel(t *testing.T, probes ...*decisionProbe) {
	t.Helper()
	for _, p := range probes {
		if err := p.session.SendNotify("sentinel", notifySentinelType, nil); err != nil {
			t.Fatalf("%s: send sentinel: %v", p.name, err)
		}
	}
}

// TestRequestNotificationDecisionPromptsOneHelperPerWindowsSession is the
// end-to-end form of the defect: both helpers are silent, so the call waits out
// its (short) window and every send it was going to make has been made by the
// time it returns. Exactly one of the two helpers sharing Windows session 1 may
// have been asked, and it must be the user-role one.
func TestRequestNotificationDecisionPromptsOneHelperPerWindowsSession(t *testing.T) {
	b := New("notify-decision-one-per-session", nil)
	user := newDecisionProbe(t, b, "1-user", []string{"notify"}, nil)
	bindWindowsHelper(user.session, "1", ipc.HelperRoleUser)
	system := newDecisionProbe(t, b, "1-system", []string{"notify"}, nil)
	bindWindowsHelper(system.session, "1", ipc.HelperRoleSystem)

	if _, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Title:   "Restart Scheduled",
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 150*time.Millisecond); err == nil {
		t.Fatal("RequestNotificationDecision with two silent helpers should report the timeout")
	}

	sendNotifySentinel(t, user, system)
	if !firstEnvelopeIsNotify(t, user) {
		t.Error("the user-role helper was never asked; the prompt must go to the helper running as the signed-in user")
	}
	if firstEnvelopeIsNotify(t, system) {
		t.Error("the system-role helper was asked for a decision the user-role helper in the same Windows session already received — the user sees two dialogs (#4940)")
	}
}

// TestRequestNotificationDecisionStillPromptsEveryWindowsSession guards the other
// direction: de-duplication is per SCREEN, not global. Collapsing a multi-session
// host to one prompt would stop warning every user but the first.
func TestRequestNotificationDecisionStillPromptsEveryWindowsSession(t *testing.T) {
	b := New("notify-decision-every-session", nil)
	console := newDecisionProbe(t, b, "1-user", []string{"notify"}, nil)
	bindWindowsHelper(console.session, "1", ipc.HelperRoleUser)
	rdp := newDecisionProbe(t, b, "7-system", []string{"notify"}, nil)
	bindWindowsHelper(rdp.session, "7", ipc.HelperRoleSystem)

	if _, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 150*time.Millisecond); err == nil {
		t.Fatal("RequestNotificationDecision with two silent helpers should report the timeout")
	}

	sendNotifySentinel(t, console, rdp)
	for _, p := range []*decisionProbe{console, rdp} {
		if !firstEnvelopeIsNotify(t, p) {
			t.Errorf("%s (windows session %q) was not prompted; one dialog per session, not one per host",
				p.name, p.session.WinSessionID)
		}
	}
}

// TestRequestNotificationDecisionReturnsTheAnswerOfTheHelperItAsked proves the
// de-duplication did not break the response path: the surviving helper's click is
// still what the caller receives.
func TestRequestNotificationDecisionReturnsTheAnswerOfTheHelperItAsked(t *testing.T) {
	b := New("notify-decision-survivor-answers", nil)
	user := newDecisionProbe(t, b, "1-user", []string{"notify"}, answerWith("Postpone 1 hour"))
	bindWindowsHelper(user.session, "1", ipc.HelperRoleUser)
	system := newDecisionProbe(t, b, "1-system", []string{"notify"}, answerWith("Restart now"))
	bindWindowsHelper(system.session, "1", ipc.HelperRoleSystem)

	res, err := b.RequestNotificationDecision(ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}, 2*time.Second)
	if err != nil {
		t.Fatalf("RequestNotificationDecision: %v", err)
	}
	if res.ActionClicked != "Postpone 1 hour" {
		t.Errorf("ActionClicked = %q, want the user-role helper's answer", res.ActionClicked)
	}

	sendNotifySentinel(t, user, system)
	if !firstEnvelopeIsNotify(t, user) {
		t.Error("the answering helper was not the user-role one")
	}
	if firstEnvelopeIsNotify(t, system) {
		t.Error("the system-role helper was asked as well (#4940)")
	}
}

// TestBroadcastNotificationSendsOneToastPerWindowsSession is the same fan-out
// defect on the buttonless path. The issue flags it explicitly: a duplicated
// toast is less intrusive than a duplicated modal dialog, but it is the same bug
// and the same one-line grouping.
func TestBroadcastNotificationSendsOneToastPerWindowsSession(t *testing.T) {
	b := New("broadcast-one-per-session", nil)
	user := newDecisionProbe(t, b, "1-user", []string{"notify"}, nil)
	bindWindowsHelper(user.session, "1", ipc.HelperRoleUser)
	system := newDecisionProbe(t, b, "1-system", []string{"notify"}, nil)
	bindWindowsHelper(system.session, "1", ipc.HelperRoleSystem)
	other := newDecisionProbe(t, b, "2-system", []string{"notify"}, nil)
	bindWindowsHelper(other.session, "2", ipc.HelperRoleSystem)

	b.BroadcastNotification("Restart Soon", "in 15 minutes", "normal")

	sendNotifySentinel(t, user, system, other)
	if !firstEnvelopeIsNotify(t, user) {
		t.Error("the user-role helper in session 1 missed the broadcast")
	}
	if firstEnvelopeIsNotify(t, system) {
		t.Error("session 1 received the toast twice — once per helper role (#4940)")
	}
	if !firstEnvelopeIsNotify(t, other) {
		t.Error("the helper in Windows session 2 missed the broadcast")
	}
}

// TestBroadcastNotificationKeepsEveryHelperWithoutAWindowsSession is the
// non-Windows regression guard. Linux and macOS helpers all report the "0" the
// currentWinSessionID stub returns; grouping on it would reduce a host with
// several logged-in users to a single toast.
func TestBroadcastNotificationKeepsEveryHelperWithoutAWindowsSession(t *testing.T) {
	b := New("broadcast-no-windows-session", nil)
	first := newDecisionProbe(t, b, "helper-a", []string{"notify"}, nil)
	bindWindowsHelper(first.session, "0", ipc.HelperRoleUser)
	second := newDecisionProbe(t, b, "helper-b", []string{"notify"}, nil)
	bindWindowsHelper(second.session, "0", ipc.HelperRoleSystem)

	b.BroadcastNotification("Restart Soon", "in 15 minutes", "normal")

	sendNotifySentinel(t, first, second)
	for _, p := range []*decisionProbe{first, second} {
		if !firstEnvelopeIsNotify(t, p) {
			t.Errorf("%s missed the broadcast: helpers with no Windows session id must not be merged", p.name)
		}
	}
}
