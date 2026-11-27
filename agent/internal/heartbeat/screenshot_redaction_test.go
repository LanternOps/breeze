package heartbeat

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"image"
	"io"
	"math/rand"
	"net/http"
	"net/http/httptest"
	"regexp"
	"runtime"
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/executor"
	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/remote/tools"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

// awsKeyInText is SanitizeOutput's AWS rule: unanchored and case-insensitive,
// so it fires by chance inside long base64 text.
var awsKeyInText = regexp.MustCompile(`(?i)AKIA[0-9A-Z]{16}`)

// noiseImageWithAWSShapedBase64 returns a deterministic noise image whose
// JPEG encoding (as the screenshot encoder produces it) has base64 text that
// matches the AWS-key rule, together with that base64 text.
func noiseImageWithAWSShapedBase64(t *testing.T) (*image.RGBA, string) {
	t.Helper()
	const w, h = 320, 240
	for seed := int64(1); seed <= 2000; seed++ {
		rng := rand.New(rand.NewSource(seed))
		img := image.NewRGBA(image.Rect(0, 0, w, h))
		rng.Read(img.Pix)
		data, err := desktop.EncodeJPEG(img, 85)
		if err != nil {
			t.Fatalf("encode: %v", err)
		}
		b64 := base64.StdEncoding.EncodeToString(data)
		if awsKeyInText.MatchString(b64) {
			return img, b64
		}
	}
	t.Fatal("no seed produced AWS-shaped base64; widen the search")
	return nil, ""
}

// resultServer records the body of every command result the agent posts.
type resultServer struct {
	mu     sync.Mutex
	bodies [][]byte
}

func newResultServer(t *testing.T) (*httptest.Server, *resultServer) {
	t.Helper()
	rs := &resultServer{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		rs.mu.Lock()
		rs.bodies = append(rs.bodies, body)
		rs.mu.Unlock()
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	t.Cleanup(srv.Close)
	return srv, rs
}

func (rs *resultServer) onlyBody(t *testing.T) []byte {
	t.Helper()
	rs.mu.Lock()
	defer rs.mu.Unlock()
	if len(rs.bodies) != 1 {
		t.Fatalf("server received %d result bodies, want 1", len(rs.bodies))
	}
	return rs.bodies[0]
}

// newFakeToolHelper is a capture-capable user-helper session whose helper end
// answers take_screenshot / computer_action the way the user helper's
// executeToolCommand does: it runs the same tools capture function and
// marshals the whole CommandResult into the IPC result.
func newFakeToolHelper(t *testing.T, capFn tools.CaptureFunc) *sessionbroker.Session {
	t.Helper()
	serverConn, clientConn := createTestSocketPair(t)
	client := ipc.NewConn(clientConn)
	session := sessionbroker.NewSession(ipc.NewConn(serverConn), 1000, "1000", "alice", "quartz", "helper-screenshot", []string{"desktop"})
	session.Capabilities = &ipc.Capabilities{CanCapture: true}
	session.WinSessionID = "1"
	go session.RecvLoop(func(*sessionbroker.Session, *ipc.Envelope) {})
	go func() {
		for {
			env, err := client.Recv()
			if err != nil {
				return
			}
			var cmd ipc.IPCCommand
			if err := json.Unmarshal(env.Payload, &cmd); err != nil {
				return
			}
			var payload map[string]any
			_ = json.Unmarshal(cmd.Payload, &payload)
			var res tools.CommandResult
			switch cmd.Type {
			case tools.CmdTakeScreenshot:
				res = tools.TakeScreenshotWithCapture(payload, capFn)
			case tools.CmdComputerAction:
				res = tools.ComputerActionWithCapture(payload, capFn)
			}
			resultJSON, _ := json.Marshal(res)
			_ = client.SendTyped(env.ID, ipc.TypeCommandResult, ipc.IPCCommandResult{
				CommandID: cmd.CommandID, Status: res.Status, Result: resultJSON, Error: res.Error,
			})
		}
	}()
	t.Cleanup(func() {
		_ = session.Close()
		_ = client.Close()
	})
	return session
}

// sentImage is the image a result's stdout carries, as the server will read it.
func sentImage(t *testing.T, cmdType, stdout string) string {
	t.Helper()
	if cmdType == tools.CmdTakeScreenshot {
		var shot tools.ScreenshotResponse
		if err := json.Unmarshal([]byte(stdout), &shot); err != nil {
			t.Fatalf("unmarshal %s stdout: %v", cmdType, err)
		}
		return shot.ImageBase64
	}
	var action tools.ComputerActionResponse
	if err := json.Unmarshal([]byte(stdout), &action); err != nil {
		t.Fatalf("unmarshal %s stdout: %v", cmdType, err)
	}
	if action.Screenshot == nil {
		t.Fatalf("%s result has no screenshot", cmdType)
	}
	return action.Screenshot.ImageBase64
}

// checkSentBytes asserts that both wire forms of a result carry the image
// byte-identical: the REST body the server received, and the websocket form
// the same result takes when REST is unavailable.
func checkSentBytes(t *testing.T, cmdType, commandID, want string, restBody []byte) {
	t.Helper()
	var sent tools.CommandResult
	if err := json.Unmarshal(restBody, &sent); err != nil {
		t.Fatalf("unmarshal REST body: %v", err)
	}
	if sent.Status != "completed" {
		t.Fatalf("status %q: %s", sent.Status, sent.Error)
	}
	if sentImage(t, cmdType, sent.Stdout) != want {
		t.Fatal("REST body: image is not byte-identical to the encoder output")
	}
	wsBody, err := json.Marshal(toWSCommandResult(commandID, sent))
	if err != nil {
		t.Fatalf("marshal websocket result: %v", err)
	}
	var ws struct {
		Stdout string `json:"stdout"`
	}
	if err := json.Unmarshal(wsBody, &ws); err != nil {
		t.Fatalf("unmarshal websocket result: %v", err)
	}
	if sentImage(t, cmdType, ws.Stdout) != want {
		t.Fatal("websocket result: image is not byte-identical to the encoder output")
	}
}

// #12795: the agent never runs the text redaction patterns over a screenshot
// result (only script output passes through SanitizeOutput), so an image whose
// base64 happens to match a secret pattern must reach the wire byte-identical.
// The fixture is checked to be one the text pass WOULD corrupt.
//
// What each subtest pins, up to the bytes posted to the server and the
// websocket form of the same result:
//   - via_helper (the service-mode path): the whole of processCommand:
//     handler routing, executeToolViaHelper (helper lookup, IPC send, IPC
//     decode), and submitCommandResult. The helper end is a fake that does
//     what the user helper's executeToolCommand does. The broker snapshot is
//     republished after the fake is registered, so FindCapableSession (the
//     helper lookup on every OS) finds it as it would a registered helper;
//     on macOS the preferred-desktop lookup also sees it. A lookup miss fails
//     the test; it never spawns a real helper.
//     Run on macOS. On Windows it compiles, but CI's Windows job runs only a
//     named list of heartbeat tests, and this is not one of them.
//     Skipped on Linux, because production never takes this path there:
//     handleTakeScreenshot and handleComputerAction send these commands to
//     the helper only when runtime.GOOS != "linux", and they are the only
//     callers of executeToolViaHelper.
//   - direct (every OS, and the only path on Linux): the capture call the
//     handler's direct branch makes, then the send path. The handler itself
//     is not driven: its direct branch captures through the active desktop
//     session (h.desktopCaptureFn), which a test cannot stand up. That branch
//     is the single line
//     `return tools.TakeScreenshotWithCapture(cmd.Payload, h.desktopCaptureFn())`
//     (ComputerActionWithCapture for computer_action).
//
// Not pinned: a command that arrives over the websocket. Only the conversion
// function toWSCommandResult is checked here; the websocket command entry
// that calls it is not driven, so a text pass added in that entry would
// leave this test green.
func TestScreenshotResultsAreNotTextRedacted(t *testing.T) {
	img, want := noiseImageWithAWSShapedBase64(t)
	if executor.SanitizeOutput(want) == want {
		t.Fatal("fixture is not discriminating: SanitizeOutput leaves it unchanged")
	}
	capFn := func(int) (*image.RGBA, int, int, error) {
		return img, img.Bounds().Dx(), img.Bounds().Dy(), nil
	}
	direct := map[string]func(map[string]any, tools.CaptureFunc) tools.CommandResult{
		tools.CmdTakeScreenshot: tools.TakeScreenshotWithCapture,
		tools.CmdComputerAction: tools.ComputerActionWithCapture,
	}

	for _, cmdType := range []string{tools.CmdTakeScreenshot, tools.CmdComputerAction} {
		payload := func() map[string]any {
			if cmdType == tools.CmdComputerAction {
				return map[string]any{"action": "screenshot"}
			}
			return map[string]any{}
		}

		t.Run(cmdType+"/via_helper", func(t *testing.T) {
			if runtime.GOOS == "linux" {
				t.Skip("on Linux the handlers never send take_screenshot or computer_action to a helper (runtime.GOOS gate); the direct subtest covers Linux")
			}
			srv, rs := newResultServer(t)
			h := newResultSubmitHeartbeat(srv.URL)
			h.isService = true
			broker := newTestBrokerWithSessions(t, newFakeToolHelper(t, capFn))
			// newTestBrokerWithSessions fills the live session maps, but the
			// lock-free snapshot that FindCapableSession reads still holds the
			// empty maps New() published. SetConsoleUser republishes it from
			// the live maps, so the lookup sees the fake as a registered helper.
			broker.SetConsoleUser("")
			h.sessionBroker = broker
			h.spawnHelper = func(string) error {
				return errors.New("test: helper lookup missed the fake helper; refusing to spawn a real one")
			}
			cmd := Command{ID: "cmd-helper-" + cmdType, Type: cmdType, Payload: payload()}
			h.processCommand(cmd)
			checkSentBytes(t, cmdType, cmd.ID, want, rs.onlyBody(t))
		})

		t.Run(cmdType+"/direct", func(t *testing.T) {
			srv, rs := newResultServer(t)
			h := newResultSubmitHeartbeat(srv.URL)
			commandID := "cmd-direct-" + cmdType
			if err := h.submitCommandResult(commandID, direct[cmdType](payload(), capFn)); err != nil {
				t.Fatalf("submitCommandResult: %v", err)
			}
			checkSentBytes(t, cmdType, commandID, want, rs.onlyBody(t))
		})
	}
}
