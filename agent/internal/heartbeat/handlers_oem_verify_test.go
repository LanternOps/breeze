package heartbeat

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/oemupdates"
)

func TestPutOemVerificationMapsStatuses(t *testing.T) {
	const path = "/api/v1/agents/agent-1/oem-updates/verification"
	v := oemupdates.Verification{CommandID: oemTestCmdID, BitlockerAfter: oemupdates.BitLockerOn}
	cases := []struct {
		status int
		want   error // nil, ErrVerificationNotFound, ErrVerificationRejected, or errTransient
	}{
		{http.StatusOK, nil},
		{http.StatusNoContent, nil},
		{http.StatusNotFound, oemupdates.ErrVerificationNotFound},
		{http.StatusBadRequest, oemupdates.ErrVerificationRejected},
		{http.StatusForbidden, oemupdates.ErrVerificationRejected},
		{http.StatusConflict, oemupdates.ErrVerificationRejected},
		{http.StatusUnprocessableEntity, oemupdates.ErrVerificationRejected},
		{http.StatusUnauthorized, errTransient},
	}
	for _, c := range cases {
		rs := newRouteServer(t)
		status := c.status
		rs.answer(path, func(w http.ResponseWriter) { w.WriteHeader(status) })
		h, _ := deferralTestHeartbeat(t, rs)
		err := h.putOemVerification(v)
		switch {
		case c.want == nil && err != nil:
			t.Errorf("%d: err = %v, want nil", c.status, err)
		case c.want == errTransient && (err == nil || errors.Is(err, oemupdates.ErrVerificationRejected) || errors.Is(err, oemupdates.ErrVerificationNotFound)):
			t.Errorf("%d: err = %v, want a retryable error", c.status, err)
		case c.want != nil && c.want != errTransient && !errors.Is(err, c.want):
			t.Errorf("%d: err = %v, want %v", c.status, err, c.want)
		}
		if rs.count(path) != 1 {
			t.Errorf("%d: %d requests, want 1", c.status, rs.count(path))
		}
	}
}

var errTransient = errors.New("transient")

func TestPutOemVerificationHonoursRetryAfter(t *testing.T) {
	rs := newRouteServer(t)
	h, _ := deferralTestHeartbeat(t, rs)
	h.loopDefer.Record(loopKey("PUT", h.agentRouteURL("oem-updates/verification")), retryAtErr(time.Now().Add(time.Minute)))
	err := h.putOemVerification(oemupdates.Verification{CommandID: oemTestCmdID, BitlockerAfter: oemupdates.BitLockerOn})
	if err == nil || errors.Is(err, oemupdates.ErrVerificationRejected) {
		t.Fatalf("err = %v, want a retryable deferral", err)
	}
	if n := rs.total.Load(); n != 0 {
		t.Fatalf("a deferred route was called %d times", n)
	}
}
