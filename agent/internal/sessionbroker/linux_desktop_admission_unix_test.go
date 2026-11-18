//go:build !windows

package sessionbroker

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// selfBinaryHash is the SHA-256 of this test binary: the peer every
// self-helper handshake presents.
func selfBinaryHash(t *testing.T) string {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	sum, err := hashFileSHA256(self)
	if err != nil {
		t.Fatalf("hash self: %v", err)
	}
	return sum
}

type fakeLogind struct {
	calls atomic.Int32
	state LogindSessionState
	err   error
}

func (f *fakeLogind) lookup(_ context.Context, id string) (LogindSessionState, error) {
	f.calls.Add(1)
	return f.state, f.err
}

// startLinuxDesktopBroker runs a real broker that treats itself as Linux,
// with an injected logind answer and this test binary as the running build.
func startLinuxDesktopBroker(t *testing.T, logind *fakeLogind, extra ...func(*Broker)) (*Broker, string) {
	t.Helper()
	hash := selfBinaryHash(t)
	configure := []func(*Broker){func(b *Broker) {
		b.goos = "linux"
		b.selfExeHash = hash
		b.linuxLogindLookup = logind.lookup
	}}
	return startSelfHelperBroker(t, append(configure, extra...)...)
}

// attemptSelfHelperAuth sends one auth request and returns the broker's
// answer, admitted or not.
func attemptSelfHelperAuth(t *testing.T, sock string, req ipc.AuthRequest) ipc.AuthResponse {
	t.Helper()
	var raw net.Conn
	var err error
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if raw, err = net.Dial("unix", sock); err == nil {
			break
		}
	}
	if err != nil {
		t.Fatalf("dial broker: %v", err)
	}
	c := ipc.NewConn(raw)
	t.Cleanup(func() { _ = c.Close() })
	if err := c.SendTyped("auth", ipc.TypeAuthRequest, req); err != nil {
		t.Fatalf("send auth request: %v", err)
	}
	_ = raw.SetReadDeadline(time.Now().Add(5 * time.Second))
	env, err := c.Recv()
	if err != nil {
		t.Fatalf("recv auth response: %v", err)
	}
	var resp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &resp); err != nil {
		t.Fatalf("decode auth response: %v", err)
	}
	return resp
}

func selfDesktopHelperAuth(sessionID, ticket, logindSession string) ipc.AuthRequest {
	req := desktopHelperAuth(ticket, logindSession)
	req.UID = uint32(os.Getuid())
	req.SessionID = sessionID
	return req
}

func selfBinding(gen uint64) LinuxDesktopBinding {
	return LinuxDesktopBinding{UID: uint32(os.Getuid()), Username: "self", LogindSessionID: "3", Generation: gen}
}

func liveSelfLogind() *fakeLogind {
	st := liveWaylandState()
	st.UID = uint32(os.Getuid())
	return &fakeLogind{state: st}
}

func requireRejected(t *testing.T, resp ipc.AuthResponse, contains string) {
	t.Helper()
	if resp.Accepted {
		t.Fatalf("helper was admitted with scopes %v; want rejection containing %q", resp.AllowedScopes, contains)
	}
	if !resp.Permanent {
		t.Errorf("rejection %q is not permanent", resp.Reason)
	}
	if !strings.Contains(resp.Reason, contains) {
		t.Errorf("reason = %q, want it to contain %q", resp.Reason, contains)
	}
}

func skipIfRoot(t *testing.T) {
	t.Helper()
	if os.Getuid() == 0 {
		t.Skip("a Linux desktop helper must not be uid 0; run unprivileged")
	}
}

func TestAdmitLinuxDesktopHelper_NoTicketRejected(t *testing.T) {
	skipIfRoot(t)
	logind := liveSelfLogind()
	b, sock := startLinuxDesktopBroker(t, logind)
	resp := attemptSelfHelperAuth(t, sock, selfDesktopHelperAuth("ld-no-ticket", "", "3"))
	requireRejected(t, resp, "spawn ticket")
	if s := b.SessionByID("ld-no-ticket"); s != nil {
		t.Fatalf("rejected helper registered with scopes %v", s.AllowedScopes)
	}
	if logind.calls.Load() != 0 {
		t.Fatal("logind was queried for a helper with no ticket")
	}
}

func TestAdmitLinuxDesktopHelper_TicketOnUserHelperRejected(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	req := selfDesktopHelperAuth("ld-user-ticket", nonce, "3")
	req.BinaryKind = ipc.HelperBinaryUserHelper
	requireRejected(t, attemptSelfHelperAuth(t, sock, req), "only valid for a Linux desktop helper")
}

func TestAdmitLinuxDesktopHelper_ValidTicketGetsDesktopOnly(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	binding := selfBinding(1)
	nonce, err := b.IssueLinuxDesktopTicket(binding)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	req := selfDesktopHelperAuth("ld-valid", nonce, "3")
	// Advertisements that would earn extra scopes on another helper must
	// earn nothing here.
	req.SupportsConsentUI = true
	req.ConsentProtocolVersion = ipc.ConsentProtocolVersion
	req.PromptProtocolVersion = ipc.PromptProtocolVersion
	req.PromptKinds = []string{"restart.prompt@1"}
	req.UILocale = "de-DE"

	resp := attemptSelfHelperAuth(t, sock, req)
	if !resp.Accepted {
		t.Fatalf("valid ticket rejected: %s", resp.Reason)
	}
	if len(resp.AllowedScopes) != 1 || resp.AllowedScopes[0] != "desktop" {
		t.Fatalf("scopes = %v, want [desktop]", resp.AllowedScopes)
	}
	s := waitForSession(t, b, "ld-valid")
	if s.LinuxDesktop == nil || *s.LinuxDesktop != binding {
		t.Fatalf("session binding = %+v, want %+v", s.LinuxDesktop, binding)
	}
	for _, scope := range []string{"run_as_user", "notify", "clipboard", "tray", ipc.ScopeConsentUIFallback, ipc.ScopeConsentUI, ipc.ScopePam} {
		if s.HasScope(scope) {
			t.Errorf("Linux desktop helper holds %q", scope)
		}
	}
	if s.HasPromptScope() {
		t.Error("Linux desktop helper holds a prompt scope")
	}
	if s.ConsentProtocolVersion != 0 || s.PromptProtocol() != 0 {
		t.Errorf("advertisements applied: consent %d, prompt %d", s.ConsentProtocolVersion, s.PromptProtocol())
	}
	if s.UILocale() == "" {
		t.Error("uiLocale should still be recorded")
	}

	// Per-user routing never picks it.
	if got := b.PreferredSessionWithScope("run_as_user"); got == s {
		t.Error("PreferredSessionWithScope(run_as_user) chose the Linux desktop helper")
	}
	if got := b.PreferredSessionWithScope("notify"); got == s {
		t.Error("PreferredSessionWithScope(notify) chose the Linux desktop helper")
	}
	if got := b.PreferredSessionWithScope("clipboard"); got == s {
		t.Error("PreferredSessionWithScope(clipboard) chose the Linux desktop helper")
	}
	if name, err := platformAccounts.nameForIdentity(strconv.Itoa(os.Getuid())); err == nil && name != "" {
		if got := b.SessionForUser(name); got == s {
			t.Error("SessionForUser chose the Linux desktop helper")
		}
	}
	if got := b.FindUserSession(s.WinSessionID); got == s {
		t.Error("FindUserSession chose the Linux desktop helper")
	}
	if got := b.userHelperSessionForKey(strconv.Itoa(os.Getuid())); got == s {
		t.Error("userHelperSessionForKey chose the Linux desktop helper")
	}
	for _, us := range b.userHelperSessions() {
		if us == s {
			t.Error("userHelperSessions includes the Linux desktop helper")
		}
	}
}

func TestAdmitLinuxDesktopHelper_ReplayRejected(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	if resp := attemptSelfHelperAuth(t, sock, selfDesktopHelperAuth("ld-first", nonce, "3")); !resp.Accepted {
		t.Fatalf("first use rejected: %s", resp.Reason)
	}
	requireRejected(t, attemptSelfHelperAuth(t, sock, selfDesktopHelperAuth("ld-replay", nonce, "3")), "spawn ticket")
}

// The ticket is redeemed against the kernel-verified uid. A ticket minted
// for another uid is refused for this peer whatever it claims.
func TestAdmitLinuxDesktopHelper_KernelUIDNotClaimedUID(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	other := selfBinding(1)
	other.UID = uint32(os.Getuid()) + 1
	nonce, err := b.IssueLinuxDesktopTicket(other)
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	// Claiming the kernel uid: the ticket's uid does not match it.
	requireRejected(t, attemptSelfHelperAuth(t, sock, selfDesktopHelperAuth("ld-uid", nonce, "3")), "different uid")

	// Claiming the ticket's uid instead: refused before the ticket is looked at.
	nonce2, err := b.IssueLinuxDesktopTicket(LinuxDesktopBinding{UID: other.UID, LogindSessionID: "3", Generation: 2})
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	req := selfDesktopHelperAuth("ld-uid-claim", nonce2, "3")
	req.UID = other.UID
	requireRejected(t, attemptSelfHelperAuth(t, sock, req), "UID mismatch")
}

func TestAdmitLinuxDesktopHelper_HashMustMatchRunningBuild(t *testing.T) {
	skipIfRoot(t)
	logind := liveSelfLogind()
	b, sock := startLinuxDesktopBroker(t, logind, func(b *Broker) {
		// The peer's hash is allowlisted (it is this test binary), but the
		// daemon reports a different running build.
		b.selfExeHash = strings.Repeat("ab", 32)
	})
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	requireRejected(t, attemptSelfHelperAuth(t, sock, selfDesktopHelperAuth("ld-hash", nonce, "3")), "running agent build")
	if logind.calls.Load() != 0 {
		t.Fatal("logind was queried for a helper from another build")
	}
}

func TestAdmitLinuxDesktopHelper_UnknownRunningBuildRejected(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind(), func(b *Broker) { b.selfExeHash = "" })
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	requireRejected(t, attemptSelfHelperAuth(t, sock, selfDesktopHelperAuth("ld-nohash", nonce, "3")), "running agent build")
}

func TestAdmitLinuxDesktopHelper_LogindMustConfirmLiveSession(t *testing.T) {
	skipIfRoot(t)
	inactive := liveSelfLogind()
	inactive.state.State = "online"
	failing := &fakeLogind{err: errors.New("loginctl failed")}
	cases := []struct {
		name   string
		logind *fakeLogind
		nilFn  bool
		reason string
	}{
		{"inactive session", inactive, false, "not active"},
		{"lookup error", failing, false, "logind session state unavailable"},
		{"no lookup available", liveSelfLogind(), true, "logind session state unavailable"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			b, sock := startLinuxDesktopBroker(t, tc.logind, func(b *Broker) {
				if tc.nilFn {
					b.linuxLogindLookup = nil
				}
			})
			nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
			if err != nil {
				t.Fatalf("issue: %v", err)
			}
			requireRejected(t, attemptSelfHelperAuth(t, sock, selfDesktopHelperAuth("ld-logind", nonce, "3")), tc.reason)
		})
	}
}

// A user helper on Linux keeps exactly the grant it had before #12117.
func TestAdmitLinuxUserHelperUnchanged(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	req := ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             uint32(os.Getuid()),
		SessionID:       "lu-plain",
		HelperRole:      ipc.HelperRoleUser,
		BinaryKind:      ipc.HelperBinaryUserHelper,
	}
	resp := attemptSelfHelperAuth(t, sock, req)
	if !resp.Accepted {
		t.Fatalf("user helper rejected: %s", resp.Reason)
	}
	s := waitForSession(t, b, "lu-plain")
	if s.LinuxDesktop != nil {
		t.Fatal("plain user helper carries a Linux desktop binding")
	}
	if !s.HasScope("run_as_user") {
		t.Fatalf("user helper lost run_as_user: %v", s.AllowedScopes)
	}
}
