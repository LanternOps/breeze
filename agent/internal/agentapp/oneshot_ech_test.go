package agentapp

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ech"
)

func TestOneShotCommandsEnableECHRetry(t *testing.T) {
	t.Cleanup(func() {
		ech.Configure(true, true)
		ech.Shared().SetOneShot(false)
	})

	enableOneShotECH(nil)
	if !ech.SharedOneShotForTest() {
		t.Fatal("one-shot mode not enabled")
	}

	enableOneShotECH(&config.Config{ECH: false, ECHServerEnabled: true})
	if ech.SharedEnabledForTest() {
		t.Fatal("ech:false in config must disable ECH")
	}
	if !ech.SharedOneShotForTest() {
		t.Fatal("one-shot mode lost after Configure")
	}
}
