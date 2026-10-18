package sessionbroker

import (
	"runtime"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestChatScopeGrantedOnlyToAdvertisingAssist(t *testing.T) {
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
				BinaryKind:   ipc.HelperBinaryAssistHelper,
				SupportsChat: tt.advertise,
			}, runtime.GOOS, "")
			got := false
			for _, s := range scopes {
				if s == ipc.ScopeChat {
					got = true
				}
			}
			if got != tt.want {
				t.Fatalf("chat scope granted = %v, want %v (scopes %v)", got, tt.want, scopes)
			}
		})
	}
}

func TestChatGrantDoesNotMutateSharedAssistScopes(t *testing.T) {
	b := &Broker{}
	_ = b.grantScopes(ipc.HelperRoleAssist, ipc.AuthRequest{SupportsChat: true}, runtime.GOOS, "")
	for _, s := range assistHelperScopes {
		if s == ipc.ScopeChat {
			t.Fatal("shared assistHelperScopes now statically holds the chat scope")
		}
	}
}

func TestChatOpenAndMessageExpectChatPresented(t *testing.T) {
	for _, typ := range []string{ipc.TypeChatOpen, ipc.TypeChatMessage} {
		if got := expectedResponseType(typ); got != ipc.TypeChatPresented {
			t.Fatalf("expectedResponseType(%s) = %q, want %q", typ, got, ipc.TypeChatPresented)
		}
	}
}

func TestBrokerForwardsChatEventsOnlyWithChatScope(t *testing.T) {
	scoped := &Session{AllowedScopes: []string{ipc.ScopeAssist, ipc.ScopeMessaging, ipc.ScopeChat}}
	noChat := &Session{AllowedScopes: []string{ipc.ScopeAssist, ipc.ScopeMessaging}}
	userHelper := &Session{AllowedScopes: []string{"notify", "clipboard", "run_as_user"}}
	for _, typ := range []string{ipc.TypeChatReply, ipc.TypeChatPresented} {
		if !shouldForwardUnsolicitedHelperMessage(scoped, &ipc.Envelope{Type: typ}) {
			t.Errorf("%s from a chat-scoped session must be forwarded", typ)
		}
		if shouldForwardUnsolicitedHelperMessage(noChat, &ipc.Envelope{Type: typ}) {
			t.Errorf("%s from a session without chat scope must be dropped", typ)
		}
		if shouldForwardUnsolicitedHelperMessage(userHelper, &ipc.Envelope{Type: typ}) {
			t.Errorf("%s from a user helper must be dropped", typ)
		}
	}
}

func TestBrokerDispatchesChatEventsToOnMessageOnlyWithScope(t *testing.T) {
	for _, tc := range []struct {
		name   string
		scopes []string
		want   bool
	}{
		{"scoped", []string{ipc.ScopeAssist, ipc.ScopeMessaging, ipc.ScopeChat}, true},
		{"unscoped", []string{ipc.ScopeAssist, ipc.ScopeMessaging}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var got []string
			b := New("/tmp/chat-dispatch.sock", func(_ *Session, env *ipc.Envelope) { got = append(got, env.Type) })
			s := &Session{AllowedScopes: tc.scopes}
			b.dispatchHelperMessage(s, &ipc.Envelope{Type: ipc.TypeChatReply, Payload: []byte(`{}`)})
			if (len(got) == 1) != tc.want {
				t.Fatalf("onMessage calls = %v, want forwarded=%v", got, tc.want)
			}
		})
	}
}
