package main

import (
	"reflect"
	"testing"

	"github.com/breeze-rmm/agent/internal/config"
)

func TestMissingShipperKeys(t *testing.T) {
	cases := []struct {
		name string
		cfg  config.Config
		want []string
	}{
		{
			name: "all present",
			cfg:  config.Config{AgentID: "a", ServerURL: "https://x", HelperAuthToken: "t"},
			want: nil,
		},
		{
			name: "token missing (user-session helper before helper_auth_token landed)",
			cfg:  config.Config{AgentID: "a", ServerURL: "https://x"},
			want: []string{"helper_auth_token"},
		},
		{
			name: "everything missing (config load failed, defaults in use)",
			cfg:  *config.Default(),
			want: []string{"agent_id", "server_url", "helper_auth_token"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := tc.cfg
			got := missingShipperKeys(&cfg)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("missingShipperKeys = %v, want %v", got, tc.want)
			}
			for _, k := range got {
				if k == cfg.HelperAuthToken || k == cfg.AgentID {
					t.Fatalf("missing list must carry key names, not values: %v", got)
				}
			}
		})
	}
}
