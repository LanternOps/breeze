package agentapp

import (
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
	"github.com/breeze-rmm/agent/pkg/httpguard"
)

// newShipperHTTPClient builds the log shipper's HTTP client on the ECH-capable
// control-plane transport. The 30s timeout matches the shipper's previous
// built-in default (logging.NewShipper). Every flush carries the device
// credential, so redirects follow the shared credentialed-request policy.
func newShipperHTTPClient() *http.Client {
	return httpguard.NewClient(ech.NewTransport(nil), 30*time.Second)
}
