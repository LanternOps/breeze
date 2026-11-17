package heartbeat

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/remote/desktop"
	"github.com/breeze-rmm/agent/internal/websocket"
)

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
func TestLeaseAnswerForwardedToTheHelperIsResolvedToTheDeviceClock(t *testing.T) {
	session, received := newLeaseBridgeHelper(t, "helper-skew")
	h := &Heartbeat{
		sessionBroker: newTestBrokerWithSessions(t, session),
		isHeadless:    true,
		desktopMgr:    desktop.NewSessionManager(),
	}
	h.rememberDesktopOwner("desk-skew", session.SessionID)

	const skew = 10 * time.Minute
	serverNow := time.Now().Add(-skew)
	receivedAt := time.Now()
	h.applyRevocationLeaseAnswer(websocket.RevocationLeaseMessage{
		SessionID:          "desk-skew",
		ExpiresAtUnixMs:    serverNow.Add(time.Minute).UnixMilli(),
		ExpiresInMs:        time.Minute.Milliseconds(),
		HardDeadlineUnixMs: serverNow.Add(time.Hour).UnixMilli(),
		HardDeadlineInMs:   time.Hour.Milliseconds(),
		ReceivedAt:         receivedAt,
	})

	env := awaitEnvelope(t, received, ipc.TypeDesktopLeaseUpdate)
	var update ipc.DesktopLeaseUpdate
	if err := json.Unmarshal(env.Payload, &update); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if want := receivedAt.Add(time.Minute).UnixMilli(); update.ExpiresAtUnixMs != want {
		t.Fatalf("forwarded expiresAtUnixMs = %d, want %d (off by %v)",
			update.ExpiresAtUnixMs, want, time.Duration(update.ExpiresAtUnixMs-want)*time.Millisecond)
	}
	if want := receivedAt.Add(time.Hour).UnixMilli(); update.HardDeadlineUnixMs != want {
		t.Fatalf("forwarded hardDeadlineUnixMs = %d, want %d", update.HardDeadlineUnixMs, want)
	}
}
