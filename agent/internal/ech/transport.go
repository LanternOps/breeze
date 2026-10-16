package ech

import (
	"crypto/tls"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/netcache"
)

// ControlPlaneNextProtos is the ALPN list offered on control-plane connections.
var ControlPlaneNextProtos = []string{"h2", "http/1.1"}

// NewTransport clones http.DefaultTransport and routes TCP through the shared
// DNS-caching dialer and TLS through the shared ECH dialer.
//
// When an HTTP proxy is in use Go bypasses DialTLSContext (it tunnels with
// CONNECT and does TLS itself using TLSClientConfig), so ECH is NOT applied
// through a proxy.
func NewTransport(base *tls.Config) *http.Transport {
	// Clone: with ForceAttemptHTTP2 net/http rewrites TLSClientConfig.NextProtos
	// on the first request, and several control-plane transports share one
	// mTLS config while the WebSocket and ECH dialers read it concurrently.
	var cfg *tls.Config
	if base != nil {
		cfg = base.Clone()
	}
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.DialContext = netcache.Shared().DialContext
	t.DialTLSContext = Shared().DialTLS(cfg, ControlPlaneNextProtos)
	t.TLSClientConfig = cfg
	t.ForceAttemptHTTP2 = true
	return t
}

// NewClient builds an http.Client over NewTransport.
func NewClient(base *tls.Config, timeout time.Duration, checkRedirect func(*http.Request, []*http.Request) error) *http.Client {
	return &http.Client{Transport: NewTransport(base), Timeout: timeout, CheckRedirect: checkRedirect}
}
