package sessionbroker

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// W04 (#10190): the TCC skew rule. The agent takes over the macOS permission
// notice only for a helper whose live advertisement speaks the prompt
// protocol, and only while notice.info is live; every other helper keeps
// showing its own reminder, and the agent builds nothing for it.

func TestTCCNoticeOnlyForPromptCapableHelper(t *testing.T) {
	desktopHelper := TCCNoticeHelper{GOOS: "darwin", Scopes: []string{"desktop", "notify", ipc.ScopePrompt}, DesktopContext: ipc.DesktopContextUserSession, PromptProtocol: 1, Kinds: []string{"notice.info@1"}}
	cases := []struct {
		name   string
		helper func(TCCNoticeHelper) TCCNoticeHelper
		gate   bool
		want   bool
	}{
		{"W04 desktop helper advertising notice.info@1, notice.info live", func(h TCCNoticeHelper) TCCNoticeHelper { return h }, true, true},
		{"helper predates the prompt protocol", func(h TCCNoticeHelper) TCCNoticeHelper { h.PromptProtocol, h.Kinds = 0, nil; return h }, true, false},
		// The W02/W03 native helper speaks protocol 1 with zero kinds and
		// never reads the flag: it must keep its own reminder.
		{"W02/W03 helper: protocol 1, no kinds", func(h TCCNoticeHelper) TCCNoticeHelper { h.Kinds = []string{}; return h }, true, false},
		{"protocol 1, another kind only", func(h TCCNoticeHelper) TCCNoticeHelper { h.Kinds = []string{"restart.prompt@1"}; return h }, true, false},
		{"protocol 1, a later notice.info version only", func(h TCCNoticeHelper) TCCNoticeHelper { h.Kinds = []string{"notice.info@2"}; return h }, true, false},
		{"notice.info not live (kill switch or old build)", func(h TCCNoticeHelper) TCCNoticeHelper { return h }, false, false},
		{"no desktop scope: the agent never reads its status", func(h TCCNoticeHelper) TCCNoticeHelper { h.Scopes = []string{"notify"}; return h }, true, false},
		{"login-window helper", func(h TCCNoticeHelper) TCCNoticeHelper { h.DesktopContext = ipc.DesktopContextLoginWindow; return h }, true, false},
		{"not macOS", func(h TCCNoticeHelper) TCCNoticeHelper { h.GOOS = "windows"; return h }, true, false},
		{"empty desktop context is the user session", func(h TCCNoticeHelper) TCCNoticeHelper { h.DesktopContext = ""; return h }, true, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := AgentHandlesTCCNotice(tc.helper(desktopHelper), tc.gate); got != tc.want {
				t.Fatalf("AgentHandlesTCCNotice = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestTCCNoticeFlagUsesTheClampedAdvertisement(t *testing.T) {
	b := New("", nil)
	b.SetGOOSForTest("darwin")
	b.SetTCCNoticeGate(func() bool { return true })
	auth := ipc.AuthRequest{BinaryKind: ipc.HelperBinaryDesktopHelper, DesktopContext: ipc.DesktopContextUserSession, PromptProtocolVersion: 7, PromptKinds: []string{"notice.info@1"}}
	if !b.agentHandlesTCCNoticeFor(ipc.HelperRoleUser, auth, []string{"desktop", "notify", ipc.ScopePrompt}) {
		t.Fatal("a future prompt protocol clamps to 1 and still qualifies")
	}
	auth.PromptProtocolVersion = 0
	if b.agentHandlesTCCNoticeFor(ipc.HelperRoleUser, auth, []string{"desktop", "notify"}) {
		t.Fatal("an old helper (no prompt protocol) keeps its own reminder")
	}
	auth.PromptProtocolVersion, auth.PromptKinds = 1, []string{}
	if b.agentHandlesTCCNoticeFor(ipc.HelperRoleUser, auth, []string{"desktop", "notify"}) {
		t.Fatal("a W02/W03 helper (protocol 1, zero kinds) keeps its own reminder")
	}
	auth.PromptKinds = []string{"notice.info@1"}
	b.SetTCCNoticeGate(nil)
	auth.PromptProtocolVersion = 1
	if b.agentHandlesTCCNoticeFor(ipc.HelperRoleUser, auth, []string{"desktop", "notify", ipc.ScopePrompt}) {
		t.Fatal("no gate installed means the helper keeps its own reminder")
	}
}

func TestTCCStatusReachesTheHandlerOnlyForAFlaggedSession(t *testing.T) {
	var mu sync.Mutex
	var got []string
	done := make(chan struct{}, 4)
	b := New("", nil)
	b.SetTCCStatusHandler(func(s *Session, st ipc.TCCStatus) {
		mu.Lock()
		got = append(got, s.SessionID)
		mu.Unlock()
		done <- struct{}{}
	})
	payload, _ := json.Marshal(ipc.TCCStatus{FullDiskAccess: false, CheckedAt: time.Now()})

	quiet := &Session{UID: 501, SessionID: "old-helper", AllowedScopes: []string{"desktop"}}
	b.dispatchHelperMessage(quiet, &ipc.Envelope{Type: ipc.TypeTCCStatus, Payload: payload})
	flagged := &Session{UID: 501, SessionID: "new-helper", AllowedScopes: []string{"desktop"}}
	flagged.SetAgentHandlesTCCNoticeForTest(true)
	if !flagged.AgentHandlesTCCNotice() {
		t.Fatal("flag not recorded")
	}
	b.dispatchHelperMessage(flagged, &ipc.Envelope{Type: ipc.TypeTCCStatus, Payload: payload})
	// A flagged session without the desktop scope never reports at all.
	noScope := &Session{UID: 501, SessionID: "no-scope", AllowedScopes: []string{"notify"}}
	noScope.SetAgentHandlesTCCNoticeForTest(true)
	b.dispatchHelperMessage(noScope, &ipc.Envelope{Type: ipc.TypeTCCStatus, Payload: payload})

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("the flagged session's status never reached the handler")
	}
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(got) != 1 || got[0] != "new-helper" {
		t.Fatalf("handler saw %v, want only new-helper", got)
	}
}

// Reports from one helper reach the handler in order, never a stale one
// after a newer one (a late "not granted" must not resurrect a notice the
// grant withdrew). Intermediate reports may be coalesced: only the newest
// state matters.
func TestTCCStatusesReachTheHandlerInOrder(t *testing.T) {
	var mu sync.Mutex
	var seen []int64
	b := New("", nil)
	b.SetTCCStatusHandler(func(_ *Session, st ipc.TCCStatus) {
		time.Sleep(2 * time.Millisecond) // a handler that takes a while
		mu.Lock()
		seen = append(seen, st.CheckedAt.UnixNano())
		mu.Unlock()
	})
	s := &Session{UID: 501, SessionID: "ordered", AllowedScopes: []string{"desktop"}}
	s.SetAgentHandlesTCCNoticeForTest(true)
	base := time.Unix(1_800_000_000, 0)
	const n = 30
	for i := 1; i <= n; i++ {
		payload, _ := json.Marshal(ipc.TCCStatus{FullDiskAccess: i%2 == 0, CheckedAt: base.Add(time.Duration(i) * time.Second)})
		b.dispatchHelperMessage(s, &ipc.Envelope{Type: ipc.TypeTCCStatus, Payload: payload})
	}
	last := base.Add(n * time.Second).UnixNano()
	deadline := time.Now().Add(5 * time.Second)
	for {
		mu.Lock()
		done := len(seen) > 0 && seen[len(seen)-1] == last
		mu.Unlock()
		if done || time.Now().After(deadline) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(30 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if len(seen) == 0 || seen[len(seen)-1] != last {
		t.Fatalf("the newest report was not the last one handled (%d handled)", len(seen))
	}
	for i := 1; i < len(seen); i++ {
		if seen[i] <= seen[i-1] {
			t.Fatalf("report %d handled after a newer one", i)
		}
	}
}

func TestAuthResponseTCCFlagIsAdditive(t *testing.T) {
	raw, _ := json.Marshal(ipc.AuthResponse{Accepted: true})
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	if _, ok := m["agentHandlesTCCNotice"]; ok {
		t.Fatalf("a false flag must be omitted: %s", raw)
	}
	raw, _ = json.Marshal(ipc.AuthResponse{Accepted: true, AgentHandlesTCCNotice: true})
	var back ipc.AuthResponse
	if err := json.Unmarshal(raw, &back); err != nil || !back.AgentHandlesTCCNotice {
		t.Fatalf("round trip lost the flag: %s", raw)
	}
	// An old agent's response (no key) decodes as false: the helper toasts.
	var old ipc.AuthResponse
	if err := json.Unmarshal([]byte(`{"accepted":true,"sessionKey":"00"}`), &old); err != nil || old.AgentHandlesTCCNotice {
		t.Fatal("an old agent's response must read as 'helper handles it'")
	}
}
