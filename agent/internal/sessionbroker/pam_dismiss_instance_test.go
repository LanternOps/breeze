package sessionbroker

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

// #8995: an approved elevation must dismiss only the consent.exe it was raised
// from. An older helper ignores the instance field and would Escape whatever
// prompt it finds, so the broker must refuse to send a targeted dismissal to a
// helper that did not advertise support — before anything crosses the pipe.
func TestDismissPamConsentInstanceRefusesHelperWithoutTargetedSupport(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()
	session.SupportsTargetedPamDismiss = false

	sent := make(chan struct{}, 1)
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(300 * time.Millisecond))
		if _, err := clientIPC.Recv(); err == nil {
			sent <- struct{}{}
		}
	}()

	_, err := (&Broker{}).DismissPamConsentInstance(session, "dismiss-old-helper",
		ipc.PamConsentInstance{PID: 4242, CreatedUnixNano: 1}, time.Second)
	if !errors.Is(err, ErrPamTargetedDismissUnsupported) {
		t.Fatalf("error = %v, want ErrPamTargetedDismissUnsupported", err)
	}
	var uncertain *PamDismissUncertainError
	if errors.As(err, &uncertain) {
		t.Fatalf("refusal must be definite (nothing sent), got uncertain: %v", err)
	}
	select {
	case <-sent:
		t.Fatal("a targeted dismissal was sent to a helper that cannot honour the target")
	case <-time.After(400 * time.Millisecond):
	}
}

func TestDismissPamConsentInstanceRejectsEmptyInstance(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()
	session.SupportsTargetedPamDismiss = true

	for _, inst := range []ipc.PamConsentInstance{{}, {PID: 7}, {CreatedUnixNano: 7}} {
		if _, err := (&Broker{}).DismissPamConsentInstance(session, "dismiss-empty", inst, time.Second); err == nil {
			t.Fatalf("instance %+v accepted; an untargeted request must never go out on this path", inst)
		}
	}
}

func TestDismissPamConsentInstanceSendsTargetAndReturnsResult(t *testing.T) {
	session, clientIPC := createPamDismissTestSession()
	defer func() { _ = session.Close() }()
	defer func() { _ = clientIPC.Close() }()
	session.SupportsTargetedPamDismiss = true

	want := ipc.PamConsentInstance{PID: 4242, CreatedUnixNano: 1_700_000_000_123_456_700}
	reply := ipc.PamDismissConsentResult{Success: true, Reason: "ok"}
	helperDone := make(chan error, 1)
	go func() {
		_ = clientIPC.SetReadDeadline(time.Now().Add(2 * time.Second))
		env, err := clientIPC.Recv()
		if err != nil {
			helperDone <- err
			return
		}
		var req ipc.PamDismissConsentRequest
		if err := json.Unmarshal(env.Payload, &req); err != nil {
			helperDone <- err
			return
		}
		if env.Type != ipc.TypePamDismissConsent || req.Instance == nil || *req.Instance != want || req.DeadlineUnixMs <= 0 {
			helperDone <- fmt.Errorf("request = %s %+v, want targeted %+v", env.Type, req, want)
			return
		}
		helperDone <- clientIPC.SendTyped(env.ID, ipc.TypePamDismissConsentResult, reply)
	}()
	go session.RecvLoop(func(s *Session, env *ipc.Envelope) {})

	got, err := (&Broker{}).DismissPamConsentInstance(session, "dismiss-targeted", want, 2*time.Second)
	if err != nil {
		t.Fatalf("DismissPamConsentInstance: %v", err)
	}
	if herr := <-helperDone; herr != nil {
		t.Fatalf("helper side: %v", herr)
	}
	if got != reply {
		t.Fatalf("result = %+v, want %+v", got, reply)
	}
}

func TestDismissPamConsentStaysUntargeted(t *testing.T) {
	// The deny path keeps its existing wire shape: no instance field at all.
	raw, err := json.Marshal(ipc.PamDismissConsentRequest{DeadlineUnixMs: 1})
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"deadlineUnixMs":1}` {
		t.Fatalf("untargeted request = %s, want deadline only", raw)
	}
}

// The auth path copies the advertised bit onto the session through
// applyAuthAdvertisements; dropping that copy would refuse every real helper.
func TestApplyAuthAdvertisementsSetsTargetedPamDismiss(t *testing.T) {
	session := &Session{}
	applyAuthAdvertisements(session, ipc.HelperRoleSystem, ipc.AuthRequest{SupportsTargetedPamDismiss: true})
	if !session.SupportsTargetedPamDismiss {
		t.Fatal("SYSTEM helper's targeted-dismiss advertisement was not recorded on the session")
	}
	older := &Session{}
	applyAuthAdvertisements(older, ipc.HelperRoleSystem, ipc.AuthRequest{})
	if older.SupportsTargetedPamDismiss {
		t.Fatal("older SYSTEM helper marked as supporting targeted dismissal")
	}
	assist := &Session{}
	applyAuthAdvertisements(assist, ipc.HelperRoleAssist, ipc.AuthRequest{ConsentProtocolVersion: 2})
	if assist.ConsentProtocolVersion != 2 {
		t.Fatalf("ConsentProtocolVersion = %d, want 2 (existing advertisement must still apply)", assist.ConsentProtocolVersion)
	}
}

func TestTargetedPamDismissFromAuth(t *testing.T) {
	tests := []struct {
		name string
		role ipc.HelperRole
		req  ipc.AuthRequest
		want bool
	}{
		{"system helper advertising support", ipc.HelperRoleSystem, ipc.AuthRequest{SupportsTargetedPamDismiss: true}, true},
		{"older system helper", ipc.HelperRoleSystem, ipc.AuthRequest{}, false},
		{"user helper cannot dismiss consent", ipc.HelperRoleUser, ipc.AuthRequest{SupportsTargetedPamDismiss: true}, false},
		{"assist helper cannot dismiss consent", ipc.HelperRoleAssist, ipc.AuthRequest{SupportsTargetedPamDismiss: true}, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := targetedPamDismissFromAuth(tt.role, tt.req); got != tt.want {
				t.Fatalf("targetedPamDismissFromAuth = %v, want %v", got, tt.want)
			}
		})
	}
}
