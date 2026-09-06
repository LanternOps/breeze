// Untagged on purpose: the platform dialogs behind showNotifyPromptFn are
// windows/darwin-tagged and therefore tested nowhere in CI (#3019, #3046), so
// everything that decides WHAT the dialog is asked to render, and what its answer
// means, lives on this side of the build tag.
package userhelper

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// swapNotifyPrompt installs a fake dialog and restores the real one, recording
// every request the seam was handed.
func swapNotifyPrompt(t *testing.T, fn func(ipc.NotifyRequest) (string, bool)) *[]ipc.NotifyRequest {
	t.Helper()
	var mu sync.Mutex
	seen := []ipc.NotifyRequest{}
	prev := showNotifyPromptFn
	showNotifyPromptFn = func(req ipc.NotifyRequest) (string, bool) {
		mu.Lock()
		seen = append(seen, req)
		mu.Unlock()
		return fn(req)
	}
	t.Cleanup(func() { showNotifyPromptFn = prev })
	return &seen
}

// swapNotification stubs the plain toast so tests never shell out to
// notify-send/osascript/PowerShell, and can assert the fallback fired.
func swapNotification(t *testing.T, delivered bool) *int {
	t.Helper()
	var mu sync.Mutex
	calls := 0
	prev := showNotificationFn
	showNotificationFn = func(ipc.NotifyRequest) bool {
		mu.Lock()
		calls++
		mu.Unlock()
		return delivered
	}
	t.Cleanup(func() { showNotificationFn = prev })
	return &calls
}

func notifyPayload(t *testing.T, req ipc.NotifyRequest) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal notify request: %v", err)
	}
	return raw
}

// runHandleNotify drives handleNotify and returns the single reply envelope. The
// handler is run on its own goroutine because net.Pipe is unbuffered — SendTyped
// does not return until this test reads it.
func runHandleNotify(t *testing.T, client *Client, peer *ipc.Conn, id string, req ipc.NotifyRequest) *ipc.Envelope {
	t.Helper()
	done := make(chan struct{})
	go func() {
		client.handleNotify(&ipc.Envelope{ID: id, Payload: notifyPayload(t, req)})
		close(done)
	}()
	_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	env, err := peer.Recv()
	if err != nil {
		t.Fatalf("Recv: %v", err)
	}
	<-done
	if env.ID != id {
		t.Fatalf("reply id = %q, want %q", env.ID, id)
	}
	if env.Type != ipc.TypeNotifyResult {
		t.Fatalf("reply type = %q, want %q", env.Type, ipc.TypeNotifyResult)
	}
	return env
}

func notifyResultOf(t *testing.T, env *ipc.Envelope) ipc.NotifyResult {
	t.Helper()
	var res ipc.NotifyResult
	if err := json.Unmarshal(env.Payload, &res); err != nil {
		t.Fatalf("unmarshal notify result: %v", err)
	}
	return res
}

func TestHandleNotifyRoutesActionsToThePromptSeam(t *testing.T) {
	seen := swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { return "Postpone 1 hour", true })
	toasts := swapNotification(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	env := runHandleNotify(t, client, peer, "env-1", ipc.NotifyRequest{
		Title: "Restart Scheduled", Body: "in 15 minutes",
		Actions: []string{"Restart now", "Postpone 1 hour"}, TimeoutMs: 120_000,
	})

	if len(*seen) != 1 {
		t.Fatalf("prompt seam called %d times, want 1", len(*seen))
	}
	if *toasts != 0 {
		t.Errorf("a toast was raised alongside the dialog (%d); the dialog IS the notification", *toasts)
	}
	res := notifyResultOf(t, env)
	if res.ActionClicked != "Postpone 1 hour" {
		t.Errorf("ActionClicked = %q, want %q", res.ActionClicked, "Postpone 1 hour")
	}
	if !res.Delivered {
		t.Error("Delivered = false after a dialog the user answered")
	}
}

// TestHandleNotifyWithoutActionsKeepsTheToastPath is the regression guard for the
// #3197 warning ladder: every rung that offers no postponement must stay a
// fire-and-forget toast, not a modal dialog in the user's face.
func TestHandleNotifyWithoutActionsKeepsTheToastPath(t *testing.T) {
	seen := swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { return "boom", true })
	toasts := swapNotification(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	env := runHandleNotify(t, client, peer, "env-2", ipc.NotifyRequest{
		Title: "Restart Soon", Body: "in 15 minutes",
	})

	if len(*seen) != 0 {
		t.Fatal("an actionless notify opened a modal dialog")
	}
	if *toasts != 1 {
		t.Errorf("toast calls = %d, want 1", *toasts)
	}
	res := notifyResultOf(t, env)
	if res.ActionClicked != "" {
		t.Errorf("ActionClicked = %q, want empty", res.ActionClicked)
	}
	if !res.Delivered {
		t.Error("Delivered = false for a toast the platform reported delivered")
	}
}

// TestNotifyPromptTimeoutReportsNoAction: an expired countdown is "the user did
// nothing", NOT a postponement. Silence must never grant a deferral.
func TestNotifyPromptTimeoutReportsNoAction(t *testing.T) {
	swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { return "", true })
	swapNotification(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	res := notifyResultOf(t, runHandleNotify(t, client, peer, "env-3", ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}))
	if res.ActionClicked != "" {
		t.Errorf("ActionClicked = %q, want empty on timeout", res.ActionClicked)
	}
	if !res.Delivered {
		t.Error("Delivered = false for a dialog that was shown and timed out")
	}
}

// TestHandleNotifyFallsBackToAToastWhenTheDialogCannotRender keeps the #3197
// always-warn invariant independent of the prompt. A dialog that could not open
// (no window server, a failed user32 call) must not swallow the warning.
func TestHandleNotifyFallsBackToAToastWhenTheDialogCannotRender(t *testing.T) {
	swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { return "", false })
	toasts := swapNotification(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	res := notifyResultOf(t, runHandleNotify(t, client, peer, "env-4", ipc.NotifyRequest{
		Title: "Restart Scheduled", Actions: []string{"Restart now", "Postpone 1 hour"},
	}))
	if *toasts != 1 {
		t.Fatalf("toast calls = %d, want 1 — the user was told nothing at all", *toasts)
	}
	if res.ActionClicked != "" {
		t.Errorf("ActionClicked = %q, want empty when no dialog rendered", res.ActionClicked)
	}
	if !res.Delivered {
		t.Error("Delivered = false although the fallback toast was delivered")
	}
}

// TestHandleNotifyReportsUndeliveredWhenEverythingFails: the daemon must be able
// to tell "shown" from "reached nobody" rather than being told a comfortable lie.
func TestHandleNotifyReportsUndeliveredWhenEverythingFails(t *testing.T) {
	swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { return "", false })
	swapNotification(t, false)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	res := notifyResultOf(t, runHandleNotify(t, client, peer, "env-5", ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	}))
	if res.Delivered {
		t.Error("Delivered = true although neither the dialog nor the toast rendered")
	}
}

// TestHandleNotifyAlwaysRepliesEvenWhenThePromptPanics: handleNotify is dispatched
// via safeGo, which recovers panics but sends nothing back. The daemon now WAITS
// on this reply, so a panic in the raw user32 syscall path would otherwise cost a
// full prompt timeout of silence on every rung.
func TestHandleNotifyAlwaysRepliesEvenWhenThePromptPanics(t *testing.T) {
	swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { panic("dialog exploded") })
	swapNotification(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	env := runHandleNotify(t, client, peer, "env-6", ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"},
	})
	if env.Error == "" {
		t.Error("a panicking dialog produced no error reply; the daemon would wait out the whole timeout")
	}
	if got := notifyResultOf(t, env).ActionClicked; got != "" {
		t.Errorf("ActionClicked = %q after a panic, want empty", got)
	}
}

// TestConcurrentNotifyPromptsDoNotStackModalDialogs: MB_SYSTEMMODAL|MB_TOPMOST
// dialogs stack on top of one another and each one steals focus. A second prompt
// arriving while one is open falls back to a toast instead.
func TestConcurrentNotifyPromptsDoNotStackModalDialogs(t *testing.T) {
	release := make(chan struct{})
	entered := make(chan struct{}, 1)
	swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) {
		select {
		case entered <- struct{}{}:
		default:
		}
		<-release
		return "Postpone 1 hour", true
	})
	toasts := swapNotification(t, true)

	first, firstPeer, cleanupFirst := createClientPipe(t)
	defer cleanupFirst()
	second, secondPeer, cleanupSecond := createClientPipe(t)
	defer cleanupSecond()

	req := ipc.NotifyRequest{Actions: []string{"Restart now", "Postpone 1 hour"}}
	go first.handleNotify(&ipc.Envelope{ID: "env-a", Payload: notifyPayload(t, req)})
	<-entered

	// The second request must not wait on the first: it takes the toast path.
	res := notifyResultOf(t, runHandleNotify(t, second, secondPeer, "env-b", req))
	if res.ActionClicked != "" {
		t.Errorf("ActionClicked = %q — a second modal dialog was opened over the first", res.ActionClicked)
	}
	if *toasts != 1 {
		t.Errorf("toast calls = %d, want 1 — the second warning reached nobody", *toasts)
	}

	close(release)
	_ = firstPeer.SetReadDeadline(time.Now().Add(5 * time.Second))
	if _, err := firstPeer.Recv(); err != nil {
		t.Fatalf("first handler never replied: %v", err)
	}
}

func TestNotifyPromptTimeoutMsIsBounded(t *testing.T) {
	t.Parallel()
	cases := []struct{ in, want int }{
		{0, defaultNotifyPromptTimeoutMs},
		{-1, defaultNotifyPromptTimeoutMs},
		{30_000, 30_000},
		{maxNotifyPromptTimeoutMs, maxNotifyPromptTimeoutMs},
		{maxNotifyPromptTimeoutMs + 1, maxNotifyPromptTimeoutMs},
	}
	for _, tc := range cases {
		if got := notifyPromptTimeoutMs(ipc.NotifyRequest{TimeoutMs: tc.in}); got != tc.want {
			t.Errorf("notifyPromptTimeoutMs(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

// TestNotifyPromptSeesASanitizedRequest: the Actions cap (notify_common.go) is
// already implemented but was never load-bearing. It now bounds the dialog's
// button row, and an untrimmed action would be pasted straight into an AppleScript
// string or a UTF16 buffer.
func TestNotifyPromptSeesASanitizedRequest(t *testing.T) {
	seen := swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { return "", true })
	swapNotification(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	runHandleNotify(t, client, peer, "env-7", ipc.NotifyRequest{
		Title:   strings.Repeat("t", maxNotifyTitleBytes+50),
		Actions: []string{" Restart now ", "b", "c", "d", "e", "f"},
	})

	if len(*seen) != 1 {
		t.Fatalf("prompt seam called %d times, want 1", len(*seen))
	}
	got := (*seen)[0]
	if len(got.Actions) != 4 {
		t.Errorf("len(Actions) = %d, want the sanitiser's cap of 4", len(got.Actions))
	}
	if got.Actions[0] != "Restart now" {
		t.Errorf("Actions[0] = %q, want it trimmed", got.Actions[0])
	}
	if len(got.Title) != maxNotifyTitleBytes {
		t.Errorf("len(Title) = %d, want it truncated to %d", len(got.Title), maxNotifyTitleBytes)
	}
}

// TestNotifyPromptButtonForCode pins the answer mapping both native dialogs share.
// Neither platform's dialog code runs in CI, so the arithmetic that turns a
// button index into a label lives here, untagged.
func TestNotifyPromptButtonForCode(t *testing.T) {
	t.Parallel()
	actions := []string{"Restart now", "Postpone 1 hour"}
	cases := []struct {
		name    string
		actions []string
		index   int
		want    string
	}{
		{"affirmative", actions, 0, "Restart now"},
		{"postpone", actions, 1, "Postpone 1 hour"},
		{"index past the end is no decision", actions, 2, ""},
		{"negative index is no decision", actions, -1, ""},
		{"single-action request has no second button", []string{"Restart now"}, 1, ""},
		{"no actions at all", nil, 0, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := notifyPromptAction(tc.actions, tc.index); got != tc.want {
				t.Errorf("notifyPromptAction(%v, %d) = %q, want %q", tc.actions, tc.index, got, tc.want)
			}
		})
	}
}

// TestNotifyPromptLegend pins the Windows body copy. MB_YESNO's labels cannot be
// renamed, so without this the dialog is a bare Yes/No about nothing.
func TestNotifyPromptLegend(t *testing.T) {
	t.Parallel()
	got := notifyPromptLegend([]string{"Restart now", "Postpone 1 hour"})
	for _, want := range []string{"Yes", "restart now", "No", "postpone 1 hour"} {
		if !strings.Contains(got, want) {
			t.Errorf("legend %q is missing %q", got, want)
		}
	}
	if notifyPromptLegend(nil) != "" {
		t.Errorf("legend for no actions = %q, want empty", notifyPromptLegend(nil))
	}
	if got := notifyPromptLegend([]string{"Restart now"}); strings.Contains(got, "No to") {
		t.Errorf("legend %q promises a No button that does not exist", got)
	}
}

// TestNotifyPromptDialogButtonsPutTheAffirmativeLast: AppleScript draws the last
// button rightmost, which is where macOS puts the default action. Actions[0] is
// the affirmative, so it must end up last — getting this backwards would put
// "Postpone" under the user's return key.
func TestNotifyPromptDialogButtonsPutTheAffirmativeLast(t *testing.T) {
	t.Parallel()
	got := notifyPromptDialogButtons([]string{"Restart now", "Postpone 1 hour"})
	want := []string{"Postpone 1 hour", "Restart now"}
	if len(got) != len(want) {
		t.Fatalf("buttons = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("buttons = %v, want %v", got, want)
		}
	}
	if len(notifyPromptDialogButtons(nil)) != 0 {
		t.Error("no actions produced buttons")
	}
	if got := notifyPromptDialogButtons([]string{"a", "", "  ", "b"}); len(got) != 2 {
		t.Errorf("blank actions became buttons: %v", got)
	}
	// osascript rejects a dialog with more than three buttons outright, which
	// would turn every prompt into an exec error and warn nobody.
	if got := notifyPromptDialogButtons([]string{"a", "b", "c", "d"}); len(got) != maxNotifyPromptDialogButtons {
		t.Errorf("len(buttons) = %d, want the AppleScript cap of %d", len(got), maxNotifyPromptDialogButtons)
	}
}

// TestNotifyPromptClickedButton pins the osascript record parsing, including the
// case that matters most: a label we never offered is not a decision.
func TestNotifyPromptClickedButton(t *testing.T) {
	t.Parallel()
	buttons := []string{"Postpone 1 hour", "Restart now"}
	cases := []struct {
		name   string
		output string
		want   string
	}{
		{"affirmative", "button returned:Restart now, gave up:false\n", "Restart now"},
		{"postpone", "button returned:Postpone 1 hour, gave up:false\n", "Postpone 1 hour"},
		{"no gave-up suffix", "button returned:Restart now\n", "Restart now"},
		{"gave up", "gave up:true\n", ""},
		{"empty output", "", ""},
		{"a label we never offered", "button returned:Format the disk, gave up:false\n", ""},
		{"partial label is not a match", "button returned:Restart, gave up:false\n", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := notifyPromptClickedButton(tc.output, buttons); got != tc.want {
				t.Errorf("notifyPromptClickedButton(%q) = %q, want %q", tc.output, got, tc.want)
			}
		})
	}
}
