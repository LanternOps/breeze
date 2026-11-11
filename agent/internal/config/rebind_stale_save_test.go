package config

import (
	"strings"
	"testing"

	"github.com/spf13/viper"
)

// #8318 review fix 12: while agent.yaml records a reattach, a save from a
// *Config loaded before the swap (SaveTo's from-disk rule) keeps the agent and
// device id on disk; without a reattach SaveTo writes the caller's, as before.
func TestStaleSaveKeepsTheReattachedIDs(t *testing.T) {
	for _, tc := range []struct {
		name       string
		reattached bool
	}{
		{name: "after a reattach", reattached: true},
		{name: "no reattach", reattached: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cfgPath := bindConfig(t)
			stale, err := Load(cfgPath)
			if err != nil {
				t.Fatal(err)
			}
			if tc.reattached {
				if err := ApplyRebindIdentity(cfgPath, rebindTestIdentity(true)); err != nil {
					t.Fatal(err)
				}
			} else {
				stale.AgentID = strings.Repeat("f", 64)
				stale.DeviceID = "00000000-0000-4000-8000-0000000000ff"
			}
			stale.MtlsCertPEM = "RENEWED-BY-A-STALE-PROCESS"
			if err := SaveTo(stale, cfgPath); err != nil {
				t.Fatalf("SaveTo: %v", err)
			}
			viper.Reset()
			got, err := Load(cfgPath)
			if err != nil {
				t.Fatal(err)
			}
			wantAgent, wantDevice := stale.AgentID, stale.DeviceID
			if tc.reattached {
				wantAgent, wantDevice = rebindTestStagedAgentID, rebindTestDevice
			}
			if got.AgentID != wantAgent || got.DeviceID != wantDevice {
				t.Fatalf("ids after a stale save = %s/%s, want %s/%s", got.AgentID, got.DeviceID, wantAgent, wantDevice)
			}
		})
	}
}
