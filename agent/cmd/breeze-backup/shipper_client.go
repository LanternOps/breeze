package main

import (
	"crypto/tls"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
	"github.com/breeze-rmm/agent/pkg/httpguard"
)

// newShipperHTTPClient is the backup helper's log-shipper client. The shipper's
// own fallback is a bare http.Client (internal/logging cannot import ech:
// ech logs through it), whose TLS cannot get past an SNI filter; this one
// dials through the shared ECH dialer like the agent's shipper (#8869). The
// process must call ech.Configure before the first dial (the flags are
// atomics read per dial) so the operator opt-out holds. Every flush carries
// the helper's credential, so redirects follow the shared credentialed-request
// policy.
func newShipperHTTPClient() *http.Client {
	return httpguard.NewClient(ech.NewTransport(&tls.Config{MinVersion: tls.VersionTLS12}), 30*time.Second)
}
