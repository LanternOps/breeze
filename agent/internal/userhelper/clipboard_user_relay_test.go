package userhelper

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/clipboard"
)

// Only the Windows system helper runs a desktop session as SYSTEM; every other
// helper reads the clipboard as the user already and keeps doing so.
func TestSystemHelperReadsClipboardViaUser(t *testing.T) {
	cases := []struct {
		goos string
		role ipc.HelperRole
		want bool
	}{
		{"windows", ipc.HelperRoleSystem, true},
		{"windows", ipc.HelperRoleUser, false},
		{"darwin", ipc.HelperRoleSystem, false},
		{"darwin", ipc.HelperRoleUser, false},
		{"linux", ipc.HelperRoleSystem, false},
	}
	for _, tc := range cases {
		if got := systemHelperReadsClipboardViaUser(tc.goos, tc.role); got != tc.want {
			t.Errorf("systemHelperReadsClipboardViaUser(%s, %s) = %v, want %v", tc.goos, tc.role, got, tc.want)
		}
	}
}

func TestWireDesktopClipboardSetsProviderOnlyForWindowsSystemHelper(t *testing.T) {
	sys := New("/tmp/test.sock", ipc.HelperRoleSystem)
	sys.wireDesktopClipboard("windows")
	if sys.desktopMgr.mgr.ClipboardProvider == nil {
		t.Fatal("windows system helper: no clipboard provider wired")
	}

	for _, tc := range []struct {
		goos string
		role ipc.HelperRole
	}{{"darwin", ipc.HelperRoleSystem}, {"windows", ipc.HelperRoleUser}} {
		c := New("/tmp/test.sock", tc.role)
		c.wireDesktopClipboard(tc.goos)
		if c.desktopMgr.mgr.ClipboardProvider != nil {
			t.Errorf("%s %s: clipboard provider wired, want the default", tc.goos, tc.role)
		}
	}
}

// serveOneClipboardRead plays the service: it reads one request and answers it
// with res, and feeds the answer back through the client's dispatch.
func serveOneClipboardRead(t *testing.T, client *Client, peer *ipc.Conn, res ipc.DesktopClipboardReadResult) <-chan ipc.DesktopClipboardReadRequest {
	t.Helper()
	got := make(chan ipc.DesktopClipboardReadRequest, 1)
	go func() {
		_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := peer.Recv()
		if err != nil {
			close(got)
			return
		}
		if env.Type != ipc.TypeDesktopClipboardRead {
			close(got)
			return
		}
		var req ipc.DesktopClipboardReadRequest
		_ = json.Unmarshal(env.Payload, &req)
		got <- req
		payload, _ := json.Marshal(res)
		_ = peer.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopClipboardReadResult, Payload: payload})
	}()
	// The client's receive loop: hand the reply to the dispatch it uses.
	go func() {
		_ = client.conn.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := client.conn.Recv()
		if err != nil {
			return
		}
		client.handleDesktopClipboardReadResult(env)
	}()
	return got
}

func TestReadClipboardViaServiceReturnsImage(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()
	png := []byte("\x89PNG\r\n\x1a\nimg")
	reqs := serveOneClipboardRead(t, client, peer, ipc.DesktopClipboardReadResult{Type: "image", Image: png, ImageFormat: "png"})

	got, err := client.readClipboardViaService("desk-1")
	if err != nil {
		t.Fatalf("readClipboardViaService: %v", err)
	}
	if got.Type != clipboard.ContentTypeImage || got.ImageFormat != "png" || !bytes.Equal(got.Image, png) {
		t.Fatalf("got %+v, want the PNG", got)
	}
	if req, ok := <-reqs; !ok || req.SessionID != "desk-1" {
		t.Fatalf("request = %+v (ok=%v), want sessionId desk-1", req, ok)
	}
}

func TestReadClipboardViaServiceUnavailable(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()
	serveOneClipboardRead(t, client, peer, ipc.DesktopClipboardReadResult{Unavailable: true})

	if _, err := client.readClipboardViaService("desk-1"); !errors.Is(err, clipboard.ErrUserClipboardUnavailable) {
		t.Fatalf("err = %v, want ErrUserClipboardUnavailable", err)
	}
}

// A service that never answers (one that predates the relay drops the
// request) is a read failure, not an empty clipboard.
func TestReadClipboardViaServiceTimeout(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()
	old := clipboardReadTimeout
	clipboardReadTimeout = 50 * time.Millisecond
	t.Cleanup(func() { clipboardReadTimeout = old })
	go func() { _, _ = peer.Recv() }() // swallow the request, never answer

	_, err := client.readClipboardViaService("desk-1")
	if err == nil || errors.Is(err, clipboard.ErrNoSupportedFormat) {
		t.Fatalf("err = %v, want a timeout that is not ErrNoSupportedFormat", err)
	}
}

// Through the real receive loop: the result message must reach the waiting
// read. Without its case in commandLoop every read would time out and the
// relay would quietly degrade to SYSTEM-only reads.
func TestCommandLoopDeliversClipboardReadResult(t *testing.T) {
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()
	loopDone := make(chan error, 1)
	go func() { loopDone <- client.commandLoop() }()

	png := []byte("\x89PNG\r\n\x1a\nimg")
	go func() {
		_ = peer.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := peer.Recv()
		if err != nil || env.Type != ipc.TypeDesktopClipboardRead {
			return
		}
		payload, _ := json.Marshal(ipc.DesktopClipboardReadResult{Type: "image", Image: png, ImageFormat: "png"})
		_ = peer.Send(&ipc.Envelope{ID: env.ID, Type: ipc.TypeDesktopClipboardReadResult, Payload: payload})
	}()

	old := clipboardReadTimeout
	clipboardReadTimeout = 2 * time.Second
	t.Cleanup(func() { clipboardReadTimeout = old })
	got, err := client.readClipboardViaService("desk-1")
	if err != nil || !bytes.Equal(got.Image, png) {
		t.Fatalf("got %+v, %v; want the PNG delivered by commandLoop", got, err)
	}

	cleanup()
	select {
	case <-loopDone:
	case <-time.After(2 * time.Second):
		t.Fatal("commandLoop did not exit after the connection closed")
	}
}

// Run is not unit-testable (it dials the service), so this guards that it
// still wires the clipboard: without the call the Windows system helper keeps
// SYSTEM-only reads and #8393 returns with every other test green.
func TestRunWiresDesktopClipboard(t *testing.T) {
	src, err := os.ReadFile("client.go")
	if err != nil {
		t.Fatal(err)
	}
	body := string(src)
	start := strings.Index(body, "func (c *Client) Run() error {")
	if start < 0 {
		t.Fatal("Run not found in client.go")
	}
	end := strings.Index(body[start:], "\n}\n")
	if end < 0 || !strings.Contains(body[start:start+end], "c.wireDesktopClipboard(runtime.GOOS)") {
		t.Fatal("Run no longer calls c.wireDesktopClipboard(runtime.GOOS)")
	}
}

// A late answer, after the read gave up, is dropped quietly.
func TestHandleDesktopClipboardReadResultIgnoresUnknownID(t *testing.T) {
	client := New("/tmp/test.sock", ipc.HelperRoleSystem)
	client.handleDesktopClipboardReadResult(&ipc.Envelope{ID: "clip-read-stale", Type: ipc.TypeDesktopClipboardReadResult})
}
