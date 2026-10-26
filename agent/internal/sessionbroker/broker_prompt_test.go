package sessionbroker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func promptAuth(role ipc.HelperRole, protocol int, kinds ...string) ipc.AuthRequest {
	return ipc.AuthRequest{ProtocolVersion: ipc.ProtocolVersion, HelperRole: role, PromptProtocolVersion: protocol, PromptKinds: kinds}
}

func TestPromptScopeNotGrantedWithoutAdvertisement(t *testing.T) {
	b := &Broker{}
	cases := []struct {
		name string
		auth ipc.AuthRequest
	}{
		{"legacy renderer (no prompt fields)", promptAuth(ipc.HelperRoleAssist, 0)},
		{"protocol 1, zero kinds (the W02 renderers)", promptAuth(ipc.HelperRoleAssist, 1)},
		{"kinds without a protocol version", promptAuth(ipc.HelperRoleAssist, 0, "notice.info@1")},
		{"only unknown kinds", promptAuth(ipc.HelperRoleAssist, 1, "future.kind@1")},
		{"only malformed kinds", promptAuth(ipc.HelperRoleAssist, 1, "notice.info", "notice.info@0", "notice.info@01")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scopes := b.grantScopes(ipc.HelperRoleAssist, tc.auth, "windows", "")
			if containsString(scopes, ipc.ScopePrompt) || containsString(scopes, ipc.ScopePromptOperator) {
				t.Fatalf("scopes = %v, want no prompt scope", scopes)
			}
			s := &Session{}
			applyAuthAdvertisements(s, ipc.HelperRoleAssist, tc.auth)
			if ads := s.PromptKindAds(); len(ads) != 0 {
				t.Fatalf("session kinds = %v, want none", ads)
			}
		})
	}
}

func TestOperatorScopeOnlyForOperatorKinds(t *testing.T) {
	b := &Broker{}
	cases := []struct {
		kinds        []string
		wantPrompt   bool
		wantOperator bool
	}{
		{[]string{"notice.info@1"}, true, false},
		{[]string{"restart.prompt@1"}, false, true},
		{[]string{"notice.info@1", "restart.final@1"}, true, true},
		{[]string{"remote.consent@1", "remote.session@1"}, true, false},
	}
	for _, tc := range cases {
		scopes := b.grantScopes(ipc.HelperRoleAssist, promptAuth(ipc.HelperRoleAssist, 1, tc.kinds...), "windows", "")
		if got := containsString(scopes, ipc.ScopePrompt); got != tc.wantPrompt {
			t.Errorf("%v: prompt scope = %v, want %v (scopes %v)", tc.kinds, got, tc.wantPrompt, scopes)
		}
		if got := containsString(scopes, ipc.ScopePromptOperator); got != tc.wantOperator {
			t.Errorf("%v: prompt_operator scope = %v, want %v (scopes %v)", tc.kinds, got, tc.wantOperator, scopes)
		}
	}
}

func TestSystemRoleGetsOnlyElevationKind(t *testing.T) {
	b := &Broker{}
	auth := promptAuth(ipc.HelperRoleSystem, 1, "notice.info@1", "restart.prompt@1", "elevation.request@1")
	scopes := b.grantScopes(ipc.HelperRoleSystem, auth, "windows", "")
	if !containsString(scopes, ipc.ScopePrompt) || containsString(scopes, ipc.ScopePromptOperator) {
		t.Fatalf("system scopes = %v, want prompt only", scopes)
	}
	s := &Session{}
	applyAuthAdvertisements(s, ipc.HelperRoleSystem, auth)
	if got := s.PromptKindAds(); len(got) != 1 || got[0] != "elevation.request@1" {
		t.Fatalf("system kinds = %v, want [elevation.request@1]", got)
	}

	// The user-role helper may draw anything except elevation.request.
	userAuth := promptAuth(ipc.HelperRoleUser, 1, "elevation.request@1", "notice.info@1")
	us := &Session{}
	applyAuthAdvertisements(us, ipc.HelperRoleUser, userAuth)
	if got := us.PromptKindAds(); len(got) != 1 || got[0] != "notice.info@1" {
		t.Fatalf("user kinds = %v, want [notice.info@1]", got)
	}

	// Roles that never render get nothing.
	for _, role := range []ipc.HelperRole{ipc.HelperRoleWatchdog, "backup"} {
		ws := &Session{}
		applyAuthAdvertisements(ws, role, promptAuth(role, 1, "notice.info@1"))
		if len(ws.PromptKindAds()) != 0 {
			t.Fatalf("%s role was granted prompt kinds", role)
		}
	}
}

func TestPromptGrantClampsProtocolAndRecordsVersions(t *testing.T) {
	s := &Session{}
	auth := promptAuth(ipc.HelperRoleAssist, 7, "notice.info@1", "notice.info@2", "notice.info@1", "restart.prompt@3")
	auth.RendererVersion = "  0.2.0  "
	applyAuthAdvertisements(s, ipc.HelperRoleAssist, auth)
	if s.PromptProtocol() != ipc.PromptProtocolVersion {
		t.Fatalf("protocol = %d, want clamp to %d", s.PromptProtocol(), ipc.PromptProtocolVersion)
	}
	if got := strings.Join(s.PromptKindAds(), ","); got != "notice.info@1,notice.info@2,restart.prompt@3" {
		t.Fatalf("kinds = %s (want deduped, in advertised order)", got)
	}
	if v, ok := s.PromptKindVersion("notice.info"); !ok || v != 2 {
		t.Fatalf("PromptKindVersion(notice.info) = %d, %v; want highest advertised 2", v, ok)
	}
	if _, ok := s.PromptKindVersion("remote.consent"); ok {
		t.Fatal("an unadvertised kind reported a version")
	}
	if s.RendererVersion() != "0.2.0" {
		t.Fatalf("RendererVersion = %q", s.RendererVersion())
	}

	many := make([]string, 0, 40)
	for i := 0; i < 40; i++ {
		many = append(many, "notice.info@"+string(rune('1'+i%9)))
	}
	capped := &Session{}
	applyAuthAdvertisements(capped, ipc.HelperRoleAssist, promptAuth(ipc.HelperRoleAssist, 1, many...))
	if len(capped.PromptKindAds()) > ipc.MaxAdvertisedPromptKinds {
		t.Fatalf("kinds not capped: %d", len(capped.PromptKindAds()))
	}
}

// recvPrompt reads the next envelope a test client receives.
func recvPrompt(t *testing.T, c *ipc.Conn) *ipc.Envelope {
	t.Helper()
	done := make(chan *ipc.Envelope, 1)
	go func() {
		env, err := c.Recv()
		if err != nil {
			done <- nil
			return
		}
		done <- env
	}()
	select {
	case env := <-done:
		if env == nil {
			t.Fatal("client recv failed")
		}
		return env
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for a prompt message")
	}
	return nil
}

func loadShowFixture(t *testing.T, name string) ipc.PromptShow {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "shared", "src", "fixtures", "prompt-host", name))
	if err != nil {
		t.Fatal(err)
	}
	var show ipc.PromptShow
	if err := json.Unmarshal(raw, &show); err != nil {
		t.Fatal(err)
	}
	return show
}

func newPromptBroker(t *testing.T, sessionID string, role ipc.HelperRole, kinds ...string) (*Broker, *Session, *ipc.Conn) {
	t.Helper()
	session, client := createTestSessionWith(t, sessionID, "S-1-5-21-1")
	t.Cleanup(func() { _ = client.Close() })
	auth := promptAuth(role, 1, kinds...)
	session.HelperRole = role
	session.AllowedScopes = (&Broker{}).grantScopes(role, auth, "windows", "")
	applyAuthAdvertisements(session, role, auth)
	b := &Broker{
		sessions:   map[string]*Session{session.SessionID: session},
		byIdentity: map[string][]*Session{session.IdentityKey: {session}},
	}
	return b, session, client
}

func TestSendPromptRefusesUngrantedKind(t *testing.T) {
	b, _, client := newPromptBroker(t, "assist-user-4242", ipc.HelperRoleAssist, "notice.info@1")

	restart := loadShowFixture(t, "show.restart.json")
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptShow, "restart.prompt", restart); !errors.Is(err, ErrPromptScopeMissing) {
		t.Fatalf("SendPrompt(restart.prompt) = %v, want ErrPromptScopeMissing", err)
	}
	if err := b.SendPrompt("no-such-session", ipc.TypePromptShow, "notice.info", loadShowFixture(t, "show.notice.json")); !errors.Is(err, ErrPromptSessionGone) {
		t.Fatalf("SendPrompt(unknown session) = %v, want ErrPromptSessionGone", err)
	}

	notice := loadShowFixture(t, "show.notice.json")
	// The payload must agree with the routing arguments.
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptShow, "remote.consent", notice); err == nil {
		t.Fatal("SendPrompt accepted a payload whose kind disagrees with the kind argument")
	}
	wrongLease := notice
	wrongLease.Lease.RendererSession = "someone-else"
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptShow, "notice.info", wrongLease); err == nil {
		t.Fatal("SendPrompt accepted a lease naming another renderer")
	}
	wrongVersion := notice
	wrongVersion.KindVersion = 2
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptShow, "notice.info", wrongVersion); !errors.Is(err, ErrPromptScopeMissing) {
		t.Fatalf("SendPrompt(unadvertised version) = %v, want ErrPromptScopeMissing", err)
	}
	invalid := notice
	invalid.Copy.OperatorNote = "operator text"
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptShow, "notice.info", invalid); err == nil {
		t.Fatal("SendPrompt sent operator text on a breeze-class kind")
	}
	lease := ipc.PromptLease{RendererSession: "assist-user-4242", Epoch: 1}
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptUpdate, "restart.prompt", ipc.PromptUpdate{PromptID: "restart:42", Rev: 2, Lease: lease}); !errors.Is(err, ErrPromptScopeMissing) {
		t.Fatalf("prompt_update for an ungranted kind = %v, want ErrPromptScopeMissing", err)
	}
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptClose, "restart.prompt", ipc.PromptClose{PromptID: "restart:42", Rev: 2, Lease: lease, Reason: ipc.PromptCloseResolved}); !errors.Is(err, ErrPromptScopeMissing) {
		t.Fatalf("prompt_close for an ungranted kind = %v, want ErrPromptScopeMissing", err)
	}
	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptActionResult, "notice.info", ipc.PromptActionResult{}); err == nil {
		t.Fatal("prompt_action_result is a reply on the action envelope, not a SendPrompt message")
	}

	if err := b.SendPrompt("assist-user-4242", ipc.TypePromptShow, "notice.info", notice); err != nil {
		t.Fatalf("SendPrompt(notice.info) = %v", err)
	}
	env := recvPrompt(t, client)
	if env.Type != ipc.TypePromptShow {
		t.Fatalf("client got %s, want prompt_show", env.Type)
	}
}

func TestSendPromptBrandingSyncNeedsAnyPromptScope(t *testing.T) {
	b, _, _ := newPromptBroker(t, "assist-user-1", ipc.HelperRoleAssist)
	if err := b.SendPrompt("assist-user-1", ipc.TypePromptBrandingSync, "", ipc.PromptBrandingSync{Cleared: true, Locale: "en"}); !errors.Is(err, ErrPromptScopeMissing) {
		t.Fatalf("branding sync to a session with no prompt scope = %v, want ErrPromptScopeMissing", err)
	}
	b2, _, client := newPromptBroker(t, "assist-user-2", ipc.HelperRoleAssist, "restart.prompt@1")
	if err := b2.SendPrompt("assist-user-2", ipc.TypePromptBrandingSync, "", ipc.PromptBrandingSync{Cleared: true, Locale: "en"}); err != nil {
		t.Fatalf("branding sync = %v", err)
	}
	if env := recvPrompt(t, client); env.Type != ipc.TypePromptBrandingSync {
		t.Fatalf("got %s", env.Type)
	}
}

type recordingSink struct {
	mu    sync.Mutex
	calls []string
	reply any
}

func (r *recordingSink) HandleRendererMessage(s *Session, msgType string, raw json.RawMessage) (string, any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, msgType)
	if msgType == ipc.TypePromptAction {
		return ipc.TypePromptActionResult, r.reply
	}
	return "", nil
}

func (r *recordingSink) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.calls)
}

func TestPromptMessageWithoutScopeIsDropped(t *testing.T) {
	buf := captureLogs(t)
	sink := &recordingSink{}
	b := New("prompt-drop", nil)
	b.SetPromptSink(sink)
	s := &Session{SessionID: "assist-user-9", HelperRole: ipc.HelperRoleAssist, AllowedScopes: []string{ipc.ScopeAssist, ipc.ScopeConsentUI}}
	for _, typ := range []string{ipc.TypePromptPresented, ipc.TypePromptAction, ipc.TypePromptClosed} {
		b.dispatchHelperMessage(s, &ipc.Envelope{ID: "e1", Type: typ, Payload: json.RawMessage(`{}`)})
	}
	if n := sink.count(); n != 0 {
		t.Fatalf("sink called %d times for a session without prompt scope", n)
	}
	out := buf.String()
	if !strings.Contains(out, "dropping prompt message from a session without prompt scope") {
		t.Fatalf("drop not logged:\n%s", out)
	}
	if strings.Contains(out, "unknown message type from helper") {
		t.Fatalf("prompt types fell through to the unknown-type arm:\n%s", out)
	}
}

func TestPromptMessageWithScopeReachesSinkAndActionIsAnswered(t *testing.T) {
	b, session, client := newPromptBroker(t, "assist-user-4242", ipc.HelperRoleAssist, "notice.info@1")
	sink := &recordingSink{reply: ipc.PromptActionResult{PromptID: "notice:x:1", ActionID: "ok", Result: ipc.PromptActionAccepted, Rev: 2}}
	b.SetPromptSink(sink)

	b.dispatchHelperMessage(session, &ipc.Envelope{ID: "act-1", Type: ipc.TypePromptAction, Payload: json.RawMessage(`{}`)})
	env := recvPrompt(t, client)
	if env.Type != ipc.TypePromptActionResult || env.ID != "act-1" {
		t.Fatalf("reply = %s/%s, want prompt_action_result on the action envelope act-1", env.Type, env.ID)
	}
	b.dispatchHelperMessage(session, &ipc.Envelope{ID: "p-1", Type: ipc.TypePromptPresented, Payload: json.RawMessage(`{}`)})
	if n := sink.count(); n != 2 {
		t.Fatalf("sink calls = %d, want 2", n)
	}
}

func TestPromptActionWithNoSinkIsAnsweredStale(t *testing.T) {
	b, session, client := newPromptBroker(t, "assist-user-4242", ipc.HelperRoleAssist, "notice.info@1")
	b.dispatchHelperMessage(session, &ipc.Envelope{ID: "act-1", Type: ipc.TypePromptAction, Payload: json.RawMessage(`{"promptId":"notice:x:1","rev":3,"actionId":"ok"}`)})
	env := recvPrompt(t, client)
	var res ipc.PromptActionResult
	if err := json.Unmarshal(env.Payload, &res); err != nil {
		t.Fatal(err)
	}
	if env.ID != "act-1" || res.Result != ipc.PromptActionRejectedStale || res.PromptID != "notice:x:1" || res.Rev != 3 {
		t.Fatalf("reply %s %+v", env.ID, res)
	}
}

type observingSink struct {
	recordingSink
	connected, disconnected []string
}

func (o *observingSink) PromptRendererConnected(s *Session) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.connected = append(o.connected, s.SessionID)
}

func (o *observingSink) PromptRendererDisconnected(s *Session) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.disconnected = append(o.disconnected, s.SessionID)
}

func TestObserverNotifiedOnlyForPromptScopedSessions(t *testing.T) {
	b, scoped, _ := newPromptBroker(t, "assist-scoped", ipc.HelperRoleAssist, "notice.info@1")
	plain, _ := createTestSessionWith(t, "assist-plain", "S-1-5-21-2")
	plain.HelperRole = ipc.HelperRoleAssist
	plain.AllowedScopes = []string{ipc.ScopeAssist, ipc.ScopeConsentUI}
	b.sessions[plain.SessionID] = plain
	b.byIdentity[plain.IdentityKey] = []*Session{plain}

	// No sink: nothing to notify, nothing panics.
	b.notifyPromptRendererConnected(scoped)

	obs := &observingSink{}
	b.SetPromptSink(obs)
	b.notifyPromptRendererConnected(scoped)
	b.notifyPromptRendererConnected(plain)
	_ = b.closeSession(scoped)
	_ = b.closeSession(plain)
	obs.mu.Lock()
	defer obs.mu.Unlock()
	if strings.Join(obs.connected, ",") != "assist-scoped" || strings.Join(obs.disconnected, ",") != "assist-scoped" {
		t.Fatalf("connected %v disconnected %v; want only the prompt-scoped session, once each", obs.connected, obs.disconnected)
	}
}
