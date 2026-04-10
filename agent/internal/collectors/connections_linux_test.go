//go:build linux

package collectors

import (
	"testing"
)

func TestGetProtocolString(t *testing.T) {
	c := &ConnectionsCollector{}
	tests := []struct {
		connType uint32
		family   uint32
		want     string
	}{
		{connType: 1, family: 2, want: "tcp"},
		{connType: 1, family: 10, want: "tcp6"},
		{connType: 2, family: 2, want: "udp"},
		{connType: 2, family: 10, want: "udp6"},
		{connType: 3, family: 1, want: "unknown"},
		{connType: 5, family: 1, want: "unknown"},
	}

	for _, tt := range tests {
		got := c.getProtocolString(tt.connType, tt.family)
		if got != tt.want {
			t.Errorf("getProtocolString(%d, %d) = %q, want %q", tt.connType, tt.family, got, tt.want)
		}
	}
}
