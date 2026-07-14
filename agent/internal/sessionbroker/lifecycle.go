//go:build windows

package sessionbroker

import (
	"context"
	"fmt"
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
