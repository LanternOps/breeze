package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/ipc"
)

func TestShouldPushHelperToken(t *testing.T) {
	if !shouldPushHelperToken([]string{"assist"}) {
		t.Fatal("assist scope should receive helper token")
	}
	if shouldPushHelperToken([]string{"watchdog"}) {
		t.Fatal("watchdog scope must NOT receive helper token")
	}
	if shouldPushHelperToken([]string{"notify", "clipboard", "run_as_user"}) {
		t.Fatal("user scope must NOT receive helper token")
	}
	if shouldPushHelperToken(nil) {
		t.Fatal("no scopes must NOT receive helper token")
	}
	_ = ipc.TypeHelperTokenUpdate // compile-time guard: ensures TypeHelperTokenUpdate stays defined
}
