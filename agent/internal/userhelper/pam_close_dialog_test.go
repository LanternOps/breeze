package userhelper

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #10370: the deny path asks the SYSTEM helper to take down its own PAM
// dialog, and waits for it to be gone, before dismissing consent.exe — the
// dialog is topmost and holds the foreground, so an Escape meant for the UAC
// prompt would otherwise land on it.

func swapShowPamDialog(t *testing.T, fn func(context.Context, ipc.PamRequestDialog) ipc.PamDialogResult) {
	t.Helper()
	prev := showPamDialogFn
	showPamDialogFn = fn
	t.Cleanup(func() { showPamDialogFn = prev })
}

func swapPamDialogCloseWait(t *testing.T, d time.Duration) {
	t.Helper()
	prev := pamDialogCloseWait
	pamDialogCloseWait = d
	t.Cleanup(func() { pamDialogCloseWait = prev })
}

func pamCloseEnvelope(t *testing.T, id, dialogID string) *ipc.Envelope {
	t.Helper()
	payload, err := json.Marshal(ipc.PamCloseDialog{DialogID: dialogID})
	if err != nil {
		t.Fatal(err)
	}
	return &ipc.Envelope{ID: id, Type: ipc.TypePamCloseDialog, Payload: payload}
}

// recvByID reads n envelopes from peer and indexes them by id.
func recvByID(t *testing.T, peer *ipc.Conn, n int) map[string]*ipc.Envelope {
	t.Helper()
	out := make(map[string]*ipc.Envelope, n)
	for i := 0; i < n; i++ {
		if err := peer.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
			t.Fatal(err)
		}
		env, err := peer.Recv()
		if err != nil {
			t.Fatalf("recv %d/%d: %v", i+1, n, err)
		}
		out[env.ID] = env
	}
	return out
}

func decodeCloseResult(t *testing.T, env *ipc.Envelope) ipc.PamCloseDialogResult {
	t.Helper()
	if env == nil {
		t.Fatal("no pam_close_dialog_result received")
	}
	if env.Type != ipc.TypePamCloseDialogResult {
		t.Fatalf("type = %q, want %q", env.Type, ipc.TypePamCloseDialogResult)
	}
	if env.Error != "" {
		t.Fatalf("close returned error %q", env.Error)
	}
	var res ipc.PamCloseDialogResult
	if err := json.Unmarshal(env.Payload, &res); err != nil {
		t.Fatal(err)
	}
	return res
}

func startPamDialog(t *testing.T, client *Client, id string) {
	t.Helper()
	payload, err := json.Marshal(ipc.PamRequestDialog{ExePath: `C:\app.exe`, TimeoutSeconds: 90})
	if err != nil {
		t.Fatal(err)
	}
	go client.handlePamDialog(&ipc.Envelope{ID: id, Type: ipc.TypePamRequestDialog, Payload: payload})
}

func TestPamCloseDialogClosesTheOpenDialogAndConfirms(t *testing.T) {
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)
	shown := make(chan struct{})
	cancelled := make(chan struct{})
	swapShowPamDialog(t, func(ctx context.Context, _ ipc.PamRequestDialog) ipc.PamDialogResult {
		close(shown)
		<-ctx.Done() // the window closes only when the agent asks
		close(cancelled)
		return ipc.PamDialogResult{Approved: false, DismissedByUser: true}
	})

	startPamDialog(t, client, "req-1")
	<-shown
	go client.handlePamCloseDialog(pamCloseEnvelope(t, "req-1-close-dialog", "req-1"))

	got := recvByID(t, peer, 2)
	res := decodeCloseResult(t, got["req-1-close-dialog"])
	if !res.Closed || !res.WasOpen {
		t.Fatalf("close result = %+v, want closed and was open", res)
	}
	select {
	case <-cancelled:
	default:
		t.Fatal("close confirmed before the dialog had returned")
	}
	if d := got["req-1"]; d == nil || d.Type != ipc.TypePamDialogResult {
		t.Fatalf("dialog result = %+v, want the dialog's own pam_dialog_result", d)
	}
}

func TestPamCloseDialogWithNoOpenDialogReportsClosed(t *testing.T) {
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)
	go client.handlePamCloseDialog(pamCloseEnvelope(t, "req-2-close-dialog", "req-2"))

	res := decodeCloseResult(t, recvByID(t, peer, 1)["req-2-close-dialog"])
	if !res.Closed || res.WasOpen {
		t.Fatalf("close result = %+v, want closed, not open", res)
	}
}

func TestPamCloseDialogLeavesOtherDialogsAlone(t *testing.T) {
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)
	shown := make(chan struct{})
	release := make(chan struct{})
	cancelled := make(chan struct{}, 1)
	swapShowPamDialog(t, func(ctx context.Context, _ ipc.PamRequestDialog) ipc.PamDialogResult {
		close(shown)
		select {
		case <-ctx.Done():
			cancelled <- struct{}{}
		case <-release:
		}
		return ipc.PamDialogResult{}
	})

	startPamDialog(t, client, "req-other")
	<-shown
	go client.handlePamCloseDialog(pamCloseEnvelope(t, "req-3-close-dialog", "req-3"))
	res := decodeCloseResult(t, recvByID(t, peer, 1)["req-3-close-dialog"])
	if res.WasOpen {
		t.Fatalf("close result = %+v; another request's dialog was treated as this one", res)
	}
	select {
	case <-cancelled:
		t.Fatal("closing req-3 took down req-other's dialog")
	default:
	}
	close(release)
	recvByID(t, peer, 1) // req-other's own result
}

func TestPamCloseDialogReportsAWindowThatWouldNotClose(t *testing.T) {
	client, peer := newPamDismissPipe(t, ipc.HelperRoleSystem, ipc.ScopePam)
	swapPamDialogCloseWait(t, 50*time.Millisecond)
	shown := make(chan struct{})
	release := make(chan struct{})
	// The MessageBox fallback cannot be closed from outside.
	swapShowPamDialog(t, func(context.Context, ipc.PamRequestDialog) ipc.PamDialogResult {
		close(shown)
		<-release
		return ipc.PamDialogResult{}
	})

	startPamDialog(t, client, "req-4")
	<-shown
	go client.handlePamCloseDialog(pamCloseEnvelope(t, "req-4-close-dialog", "req-4"))
	res := decodeCloseResult(t, recvByID(t, peer, 1)["req-4-close-dialog"])
	if res.Closed || !res.WasOpen || res.Reason == "" {
		t.Fatalf("close result = %+v, want not closed, was open, with a reason", res)
	}
	close(release)
	recvByID(t, peer, 1)
}

func TestPamCloseDialogRequiresSystemHelperWithPamScope(t *testing.T) {
	for _, tc := range []struct {
		name   string
		role   ipc.HelperRole
		scopes []string
	}{
		{"user helper", ipc.HelperRoleUser, []string{ipc.ScopePam}},
		{"system helper without pam scope", ipc.HelperRoleSystem, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, peer := newPamDismissPipe(t, tc.role, tc.scopes...)
			go client.handlePamCloseDialog(pamCloseEnvelope(t, "req-5-close-dialog", "req-5"))
			env := recvByID(t, peer, 1)["req-5-close-dialog"]
			if env == nil || env.Type != ipc.TypePamCloseDialogResult || env.Error == "" {
				t.Fatalf("response = %+v, want a pam_close_dialog_result error", env)
			}
		})
	}
}

func TestSupportsPamDialogCloseForAuth(t *testing.T) {
	if !supportsPamDialogCloseForAuth(ipc.HelperRoleSystem) {
		t.Fatal("the SYSTEM helper shows the PAM dialog and must advertise pam_close_dialog")
	}
	if supportsPamDialogCloseForAuth(ipc.HelperRoleUser) {
		t.Fatal("a user helper never shows the PAM dialog")
	}
}
