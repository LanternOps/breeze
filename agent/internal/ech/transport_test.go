package ech

import (
	"crypto/tls"
	"testing"
	"time"
)

func TestNewTransport_WiresDialTLSAndNetcache(t *testing.T) {
	base := &tls.Config{MinVersion: tls.VersionTLS12}
	tr := NewTransport(base)
	if tr.DialTLSContext == nil {
		t.Fatal("DialTLSContext not set")
	}
	if tr.DialContext == nil {
		t.Fatal("DialContext not set")
	}
	if tr.TLSClientConfig != base {
		t.Fatal("TLSClientConfig must be the base config")
	}
	if !tr.ForceAttemptHTTP2 {
		t.Fatal("ForceAttemptHTTP2 must be true")
	}
	if tr.Proxy == nil {
		t.Fatal("Proxy (from DefaultTransport clone) must be kept")
	}
	c := NewClient(base, 7*time.Second, nil)
	if c.Timeout != 7*time.Second || c.Transport == nil {
		t.Fatalf("NewClient timeout/transport wrong: %v %v", c.Timeout, c.Transport)
	}
}

func TestConfigure_SetsSharedFlags(t *testing.T) {
	t.Cleanup(func() { Configure(true, true) })
	for _, c := range []struct{ local, server, want bool }{
		{false, true, false}, {true, false, false}, {true, true, true},
	} {
		Configure(c.local, c.server)
		if got := Shared().enabled(); got != c.want {
			t.Fatalf("Configure(%v,%v): enabled()=%v want %v", c.local, c.server, got, c.want)
		}
	}
}
