//go:build darwin

package heartbeat

import (
	"context"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const darwinDesktopHandoffDelay = 750 * time.Millisecond

func (h *Heartbeat) startDarwinDesktopWatcher() {
	if h.sessionBroker == nil {
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-h.stopChan
		cancel()
	}()

	events := sessionbroker.NewSessionDetector().WatchSessions(ctx)
	go func() {
		for event := range events {
			switch event.Type {
			case sessionbroker.SessionLogin, sessionbroker.SessionLogout, sessionbroker.SessionSwitch:
				h.handleDarwinSessionEvent(event)
			}
		}
	}()
}

func (h *Heartbeat) handleHelperSessionClosed(session *sessionbroker.Session) {
	if session == nil || !session.HasScope("desktop") {
		return
	}
	h.reconcileDarwinDesktopOwners("helper_closed")
}

func (h *Heartbeat) handleDarwinSessionEvent(event sessionbroker.SessionEvent) {
	go func() {
		select {
		case <-time.After(darwinDesktopHandoffDelay):
		case <-h.stopChan:
			return
		}

		_ = h.spawnDesktopHelper("")
		h.reconcileDarwinDesktopOwners("session_" + string(event.Type))
	}()
}

func (h *Heartbeat) reconcileDarwinDesktopOwners(reason string) {
	if h.sessionBroker == nil {
		return
	}

	preferred := h.sessionBroker.PreferredDesktopSession()
	h.desktopOwners.Range(func(key, value any) bool {
		desktopSessionID, ok := key.(string)
		if !ok || desktopSessionID == "" {
			return true
		}

		owner := h.desktopOwnerSession(desktopSessionID)
		switch {
		case owner == nil:
			h.forgetDesktopOwner(desktopSessionID)
			go h.sendDesktopDisconnectNotification(desktopSessionID)
		case preferred == nil:
			h.disconnectDarwinDesktopOwner(desktopSessionID, owner, reason)
		case preferred.SessionID != owner.SessionID:
			h.disconnectDarwinDesktopOwner(desktopSessionID, owner, reason)
		}

		return true
	})
}

func (h *Heartbeat) disconnectDarwinDesktopOwner(desktopSessionID string, owner *sessionbroker.Session, reason string) {
	if owner != nil {
		req := ipc.DesktopStopRequest{SessionID: desktopSessionID}
		_, err := owner.SendCommand("desk-handoff-"+desktopSessionID, ipc.TypeDesktopStop, req, 5*time.Second)
		if err != nil {
			log.Debug("desktop handoff stop failed",
				"sessionId", desktopSessionID,
				"helperSession", owner.SessionID,
				"reason", reason,
				"error", err.Error(),
			)
		}
	}

	h.forgetDesktopOwner(desktopSessionID)
	go h.sendDesktopDisconnectNotification(desktopSessionID)
}
