//go:build !windows

package sessionbroker

import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backupipc"
	"github.com/breeze-rmm/agent/internal/ipc"
)

func dialBroker(t *testing.T, sock string) net.Conn {
	t.Helper()
	var raw net.Conn
	var err error
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
		if raw, err = net.Dial("unix", sock); err == nil {
			t.Cleanup(func() { _ = raw.Close() })
			return raw
		}
	}
	t.Fatalf("dial broker: %v", err)
	return nil
}

// requireClosedWithoutReply asserts the broker hung up without answering.
func requireClosedWithoutReply(t *testing.T, raw net.Conn) {
	t.Helper()
	_ = raw.SetReadDeadline(time.Now().Add(5 * time.Second))
	buf := make([]byte, 1)
	n, err := raw.Read(buf)
	if n != 0 {
		t.Fatalf("broker answered a frame over the pre-auth cap")
	}
	if ne, ok := err.(net.Error); ok && ne.Timeout() {
		t.Fatal("broker kept the connection open")
	}
}

// admitLinuxDesktopSelf runs a full ticketed handshake and returns the
// authenticated client connection and the broker's session.
func admitLinuxDesktopSelf(t *testing.T, b *Broker, sock, sessionID string) (*ipc.Conn, net.Conn, *Session) {
	t.Helper()
	nonce, err := b.IssueLinuxDesktopTicket(selfBinding(nextTestGeneration()))
	if err != nil {
		t.Fatalf("issue: %v", err)
	}
	raw := dialBroker(t, sock)
	c := ipc.NewConn(raw)
	if err := c.SendTyped("auth", ipc.TypeAuthRequest, selfDesktopHelperAuth(sessionID, nonce, "3")); err != nil {
		t.Fatalf("send auth: %v", err)
	}
	_ = raw.SetReadDeadline(time.Now().Add(5 * time.Second))
	env, err := c.Recv()
	if err != nil {
		t.Fatalf("recv auth response: %v", err)
	}
	_ = raw.SetReadDeadline(time.Time{})
	var resp ipc.AuthResponse
	if err := json.Unmarshal(env.Payload, &resp); err != nil {
		t.Fatalf("decode auth response: %v", err)
	}
	if !resp.Accepted {
		t.Fatalf("helper rejected: %s", resp.Reason)
	}
	key, err := hex.DecodeString(resp.SessionKey)
	if err != nil {
		t.Fatalf("decode session key: %v", err)
	}
	c.SetSessionKey(key)
	return c, raw, waitForSession(t, b, sessionID)
}

var testGeneration uint64

func nextTestGeneration() uint64 {
	testGeneration++
	return testGeneration
}

func waitSessionGone(t *testing.T, b *Broker, sessionID string, within time.Duration) {
	t.Helper()
	for deadline := time.Now().Add(within); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if b.SessionByID(sessionID) == nil {
			return
		}
	}
	t.Fatalf("session %q still registered after %v", sessionID, within)
}

func TestHandleConnection_PreAuthCapAllRoles(t *testing.T) {
	_, sock := startSelfHelperBroker(t)

	t.Run("1 MiB length header is closed unanswered", func(t *testing.T) {
		raw := dialBroker(t, sock)
		header := make([]byte, 4)
		binary.BigEndian.PutUint32(header, 1<<20)
		if _, err := raw.Write(header); err != nil {
			t.Fatalf("write header: %v", err)
		}
		requireClosedWithoutReply(t, raw)
	})

	t.Run("auth request just over the cap is closed unanswered", func(t *testing.T) {
		raw := dialBroker(t, sock)
		c := ipc.NewConn(raw)
		req := ipc.AuthRequest{ProtocolVersion: ipc.ProtocolVersion, DisplayEnv: strings.Repeat("x", preAuthMaxRecv)}
		// The broker may hang up as soon as it reads the header, so the rest
		// of this write is allowed to fail with a broken pipe.
		_ = c.SendTyped("auth", ipc.TypeAuthRequest, req)
		requireClosedWithoutReply(t, raw)
	})

	// Every role's real-sized request gets an answer: accepted, or refused
	// for its identity, but never cut off by the cap.
	kinds := make([]string, 32)
	for i := range kinds {
		kinds[i] = fmt.Sprintf("vendor.prompt.kind.number-%02d@1", i)
	}
	for _, role := range []ipc.HelperRole{
		ipc.HelperRoleUser, ipc.HelperRoleSystem, ipc.HelperRoleAssist, ipc.HelperRoleWatchdog, backupipc.HelperRoleBackup,
	} {
		t.Run("full request for role "+string(role), func(t *testing.T) {
			req := ipc.AuthRequest{
				ProtocolVersion:       ipc.ProtocolVersion,
				UID:                   uint32(os.Getuid()),
				SID:                   "S-1-5-21-1111111111-2222222222-3333333333-1001",
				Username:              strings.Repeat("u", 256),
				SessionID:             "cap-" + string(role),
				DisplayEnv:            strings.Repeat("d", 512),
				BinaryHash:            strings.Repeat("a", 64),
				HelperRole:            role,
				BinaryKind:            ipc.HelperBinaryUserHelper,
				DesktopContext:        ipc.DesktopContextUserSession,
				PromptProtocolVersion: ipc.PromptProtocolVersion,
				PromptKinds:           kinds,
				RendererVersion:       strings.Repeat("9", 64),
				UILocale:              "de-DE",
			}
			if data, err := json.Marshal(req); err != nil || len(data) >= preAuthMaxRecv/4 {
				t.Fatalf("request is %d bytes (err %v); want a wide margin under %d", len(data), err, preAuthMaxRecv)
			}
			attemptSelfHelperAuth(t, sock, req) // fails the test if unanswered
		})
	}
}

// The cap lifts on admission for every existing role.
func TestHandleConnection_CapLiftedAfterAdmission(t *testing.T) {
	b, sock := startSelfHelperBroker(t)
	c := authenticateSelfHelper(t, sock, ipc.AuthRequest{
		ProtocolVersion: ipc.ProtocolVersion,
		UID:             uint32(os.Getuid()),
		SessionID:       "cap-lift",
		HelperRole:      ipc.HelperRoleUser,
		BinaryKind:      ipc.HelperBinaryUserHelper,
	})
	s := waitForSession(t, b, "cap-lift")
	big := ipc.Capabilities{DisplayServer: strings.Repeat("w", preAuthMaxRecv*2)}
	if err := c.SendTyped("caps", ipc.TypeCapabilities, big); err != nil {
		t.Fatalf("send: %v", err)
	}
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if s.GetCapabilities() != nil {
			return
		}
	}
	t.Fatal("a frame over the pre-auth cap did not reach an admitted helper's session")
}

func TestLinuxDesktopHelper_OversizeHeaderRejectedBeforeAlloc(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	_, raw, _ := admitLinuxDesktopSelf(t, b, sock, "ld-oversize")

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, 16<<20)
	if _, err := raw.Write(header); err != nil {
		t.Fatalf("write header: %v", err)
	}
	waitSessionGone(t, b, "ld-oversize", 5*time.Second)
}

func TestLinuxDesktopHelper_FrameOverCapClosesSession(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	_, raw, _ := admitLinuxDesktopSelf(t, b, sock, "ld-overcap")

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, linuxDesktopHelperMaxRecv+1)
	if _, err := raw.Write(header); err != nil {
		t.Fatalf("write header: %v", err)
	}
	waitSessionGone(t, b, "ld-overcap", 5*time.Second)
}

// A helper that starts a frame and never finishes it is cut off at the frame
// deadline, even though the connection is otherwise healthy.
func TestLinuxDesktopHelper_TrickledFrameEvicted(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind(), func(b *Broker) {
		b.linuxDesktopFrameDeadlineOverride = 200 * time.Millisecond
	})
	_, raw, _ := admitLinuxDesktopSelf(t, b, sock, "ld-trickle")

	header := make([]byte, 4)
	binary.BigEndian.PutUint32(header, 128)
	if _, err := raw.Write(append(header, '{')); err != nil {
		t.Fatalf("write partial frame: %v", err)
	}
	waitSessionGone(t, b, "ld-trickle", 5*time.Second)
}

// A helper that authenticates and then never answers a keepalive is evicted.
func TestLinuxDesktopHelper_StalledPeerEvicted(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind(), func(b *Broker) {
		b.keepaliveIntervalOverride = 20 * time.Millisecond
		b.keepaliveTimeoutOverride = 100 * time.Millisecond
	})
	admitLinuxDesktopSelf(t, b, sock, "ld-stalled")
	waitSessionGone(t, b, "ld-stalled", 5*time.Second)
}

// End to end: root's filter is live on an admitted connection, and the
// capability clamp applies to what the helper claims.
func TestLinuxDesktopHelper_FilterAndClampAreWired(t *testing.T) {
	skipIfRoot(t)
	b, sock := startLinuxDesktopBroker(t, liveSelfLogind())
	c, _, s := admitLinuxDesktopSelf(t, b, sock, "ld-wired")

	if err := c.SendTyped("caps", ipc.TypeCapabilities, ipc.Capabilities{CanCapture: true, CanNotify: true, CanClipboard: true, CanTray: true}); err != nil {
		t.Fatalf("send capabilities: %v", err)
	}
	var caps *ipc.Capabilities
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline) && caps == nil; time.Sleep(10 * time.Millisecond) {
		caps = s.GetCapabilities()
	}
	if caps == nil {
		t.Fatal("capabilities never recorded")
	}
	if caps.CanCapture || caps.CanNotify || caps.CanClipboard || caps.CanTray {
		t.Fatalf("helper granted itself capabilities: %+v", caps)
	}

	for i := range linuxDesktopInboundStrikeLimit {
		if err := c.SendTyped("frame", ipc.TypeDesktopFrame, map[string]int{"i": i}); err != nil {
			t.Fatalf("send frame: %v", err)
		}
	}
	waitSessionGone(t, b, "ld-wired", 5*time.Second)
}
