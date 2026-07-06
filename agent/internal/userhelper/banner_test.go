package userhelper

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestBannerSessionTracking(t *testing.T) {
	shown := []string{}
	hidden := 0
	origShow, origHide := showBannerFn, hideBannerFn
	defer func() { showBannerFn, hideBannerFn = origShow, origHide }()
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
