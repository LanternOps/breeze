// Untagged: the dialog behind showNoticeDialogFn is windows/darwin-tagged and so
// untested in CI; the decision of WHEN it opens lives here (#6864).
package userhelper

import (
	"sync"
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func swapNoticeDialog(t *testing.T, shown bool) *int {
	t.Helper()
	var mu sync.Mutex
	calls := 0
	prev := showNoticeDialogFn
	showNoticeDialogFn = func(ipc.NotifyRequest) bool {
		mu.Lock()
		calls++
		mu.Unlock()
		return shown
	}
	t.Cleanup(func() { showNoticeDialogFn = prev })
	return &calls
}

// TestHandleNotifyFallbackDialogWhenToastFails is the #6864 guard: a
// remote-session notice whose toast fails (a toast raised outside the user's
// notification platform, toasts disabled) must still reach the user.
func TestHandleNotifyFallbackDialogWhenToastFails(t *testing.T) {
	swapNotification(t, false)
	dialogs := swapNoticeDialog(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	res := notifyResultOf(t, runHandleNotify(t, client, peer, "fb-1", ipc.NotifyRequest{
		Title: "Breeze Agent", Body: "A technician connected", FallbackDialog: true,
	}))
	if *dialogs != 1 {
		t.Fatalf("fallback dialog calls = %d, want 1", *dialogs)
	}
	if !res.Delivered {
		t.Error("Delivered = false although the fallback dialog was shown")
	}
}

func TestHandleNotifyFallbackDialogNotUsedWhenToastWorks(t *testing.T) {
	toasts := swapNotification(t, true)
	dialogs := swapNoticeDialog(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	res := notifyResultOf(t, runHandleNotify(t, client, peer, "fb-2", ipc.NotifyRequest{
		Body: "A technician connected", FallbackDialog: true,
	}))
	if *toasts != 1 || *dialogs != 0 {
		t.Fatalf("toasts=%d dialogs=%d, want 1 and 0", *toasts, *dialogs)
	}
	if !res.Delivered {
		t.Error("Delivered = false for a delivered toast")
	}
}

// TestHandleNotifyNoFallbackDialogWithoutTheFlag keeps the #3197 reboot ladder
// a toast: a failed toast on an ordinary notification must not turn into a
// dialog in the user's face.
func TestHandleNotifyNoFallbackDialogWithoutTheFlag(t *testing.T) {
	swapNotification(t, false)
	dialogs := swapNoticeDialog(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	res := notifyResultOf(t, runHandleNotify(t, client, peer, "fb-3", ipc.NotifyRequest{
		Title: "Restart Soon", Body: "in 15 minutes",
	}))
	if *dialogs != 0 {
		t.Fatalf("an ordinary notification opened the fallback dialog (%d)", *dialogs)
	}
	if res.Delivered {
		t.Error("Delivered = true although the toast failed")
	}
}

func TestHandleNotifyFallbackDialogFailureReportsUndelivered(t *testing.T) {
	swapNotification(t, false)
	dialogs := swapNoticeDialog(t, false)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	res := notifyResultOf(t, runHandleNotify(t, client, peer, "fb-4", ipc.NotifyRequest{
		Body: "A technician connected", FallbackDialog: true,
	}))
	if *dialogs != 1 {
		t.Fatalf("fallback dialog calls = %d, want 1", *dialogs)
	}
	if res.Delivered {
		t.Error("Delivered = true although neither the toast nor the dialog rendered")
	}
}

// A request with Actions is a prompt; FallbackDialog does not change that path.
func TestHandleNotifyFallbackDialogIgnoredForPrompts(t *testing.T) {
	swapNotifyPrompt(t, func(ipc.NotifyRequest) (string, bool) { return "", false })
	swapNotification(t, false)
	dialogs := swapNoticeDialog(t, true)
	client, peer, cleanup := createClientPipe(t)
	defer cleanup()

	_ = notifyResultOf(t, runHandleNotify(t, client, peer, "fb-5", ipc.NotifyRequest{
		Actions: []string{"Restart now", "Postpone 1 hour"}, FallbackDialog: true,
	}))
	if *dialogs != 0 {
		t.Fatalf("prompt path opened the notice dialog (%d)", *dialogs)
	}
}
