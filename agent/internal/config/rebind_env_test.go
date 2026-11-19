package config

import (
	"bytes"
	"strings"
	"testing"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/spf13/viper"
)

// #8318 review fix 10: after a reattach swap, BREEZE_AGENT_ID /
// BREEZE_DEVICE_ID / BREEZE_ORG_ID / BREEZE_SITE_ID that differ from
// agent.yaml do not win (they pinned the install as it was before): the
// persisted identity is kept, with a warning. Without a reattach the
// environment still overrides as before; a new enrollment clears the record.
func TestReattachedIdentityWinsOverTheEnvironment(t *testing.T) {
	cases := []struct {
		env   string
		value string
		field func(*Config) string
		want  string
	}{
		{env: "BREEZE_AGENT_ID", value: "ab3c20eddb470acffd33bbe00f25e0348e89298ab80cece542bb1fbf921e5776", field: func(c *Config) string { return c.AgentID }, want: rebindTestStagedAgentID},
		{env: "BREEZE_DEVICE_ID", value: "00000000-0000-4000-8000-0000000000f1", field: func(c *Config) string { return c.DeviceID }, want: rebindTestDevice},
		{env: "BREEZE_ORG_ID", value: "00000000-0000-4000-8000-0000000000f2", field: func(c *Config) string { return c.OrgID }, want: rebindTestOrg},
		{env: "BREEZE_SITE_ID", value: "00000000-0000-4000-8000-0000000000f3", field: func(c *Config) string { return c.SiteID }, want: rebindTestSite},
	}
	for _, tc := range cases {
		t.Run(tc.env, func(t *testing.T) {
			var logs bytes.Buffer
			logging.Init("text", "debug", &logs)
			t.Cleanup(func() { logging.Init("text", "info", nil) })
			reattachPinWarned.Store(nil)

			cfgPath := bindConfig(t)
			if err := ApplyRebindIdentity(cfgPath, rebindTestIdentity(true)); err != nil {
				t.Fatal(err)
			}
			t.Setenv(tc.env, tc.value)
			viper.Reset()
			cfg, err := Load(cfgPath)
			if err != nil {
				t.Fatal(err)
			}
			if got := tc.field(cfg); got != tc.want {
				t.Fatalf("%s won over the reattached identity: %s", tc.env, got)
			}
			if !strings.Contains(logs.String(), tc.env) {
				t.Fatalf("no warning names %s", tc.env)
			}

			// A new enrollment is no reattach: the environment wins again.
			if err := SaveEnrollment(cfg, cfgPath); err != nil {
				t.Fatal(err)
			}
			viper.Reset()
			cfg, err = Load(cfgPath)
			if err != nil {
				t.Fatal(err)
			}
			if got := tc.field(cfg); got != tc.value {
				t.Fatalf("after re-enrollment %s = %s, want the environment's %s", tc.env, got, tc.value)
			}
		})
	}
}

// Without a reattach the environment overrides agent.yaml as it always did.
func TestEnvironmentStillOverridesWithoutAReattach(t *testing.T) {
	cfgPath := bindConfig(t)
	t.Setenv("BREEZE_ORG_ID", "00000000-0000-4000-8000-0000000000f2")
	viper.Reset()
	cfg, err := Load(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.OrgID != "00000000-0000-4000-8000-0000000000f2" {
		t.Fatalf("org = %s, want the environment's", cfg.OrgID)
	}
}
