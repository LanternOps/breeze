package agentapp

import (
	"errors"
	"testing"
)

func TestHostLooksEnrolled(t *testing.T) {
	cases := []struct {
		name    string
		agentID string
		loadErr error
		want    bool
	}{
		{name: "enrolled host", agentID: "agent-123", want: true},
		{name: "fresh host, no config file", agentID: "", want: false},
		{
			name:    "config present but unreadable is assumed enrolled",
			agentID: "",
			loadErr: errors.New("yaml: line 3: mapping values are not allowed"),
			want:    true,
		},
		{
			name:    "unreadable config wins even with an empty agent id",
			agentID: "",
			loadErr: errors.New("reading secrets file: permission denied"),
			want:    true,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := hostLooksEnrolled(c.agentID, c.loadErr); got != c.want {
				t.Errorf("hostLooksEnrolled(%q, %v) = %v, want %v", c.agentID, c.loadErr, got, c.want)
			}
		})
	}
}
