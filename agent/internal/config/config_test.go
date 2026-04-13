package config

import "testing"

func TestIsEnrolled(t *testing.T) {
	tests := []struct {
		name string
		cfg  *Config
		want bool
	}{
		{"nil config", nil, false},
		{"empty config", &Config{}, false},
		{"agent id only (torn write)", &Config{AgentID: "abc"}, false},
		{"auth token only (torn write)", &Config{AuthToken: "tok"}, false},
		{"both present", &Config{AgentID: "abc", AuthToken: "tok"}, true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := IsEnrolled(tt.cfg); got != tt.want {
				t.Errorf("IsEnrolled(%+v) = %v, want %v", tt.cfg, got, tt.want)
			}
		})
	}
}
