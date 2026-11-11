package main

import (
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/ech"
	"github.com/breeze-rmm/agent/internal/secmem"
	"github.com/breeze-rmm/agent/internal/watchdog"
)

// #8318: a reinstall reattach swaps the install to an existing device — a new
// agent id with new agent, watchdog and helper tokens — and restarts only the
// agent service. A failover window opened afterwards must beat as that device:
// the watchdog adopts the on-disk agent id and watchdog token together.
func TestWatchdogFailoverFollowsAReattachedIdentity(t *testing.T) {
	const (
		sourceAgent = "source-agent"
		targetAgent = "target-agent"
	)
	cases := []struct {
		name        string
		onDisk      *config.Config
		withTokens  bool
		wantAgent   string
		wantToken   string
		wantChanged bool
	}{
		{name: "identity changed on disk",
			onDisk:     &config.Config{AgentID: targetAgent, DeviceID: "target-device", WatchdogAuthToken: "brz_target_watchdog", ServerURL: "https://api.example"},
			withTokens: true, wantAgent: targetAgent, wantToken: "brz_target_watchdog", wantChanged: true},
		{name: "same identity: an IPC-delivered token is kept",
			onDisk:     &config.Config{AgentID: sourceAgent, WatchdogAuthToken: "brz_disk_watchdog", ServerURL: "https://api.example"},
			withTokens: true, wantAgent: sourceAgent, wantToken: "brz_source_watchdog"},
		{name: "a new agent id without a watchdog token is not adopted",
			onDisk:     &config.Config{AgentID: targetAgent, ServerURL: "https://api.example"},
			withTokens: true, wantAgent: sourceAgent, wantToken: "brz_source_watchdog"},
		{name: "URL-only callers never touch the identity",
			onDisk:     &config.Config{AgentID: targetAgent, WatchdogAuthToken: "brz_target_watchdog", ServerURL: "https://api.example"},
			withTokens: false, wantAgent: sourceAgent, wantToken: "brz_source_watchdog"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Cleanup(ech.SetSharedForTest(ech.New(ech.Options{LocalEnabled: true, ServerEnabled: true})))
			origReload := failoverReloadConfigFn
			t.Cleanup(func() { failoverReloadConfigFn = origReload })
			failoverReloadConfigFn = func() (*config.Config, error) {
				c := *tc.onDisk
				c.ECH, c.ECHServerEnabled = true, true
				return &c, nil
			}
			journal, err := watchdog.NewJournal(t.TempDir(), 1, 1)
			if err != nil {
				t.Fatalf("new journal: %v", err)
			}
			t.Cleanup(func() { _ = journal.Close() })

			cfg := &config.Config{AgentID: sourceAgent, ServerURL: "https://boot.example"}
			tokens := &tokenHolder{token: secmem.NewSecureString("brz_source_watchdog")}
			var holder *tokenHolder
			if tc.withTokens {
				holder = tokens
			}
			url, changed := resolveFailoverTarget(cfg, holder, journal)
			if url != "https://api.example" {
				t.Fatalf("failover URL = %q, want the reloaded server_url", url)
			}
			if changed != tc.wantChanged || cfg.AgentID != tc.wantAgent || tokens.Reveal() != tc.wantToken {
				t.Fatalf("changed=%v agent=%s token ok=%v; want changed=%v agent=%s",
					changed, cfg.AgentID, tokens.Reveal() == tc.wantToken, tc.wantChanged, tc.wantAgent)
			}
		})
	}
}
