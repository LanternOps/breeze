package sessionbroker

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #10370: before denying, the agent takes down its own PAM dialog. An older
// helper does not know pam_close_dialog, so it is never sent one.
func TestClosePamDialogRefusesHelperWithoutSupport(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()

	sent := make(chan struct{}, 1)
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		if _, err := clientIPC.Recv(); err == nil {
			sent <- struct{}{}
		}
	}()

	_, err := (&Broker{}).ClosePamDialog(session, "req-close-dialog", "req", time.Second)
	if !errors.Is(err, ErrPamDialogCloseUnsupported) {
		t.Fatalf("error = %v, want ErrPamDialogCloseUnsupported", err)
	}
	select {
	case <-sent:
		t.Fatal("pam_close_dialog was sent to a helper that never advertised it")
	case <-time.After(400 * time.Millisecond):
	}
}

func TestClosePamDialogRejectsReusedID(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()
	session.SupportsPamDialogClose = true

	for _, tc := range []struct{ id, dialogID string }{{"req", "req"}, {"req-close", ""}} {
		if _, err := (&Broker{}).ClosePamDialog(session, tc.id, tc.dialogID, time.Second); err == nil {
			t.Fatalf("ClosePamDialog(%q, %q) accepted; the close must have its own id and name a dialog", tc.id, tc.dialogID)
		}
	}
}

func TestClosePamDialogSendsDialogIDAndReturnsResult(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()
	session.SupportsPamDialogClose = true

	reply := ipc.PamCloseDialogResult{Closed: true, WasOpen: true}
	helperDone := make(chan error, 1)
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			helperDone <- err
			return
		}
		var req ipc.PamCloseDialog
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			helperDone <- err
			return
		}
		if env.Type != ipc.TypePamCloseDialog || env.ID != "req-close-dialog" || req.DialogID != "req" {
			helperDone <- fmt.Errorf("request = %s id=%s %+v, want pam_close_dialog for dialog req", env.Type, env.ID, req)
			return
		}
		helperDone <- clientIPC.SendTyped(env.ID, ipc.TypePamCloseDialogResult, reply)
	}()
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {})

	got, err := (&Broker{}).ClosePamDialog(session, "req-close-dialog", "req", 2*time.Second)
	if err != nil {
		t.Fatalf("ClosePamDialog: %v", err)
	}
	if herr := <-helperDone; herr != nil {
		t.Fatalf("helper side: %v", herr)
	}
	if got != reply {
		t.Fatalf("result = %+v, want %+v", got, reply)
	}
}

func TestPamDialogCloseFromAuth(t *testing.T) {
	cases := []struct {
		name string
		role ipc.HelperRole
		auth ipc.AuthRequest
		want bool
	}{
		{"system helper advertising support", ipc.HelperRoleSystem, ipc.AuthRequest{SupportsPamDialogClose: true}, true},
		{"older system helper", ipc.HelperRoleSystem, ipc.AuthRequest{}, false},
		{"user helper never shows the PAM dialog", ipc.HelperRoleUser, ipc.AuthRequest{SupportsPamDialogClose: true}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Session{}
			applyAuthAdvertisements(s, tc.role, tc.auth)
			if s.SupportsPamDialogClose != tc.want {
				t.Fatalf("SupportsPamDialogClose = %v, want %v", s.SupportsPamDialogClose, tc.want)
			}
		})
	}
}
