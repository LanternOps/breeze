package sessionbroker

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func waitTestManager(t *testing.T, sessions []DetectedSession) *HelperLifecycleManager {
	t.Helper()
	broker := New("wait-"+t.Name(), nil)
	m := newHelperLifecycleManager(broker, &stubLeaseDetector{sessions: sessions}, nil, &fakeHelperSpawner{})
	m.mode = LifecycleModeOnDemand
	return m
}

func TestWaitForHelperReady(t *testing.T) {
	base := time.Date(2026, 7, 28, 12, 0, 0, 0, time.UTC)
	sysKey := HelperKey{WindowsSessionID: 3, Role: ipc.HelperRoleSystem}

	t.Run("ready when broker session has capabilities", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		sess := &Session{WinSessionID: "3", HelperRole: ipc.HelperRoleSystem, Capabilities: &ipc.Capabilities{CanCapture: true}}
		m.broker.mu.Lock()
		m.broker.helperByKey[sysKey] = sess
		m.broker.mu.Unlock()

		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitReady || res.Session != sess {
			t.Fatalf("got %+v, want ready with session", res)
		}
	})

	t.Run("session gone when lease missing", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitSessionGone {
			t.Fatalf("got %+v, want session-gone", res)
		}
	})

	t.Run("fatal cooldown is surfaced with retry-after", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		m.registry.mu.Lock()
		m.registry.current[sysKey] = &trackedHelper{key: sysKey, state: helperExited, fatalExitUntil: base.Add(7 * time.Minute)}
		m.registry.mu.Unlock()
		m.now = func() time.Time { return base }

		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitFatalCooldown {
			t.Fatalf("got %+v, want fatal-cooldown", res)
		}
		if res.RetryAfter != 7*time.Minute {
			t.Fatalf("RetryAfter = %v, want 7m", res.RetryAfter)
		}
	})

	t.Run("retries exhausted is surfaced", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		m.registry.mu.Lock()
		m.registry.current[sysKey] = &trackedHelper{key: sysKey, state: helperExited, retryCount: maxSpawnRetries}
		m.registry.mu.Unlock()

		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitRetriesExhausted {
			t.Fatalf("got %+v, want retries-exhausted", res)
		}
	})

	t.Run("nil spawner surfaces spawner-unavailable instead of an opaque timeout", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		m.spawner = nil

		res := m.WaitForHelperReady(context.Background(), sysKey)
		if res.Status != HelperWaitSpawnerUnavailable {
			t.Fatalf("got %+v, want spawner-unavailable", res)
		}
	})

	t.Run("context cancel yields timeout", func(t *testing.T) {
		m := waitTestManager(t, []DetectedSession{activeRDP("3", "bob")})
		if err := m.AcquireLease(3, ipc.HelperRoleSystem, "op1", 0); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		res := m.WaitForHelperReady(ctx, sysKey)
		if res.Status != HelperWaitTimeout {
			t.Fatalf("got %+v, want timeout", res)
		}
	})
}
