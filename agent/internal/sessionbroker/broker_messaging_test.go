package sessionbroker

import (
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// Endpoint messaging (#8293 W1): the messaging scope is granted per session,
// only to an Assist helper that advertised SupportsMessaging. Old Assist
// builds keep their old scope set and never receive message_show.
func TestMessagingScopeNotGrantedWithoutAdvertisement(t *testing.T) {
	b := &Broker{}
	tests := []struct {
		name      string
		role      ipc.HelperRole
		advertise bool
		want      bool
	}{
		{"assist advertising", ipc.HelperRoleAssist, true, true},
		{"assist not advertising", ipc.HelperRoleAssist, false, false},
		{"user role advertising", ipc.HelperRoleUser, true, false},
		{"system role advertising", ipc.HelperRoleSystem, true, false},
		{"watchdog advertising", ipc.HelperRoleWatchdog, true, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			scopes := b.grantScopes(tt.role, ipc.AuthRequest{
				BinaryKind:        ipc.HelperBinaryAssistHelper,
				SupportsMessaging: tt.advertise,
			}, runtime.GOOS, "")
			got := false
			for _, s := range scopes {
				if s == ipc.ScopeMessaging {
					got = true
				}
			}
			if got != tt.want {
				t.Fatalf("messaging scope granted = %v, want %v (scopes %v)", got, tt.want, scopes)
			}
		})
	}
}

func TestMessagingGrantDoesNotMutateSharedAssistScopes(t *testing.T) {
	b := &Broker{}
	before := append([]string(nil), assistHelperScopes...)
	_ = b.grantScopes(ipc.HelperRoleAssist, ipc.AuthRequest{SupportsMessaging: true}, runtime.GOOS, "")
	if len(assistHelperScopes) != len(before) {
		t.Fatalf("assistHelperScopes mutated: %v -> %v", before, assistHelperScopes)
	}
	for _, s := range assistHelperScopes {
		if s == ipc.ScopeMessaging {
			t.Fatal("shared assistHelperScopes now statically holds the messaging scope")
		}
	}
}

func TestBrokerForwardsMessageEventsOnlyWithMessagingScope(t *testing.T) {
	scoped := &Session{AllowedScopes: []string{ipc.ScopeAssist, ipc.ScopeConsentUI, ipc.ScopeMessaging}}
	unscoped := &Session{AllowedScopes: []string{ipc.ScopeAssist, ipc.ScopeConsentUI}}
	userHelper := &Session{AllowedScopes: []string{"notify", "clipboard", "run_as_user"}}
	for _, typ := range []string{ipc.TypeMessagePresented, ipc.TypeMessageAck, ipc.TypeMessageDismissed} {
		if !shouldForwardUnsolicitedHelperMessage(scoped, &ipc.Envelope{Type: typ}) {
			t.Errorf("%s from a messaging-scoped session must be forwarded", typ)
		}
		if shouldForwardUnsolicitedHelperMessage(unscoped, &ipc.Envelope{Type: typ}) {
			t.Errorf("%s from an assist session without messaging scope must be dropped", typ)
		}
		if shouldForwardUnsolicitedHelperMessage(userHelper, &ipc.Envelope{Type: typ}) {
			t.Errorf("%s from a user helper must be dropped", typ)
		}
	}
}

// The broker dispatch switch must route the message events to onMessage
// rather than falling to the "unknown message type" default.
func TestBrokerDispatchesMessageEventsToOnMessage(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scopes []string
		want   bool
	}{
		{"scoped", []string{ipc.ScopeAssist, ipc.ScopeMessaging}, true},
		{"unscoped", []string{ipc.ScopeAssist}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			b := New("/tmp/msg-dispatch.sock", func(_ *Session, env *ipc.Envelope) { got = append(got, env.Type) })
			s := &Session{AllowedScopes: tc.scopes}
			b.dispatchHelperMessage(s, &ipc.Envelope{Type: ipc.TypeMessageAck, Payload: []byte(`{"messageId":"x"}`)})
			if (len(got) == 1) != tc.want {
				t.Fatalf("onMessage calls = %v, want forwarded=%v", got, tc.want)
			}
		})
	}
}

func TestMessageShowExpectsMessagePresentedReply(t *testing.T) {
	if got := expectedResponseType(ipc.TypeMessageShow); got != ipc.TypeMessagePresented {
		t.Fatalf("expectedResponseType(message_show) = %q, want %q", got, ipc.TypeMessagePresented)
	}
}

// The native fallback must reach every interactive session OTHER than the one
// the Assist card was drawn in, so an RDS user is never suppressed by the
// console Assist session.
func TestNotifyTargetsExceptSkipsOnlyTheGivenWindowsSession(t *testing.T) {
	b := New("/tmp/msg-targets.sock", nil)
	console := newNotifyProbe(t, b, "console-user", []string{"notify"})
	console.session.WinSessionID = "1"
	rds := newNotifyProbe(t, b, "rds-user", []string{"notify"})
	rds.session.WinSessionID = "3"
	assist := newNotifyProbe(t, b, "console-assist", []string{ipc.ScopeAssist, ipc.ScopeMessaging})
	assist.session.WinSessionID = "1"

	got := b.NotifyTargetsExcept("1")
	if len(got) != 1 || got[0] != rds.session {
		t.Fatalf("NotifyTargetsExcept(1) = %v, want only the RDS session", sessionIDs(got))
	}
	all := b.NotifyTargetsExcept("")
	if len(all) != 2 {
		t.Fatalf("NotifyTargetsExcept(\"\") = %v, want both notify sessions", sessionIDs(all))
	}
	// "0" is the non-Windows "unknown session" sentinel and must never exclude.
	if len(b.NotifyTargetsExcept("0")) != 2 {
		t.Fatal("NotifyTargetsExcept(\"0\") must not exclude anything")
	}
}
