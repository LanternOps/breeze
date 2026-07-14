//go:build windows

package sessionbroker

import (
	"context"
	"time"
)

const (
	initialDelay      = 3 * time.Second
	reconcileInterval = 30 * time.Second

	wtsSessionDisconnect = 0x4
	wtsSessionLogon      = 0x5
	wtsSessionLogoff     = 0x6
	wtsSessionLock       = 0x7
	wtsSessionUnlock     = 0x8
	wtsSessionCreate     = 0xa
	wtsSessionTerminate  = 0xb
)

type directHelperSpawner struct{}

func (directHelperSpawner) Spawn(key HelperKey) (helperProcess, error) {
	if key.Role == "user" {
		return SpawnUserHelperInSession(key.WindowsSessionID)
	}
	return SpawnHelperInSession(key.WindowsSessionID)
}

func (directHelperSpawner) Close() error { return nil }

func NewHelperLifecycleManager(broker *Broker, scmCh <-chan SCMSessionEvent) *HelperLifecycleManager {
	return newHelperLifecycleManager(broker, NewSessionDetector(), scmCh, directHelperSpawner{})
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
	systemKey := HelperKey{WindowsSessionID: event.SessionID, Role: "system"}
	userKey := HelperKey{WindowsSessionID: event.SessionID, Role: "user"}
	switch event.EventType {
	case wtsSessionLogon, wtsSessionUnlock, wtsSessionCreate:
		m.registry.clearFatal(event.SessionID)
		m.reconcile()
	case wtsSessionDisconnect:
		m.removeDesired(userKey)
		m.stopKey(userKey)
		m.reconcile()
	case wtsSessionLogoff, wtsSessionTerminate:
		m.removeDesired(systemKey, userKey)
		m.stopKey(userKey)
		m.stopKey(systemKey)
	}
}
