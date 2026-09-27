package heartbeat

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

// The Assist manager owns the host's machine-wide Assist install only when
// this process is the installed agent. Every other run mode (foreground run,
// a second build with its own config, Quick Support) gets a manager that
// leaves Assist alone.
func TestHelperManagerOwnershipFollowsInstalledAgent(t *testing.T) {
	cases := []struct {
		name             string
		isService        bool
		isInstalledAgent bool
		supportMode      bool
		want             bool
	}{
		{name: "installed agent", isService: true, isInstalledAgent: true, want: true},
		{name: "service process on a non-canonical config", isService: true, isInstalledAgent: false, want: false},
		{name: "foreground run", want: false},
		{name: "quick support client", supportMode: true, want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := config.Default()
			cfg.AuditEnabled = false
			cfg.IsService = tc.isService
			cfg.IsInstalledAgent = tc.isInstalledAgent
			cfg.SupportMode = tc.supportMode
			h := New(cfg)
			defer h.Stop()

			if h.helperMgr == nil {
				t.Fatal("helper manager not constructed")
			}
			if got := h.helperMgr.ManagesMachineInstall(); got != tc.want {
				t.Fatalf("ManagesMachineInstall() = %v, want %v", got, tc.want)
			}
		})
	}
}
