//go:build !windows

package sessionbroker

import (
	"encoding/hex"
	"encoding/json"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// startSelfHelperBroker runs a real broker on a Unix socket whose helper
// allowlist is this test binary, so a connection from this process passes
// the kernel-verified path and hash checks exactly as an installed helper
// does.
func startSelfHelperBroker(t *testing.T) (*Broker, string) {
	t.Helper()
	// Unix socket paths are short (104 bytes on macOS): keep the directory
	// name short rather than using t.TempDir().
	dir, err := os.MkdirTemp("", "sb")
	if err != nil {
		t.Fatalf("MkdirTemp: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")

	b := New(sock, nil)
	self, err := os.Executable()
	if err != nil {
		t.Fatalf("os.Executable: %v", err)
	}
	if resolved, err := filepath.EvalSymlinks(self); err == nil {
		self = resolved
	}
	b.helperPathsFn = func() []string { return []string{self} }
	if _, err := b.RefreshAllowedHashes(); err != nil {
		t.Fatalf("RefreshAllowedHashes: %v", err)
	}
	stop := make(chan struct{})
	go func() { _ = b.Listen(stop) }()
	t.Cleanup(func() {
		close(stop)
		b.Close()
	})
	return b, sock
}

func authenticateSelfHelper(t *testing.T, sock string, req ipc.AuthRequest) *ipc.Conn {
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
	env, err := c.Recv()
	if err != nil {
		t.Fatalf("recv auth response: %v", err)
	}
	var resp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &resp); err != nil {
		t.Fatalf("decode auth response: %v", err)
	}
	if !resp.Accepted {
		t.Fatalf("helper was not admitted: %s", resp.Reason)
	}
	key, err := hex.DecodeString(resp.SessionKey)
	if err != nil {
		t.Fatalf("decode session key: %v", err)
	}
	c.SetSessionKey(key)
	return c
}

func waitForSession(t *testing.T, b *Broker, sessionID string) *Session {
	t.Helper()
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if s := b.SessionByID(sessionID); s != nil {
			return s
		}
	}
	t.Fatalf("session %q was not registered", sessionID)
	return nil
}

// The account a helper session belongs to is the one its peer UID names,
// whatever name the helper puts in its auth request; per-user routing and
// the name reported for the session follow that account.
func TestHelperSessionAccountFollowsPeerUID(t *testing.T) {
	uid := os.Getuid()
	// The expected name comes from the account database (os/user, then NSS
	// or Open Directory), not from $USER, so directory accounts in builds
	// without cgo are covered too.
	name, err := platformAccounts.nameForIdentity(strconv.Itoa(uid))
	if err != nil || name == "" {
		t.Skipf("current uid %d has no account entry: %v", uid, err)
	}
	const reported = "breeze-test-other-account"
	if _, err := platformAccounts.identityForName(reported); err == nil {
		t.Skipf("account %q exists on this host", reported)
	}

	b, sock := startSelfHelperBroker(t)
	authenticateSelfHelper(t, sock, ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             uint32(uid),
		Username:        reported,
		SessionID:       "helper-account-test",
		HelperRole:      ipc.HelperRoleUser,
		BinaryKind:      ipc.HelperBinaryUserHelper,
	})
	session := waitForSession(t, b, "helper-account-test")

	if session.Username != name {
		t.Errorf("session account name = %q, want %q (from uid %d)", session.Username, name, uid)
	}
	if info := session.Info(); info.Username != name {
		t.Errorf("session info account name = %q, want %q", info.Username, name)
	}
	if got := b.SessionForUser(reported); got != nil {
		t.Errorf("SessionForUser(%q) selected session %q, which runs as %q", reported, got.SessionID, name)
	}
	if got := b.SessionForUser(name); got != session {
		t.Errorf("SessionForUser(%q) = %v, want the session running as that account", name, got)
	}
}

// The platform lookups answer for the account running this test, in both
// directions, without reading $USER.
func TestPlatformAccountLookupRoundTrip(t *testing.T) {
	uid := strconv.Itoa(os.Getuid())
	name, err := platformAccounts.nameForIdentity(uid)
	if err != nil || name == "" {
		t.Skipf("uid %s has no account entry: %v", uid, err)
	}
	identity, err := platformAccounts.identityForName(name)
	if err != nil {
		t.Fatalf("identityForName(%q): %v", name, err)
	}
	if identity != uid {
		t.Fatalf("identityForName(%q) = %q, want %q", name, identity, uid)
	}
}
