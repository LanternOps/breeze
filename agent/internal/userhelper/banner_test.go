package userhelper

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestBannerSessionTracking(t *testing.T) {
	shown := []string{}
	hidden := 0
	origShow, origHide := showBannerFn, hideBannerFn
	defer func() {
		showBannerFn, hideBannerFn = origShow, origHide
		bannerOpMu.Lock()
		bannerSessionID = ""
		bannerOpMu.Unlock()
	}()
	showBannerFn = func(label string) bool { shown = append(shown, label); return true }
	hideBannerFn = func() { hidden++ }

	handleBannerShow(ipc.BannerShowRequest{SessionID: "s1", Label: "Billy from Olive Technology is connected"})
	handleBannerShow(ipc.BannerShowRequest{SessionID: "s2", Label: "Sue from Olive Technology is connected"})

	handleBannerHide("s1") // stale — s2 owns the banner now
	if hidden != 0 {
		t.Fatalf("stale hide must be ignored, hides=%d", hidden)
	}
	handleBannerHide("s2")
	if hidden != 1 {
		t.Fatalf("owner hide must hide, hides=%d", hidden)
	}
	if len(shown) != 2 || shown[1] != "Sue from Olive Technology is connected" {
		t.Fatalf("labels: %v", shown)
	}
	// hide with empty session id always hides (defensive daemon-side payloads)
	handleBannerShow(ipc.BannerShowRequest{SessionID: "s3", Label: "x"})
	handleBannerHide("")
	if hidden != 2 {
		t.Fatalf("empty-session hide must hide, hides=%d", hidden)
	}
}

// TestBannerConcurrentShowsSerialized guards against the concurrency bug where
// banner_show IPC messages are each dispatched in their own goroutine
// (client.go's commandLoop via safeGo) with no serialization between them.
// Before bannerOpMu, two concurrent handleBannerShow calls could both observe
// "no window yet" and both take the create-new-window path — on Windows that
// means two native windows, with only the last HWND ever recorded, so the
// other leaks as an unclosable topmost window. This test fakes showBannerFn
// to simulate the "not yet created" window-creation critical section (sleep
// while inside) and asserts the fake is never entered concurrently.
func TestBannerConcurrentShowsSerialized(t *testing.T) {
	origShow, origHide := showBannerFn, hideBannerFn
	defer func() {
		showBannerFn, hideBannerFn = origShow, origHide
		bannerOpMu.Lock()
		bannerSessionID = ""
		bannerOpMu.Unlock()
	}()
	hideBannerFn = func() {}

	var (
		fakeMu      sync.Mutex
		inFlight    int
		maxObserved int
		calls       int
	)
	showBannerFn = func(label string) bool {
		fakeMu.Lock()
		inFlight++
		if inFlight > maxObserved {
			maxObserved = inFlight
		}
		calls++
		fakeMu.Unlock()

		// Simulate the window-creation critical section (showBannerOS
		// blocking on <-ready for the native window to be created) —
		// long enough that, absent bannerOpMu, a second concurrent
		// handleBannerShow would reliably enter this fake while the
		// first is still "in flight".
		time.Sleep(5 * time.Millisecond)

		fakeMu.Lock()
		inFlight--
		fakeMu.Unlock()
		return true
	}

	const n = 20
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func(i int) {
			defer wg.Done()
			handleBannerShow(ipc.BannerShowRequest{
				SessionID: fmt.Sprintf("session-%d", i),
				Label:     fmt.Sprintf("tech %d connected", i),
			})
		}(i)
	}
	wg.Wait()

	if calls != n {
		t.Fatalf("expected %d showBannerFn calls, got %d", n, calls)
	}
	if maxObserved > 1 {
		t.Fatalf("bannerOpMu failed to serialize handleBannerShow: observed %d concurrent showBannerFn calls, want at most 1", maxObserved)
	}
}
