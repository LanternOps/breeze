package watchdog

import (
	"crypto/tls"
	"testing"
)

func TestFailoverTransport_UsesECHDialer(t *testing.T) {
	tr := newFailoverTransport(&tls.Config{MinVersion: tls.VersionTLS12})
	if tr.DialTLSContext == nil {
		t.Fatal("DialTLSContext must be the ECH dialer")
	}
	if tr.ForceAttemptHTTP2 {
		t.Fatal("failover must stay HTTP/1.1")
	}
	if tr.DialContext == nil {
		t.Fatal("DialContext must be set (netcache)")
	}
	if tr.Proxy == nil {
		t.Fatal("Proxy must be set (DefaultTransport clone)")
	}
}
