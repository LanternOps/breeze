package api

import (
	"crypto/tls"
	"net/http"
	"testing"
	"time"
)

func assertECHTransport(t *testing.T, c *Client) *http.Transport {
	t.Helper()
	tr, ok := c.httpClient.Transport.(*http.Transport)
	if !ok || tr == nil {
		t.Fatalf("transport = %T, want *http.Transport", c.httpClient.Transport)
	}
	if tr.DialTLSContext == nil {
		t.Fatal("DialTLSContext is nil; client does not dial through the ECH dialer")
	}
	if c.httpClient.CheckRedirect == nil {
		t.Fatal("CheckRedirect is nil")
	}
	if c.httpClient.Timeout != 30*time.Second {
		t.Fatalf("Timeout = %v, want 30s", c.httpClient.Timeout)
	}
	return tr
}

func TestNewClient_UsesECHTransport(t *testing.T) {
	assertECHTransport(t, NewClient("https://example.test", "tok", "agent"))
}

func TestNewClientWithTLS_KeepsTLSAndUsesECH(t *testing.T) {
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	tr := assertECHTransport(t, NewClientWithTLS("https://example.test", "tok", "agent", tlsCfg))
	if tr.TLSClientConfig != tlsCfg {
		t.Fatal("TLSClientConfig was not preserved")
	}
}
