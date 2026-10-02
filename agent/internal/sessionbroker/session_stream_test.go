package sessionbroker

import (
	"encoding/json"
	"net"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// OpenCommandStream backs the consent prompt's two-stage exchange: the helper
// answers one request ID with a presentation acknowledgement and later a
// terminal result, so the registration must survive the first envelope and
// deliver both, in order, until the caller cancels it.
func TestOpenCommandStreamDeliversEveryEnvelopeUntilCancelled(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	session := NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "", "stream-test", nil)
	helper := ipc.NewConn(clientConn)
	defer func() { _ = session.Close() }()
	defer func() { _ = helper.Close() }()
	go session.RecvLoop(func(*Session, *ipc.Envelope) {})

	helperGot := make(chan *ipc.Envelope, 1)
	go func() {
		env, err := helper.Recv()
		if err != nil {
			return
		}
		helperGot <- env
		_ = helper.SendTyped(env.ID, ipc.TypeConsentPresented, ipc.ConsentPresented{Nonce: "n"})
		_ = helper.SendTyped(env.ID, ipc.TypeConsentResult, ipc.ConsentResult{Nonce: "n", Outcome: ipc.ConsentOutcomeGranted})
	}()

	stream, err := session.OpenCommandStream("consent-s1", ipc.TypeConsentRequest, ipc.ConsentRequest{SessionID: "s1", Nonce: "n"})
	if err != nil {
		t.Fatalf("OpenCommandStream: %v", err)
	}
	defer stream.Close()

	select {
	case env := <-helperGot:
		if env.Type != ipc.TypeConsentRequest || env.ID != "consent-s1" {
			t.Fatalf("helper got %s/%s", env.Type, env.ID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("helper never received the request")
	}

	wantTypes := []string{ipc.TypeConsentPresented, ipc.TypeConsentResult}
	for _, want := range wantTypes {
		select {
		case env := <-stream.Envelopes():
			if env.Type != want {
				t.Fatalf("got %s, want %s", env.Type, want)
			}
			if want == ipc.TypeConsentResult {
				var res ipc.ConsentResult
				_ = json.Unmarshal(env.Payload, &res)
				if res.Outcome != ipc.ConsentOutcomeGranted {
					t.Fatalf("outcome = %q", res.Outcome)
				}
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("stream never delivered %s", want)
		}
	}

	stream.Close()
	session.mu.Lock()
	_, stillPending := session.pending["consent-s1"]
	session.mu.Unlock()
	if stillPending {
		t.Fatal("Close must drop the pending registration so late replies are not routed")
	}
}

func TestOpenCommandStreamRejectsDuplicateIDAndClosedSession(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	session := NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "", "stream-dup", nil)
	helper := ipc.NewConn(clientConn)
	defer func() { _ = helper.Close() }()
	go func() {
		for {
			if _, err := helper.Recv(); err != nil {
				return
			}
		}
	}()

	first, err := session.OpenCommandStream("consent-dup", ipc.TypeConsentRequest, ipc.ConsentRequest{})
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	if _, err := session.OpenCommandStream("consent-dup", ipc.TypeConsentRequest, ipc.ConsentRequest{}); err == nil {
		t.Fatal("a second in-flight stream with the same id must be refused")
	}

	_ = session.Close()
	select {
	case <-first.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("Done must close when the helper session goes away")
	}
	first.Close()

	if _, err := session.OpenCommandStream("consent-after-close", ipc.TypeConsentRequest, ipc.ConsentRequest{}); err == nil {
		t.Fatal("opening a stream on a closed session must fail")
	}
}

// Only the roles that can render the consent prompt carry the advertised
// consent protocol; a native user helper must also have advertised native
// dialog support. Anything else reads as version 1 (0).
func TestConsentProtocolFromAuth(t *testing.T) {
	tests := []struct {
		name string
		role ipc.HelperRole
		req  ipc.AuthRequest
		want int
	}{
		{"assist v2", ipc.HelperRoleAssist, ipc.AuthRequest{ConsentProtocolVersion: 2}, 2},
		{"assist v1", ipc.HelperRoleAssist, ipc.AuthRequest{}, 0},
		{"native user helper with dialogs v2", ipc.HelperRoleUser, ipc.AuthRequest{SupportsConsentUI: true, ConsentProtocolVersion: 2}, 2},
		{"native user helper without dialogs", ipc.HelperRoleUser, ipc.AuthRequest{ConsentProtocolVersion: 2}, 0},
		{"system helper never prompts", ipc.HelperRoleSystem, ipc.AuthRequest{SupportsConsentUI: true, ConsentProtocolVersion: 2}, 0},
		{"negative is version 1", ipc.HelperRoleAssist, ipc.AuthRequest{ConsentProtocolVersion: -3}, 0},
		{"future version clamps to what this agent speaks", ipc.HelperRoleAssist, ipc.AuthRequest{ConsentProtocolVersion: 9}, ipc.ConsentProtocolVersion},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := consentProtocolFromAuth(tt.role, tt.req); got != tt.want {
				t.Fatalf("consentProtocolFromAuth = %d, want %d", got, tt.want)
			}
		})
	}
}
