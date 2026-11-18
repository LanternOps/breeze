//go:build !windows

package sessionbroker

import (
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// linuxDesktopTestDir gives a broker a per-user endpoint directory inside a
// short temp dir (unix socket paths are short on macOS), owned by the test
// user, and makes the socket chown a recorded no-op (only root may chown).
func linuxDesktopTestDir(t *testing.T) func(*Broker) {
	t.Helper()
	parent, err := os.MkdirTemp("", "ld")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(parent) })
	return func(b *Broker) {
		b.linuxDesktopSocketDir = filepath.Join(parent, "desktop")
		b.linuxDesktopChown = func(string, uint32) error { return nil }
	}
}

// startLinuxDesktopEndpoint is startLinuxDesktopBroker plus the per-user
// endpoint for the test user; it returns the broker, the shared socket and
// the desktop endpoint.
func startLinuxDesktopEndpoint(t *testing.T, logind *fakeLogind, extra ...func(*Broker)) (*Broker, string, string) {
	t.Helper()
	b, shared := startLinuxDesktopBrokerShared(t, logind, append([]func(*Broker){linuxDesktopTestDir(t)}, extra...)...)
	desk, err := b.EnsureLinuxDesktopListener(uint32(os.Getuid()))
	if err != nil {
		t.Fatalf("EnsureLinuxDesktopListener: %v", err)
	}
	return b, shared, desk
}

// requireClosedWithoutReply asserts the broker closes conn without sending
// a single byte, well before the handshake timeout.
func requireSilentClose(t *testing.T, conn net.Conn, within time.Duration) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(within))
	buf := make([]byte, 1)
	n, err := conn.Read(buf)
	if n != 0 {
		t.Fatalf("broker replied with %d byte(s); want a silent close", n)
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		t.Fatalf("connection still open after %v; want it closed", within)
	}
	if !errors.Is(err, io.EOF) && !errors.Is(err, syscall.ECONNRESET) {
		t.Fatalf("read err = %v, want EOF", err)
	}
}

func dialUnix(t *testing.T, path string) net.Conn {
	t.Helper()
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dial %s: %v", path, err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func TestLinuxDesktopListener_ModeAndOwner(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("chown to another uid needs root")
	}
	b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
	b.linuxDesktopSocketDir = filepath.Join(t.TempDir(), "desktop")
	t.Cleanup(b.Close)
	path, err := b.EnsureLinuxDesktopListener(4242)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	fi, err := os.Lstat(path)
	if err != nil {
		t.Fatal(err)
	}
	st := fi.Sys().(*syscall.Stat_t)
	if fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o600 || st.Uid != 4242 || st.Gid != 0 {
		t.Fatalf("socket mode %v uid %d gid %d; want socket 0600 4242:0", fi.Mode(), st.Uid, st.Gid)
	}
	di, err := os.Lstat(filepath.Dir(path))
	if err != nil {
		t.Fatal(err)
	}
	dst := di.Sys().(*syscall.Stat_t)
	if !di.IsDir() || di.Mode().Perm() != 0o755 || dst.Uid != 0 {
		t.Fatalf("dir mode %v uid %d; want 0755 root", di.Mode(), dst.Uid)
	}
}

func TestLinuxDesktopListener_SocketModeAndChown(t *testing.T) {
	b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
	linuxDesktopTestDir(t)(b)
	var mu sync.Mutex
	var chowned []string
	b.linuxDesktopChown = func(p string, uid uint32) error {
		mu.Lock()
		defer mu.Unlock()
		chowned = append(chowned, p)
		if uid != 4242 {
			t.Errorf("chown uid %d, want 4242", uid)
		}
		return nil
	}
	t.Cleanup(b.Close)
	path, err := b.EnsureLinuxDesktopListener(4242)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	if filepath.Base(path) != "4242.sock" {
		t.Fatalf("path %q, want <dir>/4242.sock", path)
	}
	fi, err := os.Lstat(path)
	if err != nil || fi.Mode()&os.ModeSocket == 0 || fi.Mode().Perm() != 0o600 {
		t.Fatalf("socket %v mode %v; want 0600 socket", err, fi.Mode())
	}
	di, err := os.Lstat(filepath.Dir(path))
	if err != nil || di.Mode().Perm() != 0o755 {
		t.Fatalf("dir mode %v err %v; want 0755", di.Mode(), err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(chowned) != 1 || chowned[0] != path {
		t.Fatalf("chown calls %q; want exactly the socket", chowned)
	}
	// Idempotent while the socket is ours.
	again, err := b.EnsureLinuxDesktopListener(4242)
	if err != nil || again != path {
		t.Fatalf("second Ensure = %q, %v", again, err)
	}
}

func TestLinuxDesktopListener_ChownFailureFailsClosed(t *testing.T) {
	b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
	linuxDesktopTestDir(t)(b)
	b.linuxDesktopChown = func(string, uint32) error { return errors.New("denied") }
	t.Cleanup(b.Close)
	if _, err := b.EnsureLinuxDesktopListener(4242); err == nil {
		t.Fatal("Ensure succeeded although the socket could not be chowned")
	}
	if _, err := os.Lstat(filepath.Join(b.linuxDesktopSocketDir, "4242.sock")); !os.IsNotExist(err) {
		t.Fatalf("socket left behind after a failed chown: %v", err)
	}
}

func TestLinuxDesktopListener_RefusesRootUID(t *testing.T) {
	b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
	linuxDesktopTestDir(t)(b)
	t.Cleanup(b.Close)
	if _, err := b.EnsureLinuxDesktopListener(0); err == nil {
		t.Fatal("uid 0 endpoint created")
	}
}

func TestLinuxDesktopListener_RefusesForeignOwnedDir(t *testing.T) {
	t.Run("wrong mode", func(t *testing.T) {
		b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
		linuxDesktopTestDir(t)(b)
		t.Cleanup(b.Close)
		if err := os.Mkdir(b.linuxDesktopSocketDir, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(b.linuxDesktopSocketDir, 0o775); err != nil {
			t.Fatal(err)
		}
		if _, err := b.EnsureLinuxDesktopListener(4242); !errors.Is(err, errLinuxDesktopEndpointUnsafe) {
			t.Fatalf("err = %v, want errLinuxDesktopEndpointUnsafe", err)
		}
		if fi, err := os.Lstat(b.linuxDesktopSocketDir); err != nil || fi.Mode().Perm() != 0o775 {
			t.Fatalf("refused dir was modified: %v %v", fi.Mode(), err)
		}
	})
	t.Run("wrong owner", func(t *testing.T) {
		b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
		linuxDesktopTestDir(t)(b)
		b.linuxDesktopDirOwner = uint32(os.Geteuid()) + 1
		t.Cleanup(b.Close)
		if err := os.Mkdir(b.linuxDesktopSocketDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if _, err := b.EnsureLinuxDesktopListener(4242); !errors.Is(err, errLinuxDesktopEndpointUnsafe) {
			t.Fatalf("err = %v, want errLinuxDesktopEndpointUnsafe", err)
		}
	})
	t.Run("not a directory", func(t *testing.T) {
		b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
		linuxDesktopTestDir(t)(b)
		t.Cleanup(b.Close)
		if err := os.WriteFile(b.linuxDesktopSocketDir, nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := b.EnsureLinuxDesktopListener(4242); !errors.Is(err, errLinuxDesktopEndpointUnsafe) {
			t.Fatalf("err = %v, want errLinuxDesktopEndpointUnsafe", err)
		}
		if _, err := os.Lstat(b.linuxDesktopSocketDir); err != nil {
			t.Fatalf("refused file was removed: %v", err)
		}
	})
}

func TestLinuxDesktopListener_SymlinkedPathRefused(t *testing.T) {
	t.Run("symlinked dir", func(t *testing.T) {
		b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
		linuxDesktopTestDir(t)(b)
		t.Cleanup(b.Close)
		target := t.TempDir()
		if err := os.Chmod(target, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, b.linuxDesktopSocketDir); err != nil {
			t.Fatal(err)
		}
		if _, err := b.EnsureLinuxDesktopListener(4242); !errors.Is(err, errLinuxDesktopEndpointUnsafe) {
			t.Fatalf("err = %v, want errLinuxDesktopEndpointUnsafe", err)
		}
		if _, err := os.Lstat(filepath.Join(target, "4242.sock")); !os.IsNotExist(err) {
			t.Fatal("a socket was created through the symlink")
		}
	})
	t.Run("symlinked socket path", func(t *testing.T) {
		b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
		linuxDesktopTestDir(t)(b)
		t.Cleanup(b.Close)
		if err := os.Mkdir(b.linuxDesktopSocketDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(b.linuxDesktopSocketDir, 0o755); err != nil {
			t.Fatal(err)
		}
		victim := filepath.Join(t.TempDir(), "victim")
		if err := os.WriteFile(victim, []byte("keep"), 0o600); err != nil {
			t.Fatal(err)
		}
		link := filepath.Join(b.linuxDesktopSocketDir, "4242.sock")
		if err := os.Symlink(victim, link); err != nil {
			t.Fatal(err)
		}
		if _, err := b.EnsureLinuxDesktopListener(4242); !errors.Is(err, errLinuxDesktopEndpointUnsafe) {
			t.Fatalf("err = %v, want errLinuxDesktopEndpointUnsafe", err)
		}
		if fi, err := os.Lstat(link); err != nil || fi.Mode()&os.ModeSymlink == 0 {
			t.Fatalf("symlink was replaced or removed: %v", err)
		}
		if data, _ := os.ReadFile(victim); string(data) != "keep" {
			t.Fatal("symlink target was modified")
		}
	})
	t.Run("regular file at socket path", func(t *testing.T) {
		b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
		linuxDesktopTestDir(t)(b)
		t.Cleanup(b.Close)
		if err := os.Mkdir(b.linuxDesktopSocketDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(b.linuxDesktopSocketDir, 0o755); err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(b.linuxDesktopSocketDir, "4242.sock")
		if err := os.WriteFile(p, nil, 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := b.EnsureLinuxDesktopListener(4242); !errors.Is(err, errLinuxDesktopEndpointUnsafe) {
			t.Fatalf("err = %v, want errLinuxDesktopEndpointUnsafe", err)
		}
		if fi, err := os.Lstat(p); err != nil || !fi.Mode().IsRegular() {
			t.Fatal("regular file at the socket path was removed")
		}
	})
}

func TestLinuxDesktopListener_StaleSocketReplaced(t *testing.T) {
	b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
	linuxDesktopTestDir(t)(b)
	t.Cleanup(b.Close)
	path, err := b.EnsureLinuxDesktopListener(4242)
	if err != nil {
		t.Fatal(err)
	}
	// The socket file vanishes (or is replaced) behind root's back: the next
	// Ensure closes the old listener and builds a fresh one.
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	again, err := b.EnsureLinuxDesktopListener(4242)
	if err != nil || again != path {
		t.Fatalf("re-Ensure = %q, %v", again, err)
	}
	c, err := net.Dial("unix", path)
	if err != nil {
		t.Fatalf("dial recreated endpoint: %v", err)
	}
	_ = c.Close()
}

func TestLinuxDesktopListener_RejectsWrongUIDPeer(t *testing.T) {
	skipIfRoot(t)
	b, _ := startLinuxDesktopBrokerShared(t, liveSelfLogind(), linuxDesktopTestDir(t))
	other, err := b.EnsureLinuxDesktopListener(uint32(os.Getuid()) + 1)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	nonce, err := b.IssueLinuxDesktopTicket(LinuxDesktopBinding{UID: uint32(os.Getuid()) + 1, Username: "x", LogindSessionID: "3", Generation: 1})
	if err != nil {
		t.Fatal(err)
	}
	c := dialUnix(t, other)
	cc := ipc.NewConn(c)
	_ = cc.SendTyped("auth", ipc.TypeAuthRequest, selfDesktopHelperAuth("ld-wrong-uid", nonce, "3"))
	requireSilentClose(t, c, 3*time.Second)
	if b.SessionByID("ld-wrong-uid") != nil {
		t.Fatal("wrong-uid peer was registered")
	}
	// The ticket was never read, so it was never burnt.
	if _, err := b.linuxDesktopTickets.consume(nonce, "3", uint32(os.Getuid())+1); err != nil {
		t.Fatalf("ticket was consumed by a peer the endpoint should not have read: %v", err)
	}
}

func TestLinuxDesktopListener_UIDCheckedBeforeAuthRead(t *testing.T) {
	skipIfRoot(t)
	b, _ := startLinuxDesktopBrokerShared(t, liveSelfLogind(), linuxDesktopTestDir(t))
	other, err := b.EnsureLinuxDesktopListener(uint32(os.Getuid()) + 1)
	if err != nil {
		t.Fatalf("Ensure: %v", err)
	}
	// Send nothing at all. Were the broker reading an auth request first,
	// this connection would sit until the handshake timeout.
	requireSilentClose(t, dialUnix(t, other), 2*time.Second)
}

func TestLinuxDesktopListener_TicketOnSharedSocketRejected(t *testing.T) {
	skipIfRoot(t)
	logind := liveSelfLogind()
	b, shared, _ := startLinuxDesktopEndpoint(t, logind)
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatal(err)
	}
	requireRejected(t, attemptSelfHelperAuth(t, shared, selfDesktopHelperAuth("ld-shared", nonce, "3")), "per-user desktop endpoint")
	if b.SessionByID("ld-shared") != nil {
		t.Fatal("ticketed helper admitted on the shared socket")
	}
	if logind.calls.Load() != 0 {
		t.Fatal("logind consulted for a shared-socket ticket")
	}
	// A logind session id alone is refused there too.
	req := selfDesktopHelperAuth("ld-shared-2", "", "3")
	req.BinaryKind = ipc.HelperBinaryUserHelper
	requireRejected(t, attemptSelfHelperAuth(t, shared, req), "per-user desktop endpoint")
}

func TestLinuxDesktopListener_NonDesktopRoleRejected(t *testing.T) {
	skipIfRoot(t)
	b, _, desk := startLinuxDesktopEndpoint(t, liveSelfLogind())
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatal(err)
	}
	cases := map[string]ipc.AuthRequest{}
	for _, role := range []ipc.HelperRole{ipc.HelperRoleSystem, ipc.HelperRoleAssist, ipc.HelperRoleWatchdog} {
		req := selfDesktopHelperAuth("ld-role-"+string(role), nonce, "3")
		req.HelperRole = role
		cases[string(role)] = req
	}
	plain := selfDesktopHelperAuth("ld-role-userhelper", "", "")
	plain.BinaryKind = ipc.HelperBinaryUserHelper
	cases["user helper"] = plain
	noTicket := selfDesktopHelperAuth("ld-role-noticket", "", "3")
	cases["desktop helper without ticket"] = noTicket
	for name, req := range cases {
		t.Run(name, func(t *testing.T) {
			requireRejected(t, attemptSelfHelperAuth(t, desk, req), "")
			if b.SessionByID(req.SessionID) != nil {
				t.Fatalf("%s admitted on the desktop endpoint", name)
			}
		})
	}
	// None of those burnt the ticket: they were refused before admission.
	if _, err := b.linuxDesktopTickets.consume(nonce, "3", uint32(os.Getuid())); err != nil {
		t.Fatalf("ticket burnt by a refused non-desktop peer: %v", err)
	}
}

func TestLinuxDesktopListener_AdmitsTicketedHelper(t *testing.T) {
	skipIfRoot(t)
	b, _, desk := startLinuxDesktopEndpoint(t, liveSelfLogind())
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatal(err)
	}
	resp := attemptSelfHelperAuth(t, desk, selfDesktopHelperAuth("ld-endpoint-ok", nonce, "3"))
	if !resp.Accepted {
		t.Fatalf("rejected: %s", resp.Reason)
	}
	s := waitForSession(t, b, "ld-endpoint-ok")
	if s.LinuxDesktop == nil || len(s.AllowedScopes) != 1 || s.AllowedScopes[0] != "desktop" {
		t.Fatalf("session binding %v scopes %v", s.LinuxDesktop, s.AllowedScopes)
	}
}

func TestLinuxDesktopListener_CloseDropsLiveSessions(t *testing.T) {
	skipIfRoot(t)
	b, _, desk := startLinuxDesktopEndpoint(t, liveSelfLogind())
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(1))
	if err != nil {
		t.Fatal(err)
	}
	conn := authenticateSelfHelper(t, desk, selfDesktopHelperAuth("ld-close-live", nonce, "3"))
	s := waitForSession(t, b, "ld-close-live")

	b.CloseLinuxDesktopListener(uint32(os.Getuid()))

	select {
	case <-s.Done():
	case <-time.After(3 * time.Second):
		t.Fatal("live session survived closing its endpoint")
	}
	waitUntil(t, 3*time.Second, func() bool { return b.SessionByID("ld-close-live") == nil })
	if _, err := conn.Recv(); err == nil {
		t.Fatal("helper connection still delivers after its endpoint closed")
	}
	if _, err := os.Lstat(desk); !os.IsNotExist(err) {
		t.Fatalf("endpoint socket left behind: %v", err)
	}
	if _, err := net.Dial("unix", desk); err == nil {
		t.Fatal("closed endpoint still accepts")
	}
}

func TestLinuxDesktopListener_ClosedOnShutdown(t *testing.T) {
	b := New(filepath.Join(t.TempDir(), "a.sock"), nil)
	linuxDesktopTestDir(t)(b)
	path, err := b.EnsureLinuxDesktopListener(4242)
	if err != nil {
		t.Fatal(err)
	}
	b.Close()
	if _, err := os.Lstat(path); !os.IsNotExist(err) {
		t.Fatalf("endpoint socket left after shutdown: %v", err)
	}
	if _, err := net.Dial("unix", path); err == nil {
		t.Fatal("endpoint still accepts after shutdown")
	}
	if _, err := b.EnsureLinuxDesktopListener(4242); err == nil {
		t.Fatal("Ensure succeeded after shutdown")
	}
}

func TestLinuxDesktopListener_HandshakeConcurrencyCap(t *testing.T) {
	skipIfRoot(t)
	_, _, desk := startLinuxDesktopEndpoint(t, liveSelfLogind())
	// Two silent peers occupy the handshake slots for this uid.
	first, second := dialUnix(t, desk), dialUnix(t, desk)
	_ = first
	_ = second
	time.Sleep(200 * time.Millisecond) // let the broker accept both
	third := dialUnix(t, desk)
	requireSilentClose(t, third, 2*time.Second)

	// A slot frees once a handshake ends.
	_ = first.Close()
	waitUntil(t, 3*time.Second, func() bool {
		c, err := net.Dial("unix", desk)
		if err != nil {
			return false
		}
		defer c.Close()
		_ = c.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
		_, err = c.Read(make([]byte, 1))
		var ne net.Error
		return errors.As(err, &ne) && ne.Timeout() // still open: admitted to a handshake
	})
}

func waitUntil(t *testing.T, within time.Duration, cond func() bool) {
	t.Helper()
	for deadline := time.Now().Add(within); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("condition not met within %v", within)
}

func TestLinuxDesktopEndpointReject(t *testing.T) {
	desktop := desktopHelperAuth("t", "3")
	user := ipc.AuthRequest{HelperRole: ipc.HelperRoleUser, BinaryKind: ipc.HelperBinaryUserHelper}
	cases := []struct {
		name       string
		goos       string
		onEndpoint bool
		role       ipc.HelperRole
		req        ipc.AuthRequest
		reject     bool
	}{
		{"desktop helper on endpoint", "linux", true, ipc.HelperRoleUser, desktop, false},
		{"user helper on endpoint", "linux", true, ipc.HelperRoleUser, user, true},
		{"system on endpoint", "linux", true, ipc.HelperRoleSystem, desktop, true},
		{"no ticket on endpoint", "linux", true, ipc.HelperRoleUser, desktopHelperAuth("", "3"), true},
		{"ticket on shared", "linux", false, ipc.HelperRoleUser, desktop, true},
		{"session id on shared", "linux", false, ipc.HelperRoleUser, ipc.AuthRequest{LogindSessionID: "3"}, true},
		{"plain user helper on shared", "linux", false, ipc.HelperRoleUser, user, false},
		{"darwin shared unchanged", "darwin", false, ipc.HelperRoleUser, desktop, false},
	}
	for _, tc := range cases {
		got := linuxDesktopEndpointReject(tc.goos, tc.onEndpoint, tc.role, tc.req)
		if (got != "") != tc.reject {
			t.Errorf("%s: reject = %q, want reject=%v", tc.name, got, tc.reject)
		}
		if got != "" && strings.Contains(got, "t\"") {
			t.Errorf("%s: reason echoes request data: %q", tc.name, got)
		}
	}
}
