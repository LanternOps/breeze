//go:build windows

package sessionbroker

import (
	"context"
	"fmt"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

const (
	initialDelay      = 3 * time.Second
	reconcileInterval = 30 * time.Second

	// WTS_* notification codes from winuser.h, forwarded verbatim by the SCM
	// SessionChange handler (service_windows.go) — it filters nothing, so every
	// code below can arrive.
	//
	// Connect/disconnect come in console and remote PAIRS. Naming matters here:
	// this set was previously a single `wtsSessionDisconnect = 0x4`, whose name
	// implied it covered disconnects generally. It does not — 0x4 is
	// WTS_REMOTE_DISCONNECT only. Console disconnect (0x2) went unhandled, and
	// WTS_REMOTE_CONNECT (0x3) — an RDP user reconnecting to their existing
	// session — had no case at all.
	wtsConsoleConnect    = 0x1
	wtsConsoleDisconnect = 0x2
	wtsRemoteConnect     = 0x3
	wtsRemoteDisconnect  = 0x4
	wtsSessionLogon      = 0x5
	wtsSessionLogoff     = 0x6
	wtsSessionLock       = 0x7
	wtsSessionUnlock     = 0x8
	wtsSessionCreate     = 0xa
	wtsSessionTerminate  = 0xb
)

func NewHelperLifecycleManager(broker *Broker, scmCh <-chan SCMSessionEvent) *HelperLifecycleManager {
	manager, err := buildWindowsHelperLifecycleManager(broker, scmCh, newWindowsHelperSpawner)
	if err != nil {
		// Keep heartbeat startup operational, but disable proactive spawning.
		// Reconciliation will retry on the next agent/service restart, when a
		// fresh Job Object can be created before any helper process exists.
		log.Error("lifecycle: failed to initialize helper Job Object", "error", err.Error())
		return newHelperLifecycleManager(broker, NewSessionDetector(), scmCh, nil)
	}
	return manager
}

func buildWindowsHelperLifecycleManager(
	broker *Broker,
	scmCh <-chan SCMSessionEvent,
	newSpawner func() (*windowsHelperSpawner, error),
) (*HelperLifecycleManager, error) {
	spawner, err := newSpawner()
	if err != nil {
		return nil, fmt.Errorf("initialize Windows helper spawner: %w", err)
	}
	if spawner == nil {
		return nil, fmt.Errorf("initialize Windows helper spawner: nil spawner")
	}
	return newHelperLifecycleManager(broker, NewSessionDetector(), scmCh, spawner), nil
}

func (m *HelperLifecycleManager) Start(ctx context.Context) {
	defer m.finishStart()
	select {
	case <-time.After(initialDelay):
	case <-ctx.Done():
		return
	case <-m.stopCh:
		return
	}
	m.reconcile()
	ticker := time.NewTicker(reconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-m.stopCh:
			return
		case event, ok := <-m.scmCh:
			if !ok && m.scmCh != nil {
				return
			}
			if ok {
				m.handleSCMEvent(event)
			}
		case <-ticker.C:
			m.reconcile()
		}
	}
}

func (m *HelperLifecycleManager) handleSCMEvent(event SCMSessionEvent) {
	if event.SessionID == 0 {
		return
	}
	systemKey := HelperKey{WindowsSessionID: event.SessionID, Role: ipc.HelperRoleSystem}
	userKey := HelperKey{WindowsSessionID: event.SessionID, Role: ipc.HelperRoleUser}
	switch event.EventType {
	// Session became usable. Reconnect (console 0x1 / remote 0x3) belongs here:
	// the session already exists and the user never logged off, so no
	// logon/unlock/create fires and only these codes signal the return.
	case wtsSessionLogon, wtsSessionUnlock, wtsSessionCreate, wtsConsoleConnect, wtsRemoteConnect:
		m.registry.clearFatal(event.SessionID)
		m.reconcile()
	// Session went away but is still logged on. The user helper requires
	// state=="active" so it goes; the SYSTEM helper is retained deliberately
	// (an RDP session keeps running when disconnected).
	case wtsRemoteDisconnect, wtsConsoleDisconnect:
		m.removeDesired(userKey)
		m.stopKey(userKey)
		m.reconcile()
	case wtsSessionLogoff, wtsSessionTerminate:
		m.removeDesired(systemKey, userKey)
		m.stopKey(userKey)
		m.stopKey(systemKey)
	}
}
