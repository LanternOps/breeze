package desktop

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestWsSessionManagerStopSessionReportsWhetherItRemovedActiveState(t *testing.T) {
	manager := NewWsSessionManager()
	manager.sessions["active"] = &WsStreamSession{isActive: false}

	if removed := manager.StopSession("active"); !removed {
		t.Fatal("first stop must report that an active map entry was removed")
	}
	if removed := manager.StopSession("active"); removed {
		t.Fatal("repeated stop must report already absent")
	}
}

func TestWsSessionManagerConcurrentStopsReportOneRemoval(t *testing.T) {
	manager := NewWsSessionManager()
	manager.sessions["active"] = &WsStreamSession{isActive: false}

	var removed atomic.Int32
	var wg sync.WaitGroup
	for range 32 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if manager.StopSession("active") {
				removed.Add(1)
			}
		}()
	}
	wg.Wait()

	if got := removed.Load(); got != 1 {
		t.Fatalf("removed count=%d, want exactly 1", got)
	}
}
