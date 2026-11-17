package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/websocket"
)

func startSkewTestStream(t *testing.T, id string) (*Heartbeat, *desktop.WsSessionManager) {
	t.Helper()
	mgr := newTestStreamManager()
	h := &Heartbeat{desktopMgr: desktop.NewSessionManager(), wsDesktopMgr: mgr}
	send := func(string, []byte) error { return nil }
	_, _, s, err := mgr.StartSession(id, 0, desktop.DefaultStreamConfig(), testStreamLease(time.Second), send)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(s.Stop)
	return h, mgr
}

// When the answer echoes the request's anchor, the lease is measured from
// when the agent ASKED, not from when the answer arrived: a slow round trip
// (a held-back frame, a slow database check) can only shorten the lease.
func TestRevocationLeaseRenewalIsMeasuredFromTheRequest(t *testing.T) {
	h, mgr := startSkewTestStream(t, "ws-anchor")
	requestedAt := time.Now().Add(-40 * time.Second) // the answer took 40 s
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:        "ws-anchor",
		ExpiresAtUnixMs:  time.Now().Add(time.Hour).UnixMilli(), // must be ignored
		ExpiresInMs:      time.Minute.Milliseconds(),
		HardDeadlineInMs: (30 * time.Minute).Milliseconds(),
		ReceivedAt:       time.Now(),
		RequestedAt:      requestedAt,
	})
	st, ok := mgr.LeaseStatus("ws-anchor")
	if !ok || st.Revoked {
		t.Fatalf("renewal must leave the stream live: %+v", st)
	}
	assertNear(t, "expiresAt", st.ExpiresAt, requestedAt.Add(time.Minute), requestedAt.Add(time.Minute))
	assertNear(t, "hardDeadline", st.HardDeadline, requestedAt.Add(30*time.Minute), requestedAt.Add(30*time.Minute))
}

// An older API sends only absolute deadlines and no echo. Within the ceilings
// (MaxRevocationLeaseTTL, MaxSessionDurationCap) the apply path honours them
// unchanged; the slow-clock cap is pinned by the test below.
func TestRevocationLeaseRenewalFromAnOlderAPIUsesTheAbsoluteDeadlines(t *testing.T) {
	h, mgr := startSkewTestStream(t, "ws-old")
	expiresAt := time.Now().Add(2 * time.Minute).Truncate(time.Millisecond)
	hardDeadline := time.Now().Add(40 * time.Minute).Truncate(time.Millisecond)
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:          "ws-old",
		ExpiresAtUnixMs:    expiresAt.UnixMilli(),
		HardDeadlineUnixMs: hardDeadline.UnixMilli(),
		ReceivedAt:         time.Now(),
	})
	st, _ := mgr.LeaseStatus("ws-old")
	if !st.ExpiresAt.Equal(expiresAt) {
		t.Fatalf("expiresAt = %v, want %v", st.ExpiresAt, expiresAt)
	}
	if !st.HardDeadline.Equal(hardDeadline) {
		t.Fatalf("hardDeadline = %v, want %v", st.HardDeadline, hardDeadline)
	}
}

// An older API's answer on a device whose clock is 10 min slow reads as an
// 11 min lease. The fallback is capped at receipt + MaxRevocationLeaseTTL, so
// the slow clock cannot stretch the lease. (The fast-clock side, where the
// absolute deadline must be kept as it is, is pinned in the desktop package:
// TestAbsoluteFallbackIsNeverExtendedOnAFastDevice.)
func TestRevocationLeaseRenewalFromAnOlderAPIIsCappedOnASlowDevice(t *testing.T) {
	h, mgr := startSkewTestStream(t, "ws-old-slow")
	const skew = -10 * time.Minute
	receivedAt := time.Now()
	serverNow := receivedAt.Add(-skew)
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:          "ws-old-slow",
		ExpiresAtUnixMs:    serverNow.Add(time.Minute).UnixMilli(),
		HardDeadlineUnixMs: serverNow.Add(desktop.MaxSessionDurationCap).UnixMilli(),
		ReceivedAt:         receivedAt,
	})
	st, ok := mgr.LeaseStatus("ws-old-slow")
	if !ok || st.Revoked {
		t.Fatalf("renewal must leave the stream live: %+v", st)
	}
	capAt := receivedAt.Add(desktop.MaxRevocationLeaseTTL)
	assertNear(t, "expiresAt", st.ExpiresAt, capAt, capAt)
	// The stream's hard deadline only ever moves earlier, so it cannot show
	// the hard-deadline cap; the forwarding test below does.
}

// The same older-API answer forwarded to a helper: the forwarded deadlines
// are the resolved ones, so both carry the cap. Nothing downstream clamps
// them again (the helper reads them with MonotonicDeadline), which makes this
// the place the 12 h hard-deadline cap is observable end to end.
func TestOlderAPIAnswerForwardedToTheHelperIsCappedOnASlowDevice(t *testing.T) {
	session, received := newLeaseBridgeHelper(t, "helper-old-slow")
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
		desktopMgr:    desktop.NewSessionManager(),
	}
	h.rememberDesktopOwner("desk-old-slow", session.SessionID)

	const skew = -10 * time.Minute
	receivedAt := time.Now()
	serverNow := receivedAt.Add(-skew)
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:          "desk-old-slow",
		ExpiresAtUnixMs:    serverNow.Add(time.Minute).UnixMilli(),
		HardDeadlineUnixMs: serverNow.Add(desktop.MaxSessionDurationCap).UnixMilli(),
		ReceivedAt:         receivedAt,
	})

	env := awaitEnvelope(t, received, ipc.TypeDesktopLeaseUpdate)
	var update ipc.DesktopLeaseUpdate
	if err := json.Unmarshal(env.Payload, &update); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if want := receivedAt.Add(desktop.MaxRevocationLeaseTTL).UnixMilli(); update.ExpiresAtUnixMs != want {
		t.Fatalf("forwarded expiresAtUnixMs = +%v, want capped at +%v",
			time.Duration(update.ExpiresAtUnixMs-receivedAt.UnixMilli())*time.Millisecond, desktop.MaxRevocationLeaseTTL)
	}
	if want := receivedAt.Add(desktop.MaxSessionDurationCap).UnixMilli(); update.HardDeadlineUnixMs != want {
		t.Fatalf("forwarded hardDeadlineUnixMs = +%v, want capped at +%v",
			time.Duration(update.HardDeadlineUnixMs-receivedAt.UnixMilli())*time.Millisecond, desktop.MaxSessionDurationCap)
	}
}

// A renewal answer applied to a live stream must be measured from receipt.
func TestRevocationLeaseRenewalIgnoresDeviceClockSkew(t *testing.T) {
	for _, skew := range leaseSkews {
		t.Run(skew.String(), func(t *testing.T) {
			mgr := newTestStreamManager()
			h := &Heartbeat{desktopMgr: desktop.NewSessionManager(), wsDesktopMgr: mgr}
			send := func(string, []byte) error { return nil }
			_, _, s, err := mgr.StartSession("ws-skew", 0, desktop.DefaultStreamConfig(), testStreamLease(time.Second), send)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(s.Stop)

			serverNow := time.Now().Add(-skew)
			receivedAt := time.Now()
			h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
				SessionID:          "ws-skew",
				ExpiresAtUnixMs:    serverNow.Add(time.Minute).UnixMilli(),
				ExpiresInMs:        time.Minute.Milliseconds(),
				HardDeadlineUnixMs: serverNow.Add(30 * time.Minute).UnixMilli(),
				HardDeadlineInMs:   (30 * time.Minute).Milliseconds(),
				ReceivedAt:         receivedAt,
			})
			st, ok := mgr.LeaseStatus("ws-skew")
			if !ok || st.Revoked {
				t.Fatalf("renewal must leave the stream live: %+v", st)
			}
			assertNear(t, "expiresAt", st.ExpiresAt, receivedAt.Add(time.Minute), receivedAt.Add(time.Minute))
			assertNear(t, "hardDeadline", st.HardDeadline, receivedAt.Add(30*time.Minute), receivedAt.Add(30*time.Minute))
		})
	}
}

// A helper resolves the deadlines it is forwarded against the SAME machine
// clock as the agent, so the agent forwards them already resolved to this
// device's wall clock. That keeps an older helper correct too: it reads the
// absolute fields it always has.
//
// The answer echoes the request's anchor (RequestedAt set), as a current API's
// does, so this covers the anchor the helper path actually uses: the
// forwarded deadlines are measured from the request, on the device's current
// wall clock, and never end later than the server granted. That RequestedAt
// itself carries the current wall clock after a clock step since the agent
// started is pinned in the websocket package
// (TestRenewedLeaseForwardedToTheHelperIsOnTheCurrentWallClock), the only
// place such a stale reading could come from.
func TestLeaseAnswerForwardedToTheHelperIsResolvedToTheDeviceClock(t *testing.T) {
	session, received := newLeaseBridgeHelper(t, "helper-skew")
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
		desktopMgr:    desktop.NewSessionManager(),
	}
	h.rememberDesktopOwner("desk-skew", session.SessionID)

	const skew = 10 * time.Minute
	const roundTrip = 40 * time.Second
	serverNow := time.Now().Add(-skew)
	receivedAt := time.Now()
	requestedAt := receivedAt.Add(-roundTrip)
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:          "desk-skew",
		ExpiresAtUnixMs:    serverNow.Add(time.Minute).UnixMilli(),
		ExpiresInMs:        time.Minute.Milliseconds(),
		HardDeadlineUnixMs: serverNow.Add(time.Hour).UnixMilli(),
		HardDeadlineInMs:   time.Hour.Milliseconds(),
		ReceivedAt:         receivedAt,
		RequestedAt:        requestedAt,
	})

	env := awaitEnvelope(t, received, ipc.TypeDesktopLeaseUpdate)
	var update ipc.DesktopLeaseUpdate
	if err := json.Unmarshal(env.Payload, &update); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	for _, f := range []struct {
		name string
		got  int64
		in   time.Duration
	}{
		{"expiresAtUnixMs", update.ExpiresAtUnixMs, time.Minute},
		{"hardDeadlineUnixMs", update.HardDeadlineUnixMs, time.Hour},
	} {
		if want := requestedAt.Add(f.in).UnixMilli(); f.got != want {
			t.Fatalf("forwarded %s = %d, want %d: measured from the request (off by %v)",
				f.name, f.got, want, time.Duration(f.got-want)*time.Millisecond)
		}
		// On the current wall clock: never later than receipt + granted
		// remaining, and no earlier than that minus the round trip. Both
		// bounds come from the receipt reading taken before the answer was
		// applied, not from a clock read after awaitEnvelope, so a slow IPC
		// delivery on a loaded race run cannot move them.
		hi := receivedAt.Add(f.in).UnixMilli()
		if lo := hi - roundTrip.Milliseconds(); f.got > hi || f.got < lo {
			t.Fatalf("forwarded %s = %d is not within [%d, %d]: the round trip before receipt+%v",
				f.name, f.got, lo, hi, f.in)
		}
	}
}
