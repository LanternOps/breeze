package config

import "testing"

func TestPlaintextRemoteHost(t *testing.T) {
	cases := []struct {
		name      string
		url       string
		wantHost  string
		wantWarns bool
	}{
		{"wss is encrypted", "wss://rmm.example.com/api/v1/agent-ws/a/ws", "", false},
		{"https is encrypted", "https://rmm.example.com", "", false},
		{"ws to public host", "ws://rmm.example.com/api/v1/agent-ws/a/ws", "rmm.example.com", true},
		{"http to public host", "http://rmm.example.com:3001", "rmm.example.com", true},
		{"scheme is case-insensitive", "WS://rmm.example.com/x", "rmm.example.com", true},
		{"ws to private LAN address", "ws://192.168.1.20:3001/x", "192.168.1.20", true},
		{"ws to 10/8 address", "ws://10.0.0.5/x", "10.0.0.5", true},
		{"ws to mDNS name", "ws://rmm.local/x", "rmm.local", true},
		{"ws to public IPv6", "ws://[2001:db8::1]:3001/x", "2001:db8::1", true},
		{"ws to unspecified address", "ws://0.0.0.0:3001/x", "0.0.0.0", true},
		{"ws to localhost", "ws://localhost:3001/x", "", false},
		{"ws to LOCALHOST", "ws://LOCALHOST:3001/x", "", false},
		{"ws to localhost with trailing dot", "ws://localhost.:3001/x", "", false},
		{"ws to a .localhost subdomain warns (not resolved, not trusted)", "ws://api.localhost:3001/x", "api.localhost", true},
		{"ws to 127.0.0.1", "ws://127.0.0.1:3001/x", "", false},
		{"ws to other 127/8 address", "ws://127.0.0.2/x", "", false},
		{"ws to IPv6 loopback", "ws://[::1]:3001/x", "", false},
		{"ws to IPv4-mapped loopback", "ws://[::ffff:127.0.0.1]/x", "", false},
		{"localhost lookalike still warns", "ws://localhost.example.com/x", "localhost.example.com", true},
		{"unparseable URL", "ws://%zz/x", "", false},
		{"no host", "ws:///x", "", false},
		{"empty", "", "", false},
		{"other scheme", "ftp://rmm.example.com", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			host, warns := PlaintextRemoteHost(tc.url)
			if warns != tc.wantWarns || host != tc.wantHost {
				t.Fatalf("PlaintextRemoteHost(%q) = (%q, %v), want (%q, %v)", tc.url, host, warns, tc.wantHost, tc.wantWarns)
			}
		})
	}
}

func TestIsLoopbackHost(t *testing.T) {
	for _, h := range []string{"localhost", "Localhost", "localhost.", "127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1"} {
		if !IsLoopbackHost(h) {
			t.Errorf("IsLoopbackHost(%q) = false, want true", h)
		}
	}
	for _, h := range []string{"", "0.0.0.0", "::", "192.168.1.1", "10.0.0.1", "example.com", "localhost.example.com", "notlocalhost", "rmm.local", "a.localhost"} {
		if IsLoopbackHost(h) {
			t.Errorf("IsLoopbackHost(%q) = true, want false", h)
		}
	}
}
