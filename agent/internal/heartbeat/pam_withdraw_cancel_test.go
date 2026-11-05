package heartbeat

import (
	"context"
	"net/http"
	"testing"

	"github.com/breeze-rmm/agent/internal/pamdecline"
)

// #10190 W07: Cancel request withdraws with user_cancelled and names the
// renderer that carried it; the file keeps user_denied for older builds.
func TestWithdrawSendsUserCancelledAndTheRenderer(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusOK)
	h, store, _ := newWithdrawHeartbeat(t, srv.ts.URL)
	if _, err := store.BeginAwaiting(withdrawReq, "pending"); err != nil {
		t.Fatal(err)
	}
	if err := store.Decline(withdrawReq, pamdecline.ReasonUserCancelled); err != nil {
		t.Fatal(err)
	}
	h.rememberPamWithdrawRenderer(withdrawReq, elevationRendererAssist)

	h.drainPamWithdrawals(context.Background())

	if srv.count() != 1 {
		t.Fatalf("server saw %d requests", srv.count())
	}
	body := srv.requests[0].body
	if body["reason"] != "user_cancelled" || body["renderer"] != "assist" {
		t.Fatalf("body = %v", body)
	}
}

func TestWithdrawOmitsAnUnknownRenderer(t *testing.T) {
	srv := newWithdrawServer(t, http.StatusOK)
	h, store, _ := newWithdrawHeartbeat(t, srv.ts.URL)
	declinePending(t, store, withdrawReq)
	h.drainPamWithdrawals(context.Background())
	if _, ok := srv.requests[0].body["renderer"]; ok {
		t.Fatalf("renderer sent without one recorded: %v", srv.requests[0].body)
	}
}
