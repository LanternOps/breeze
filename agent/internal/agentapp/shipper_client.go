package agentapp

import (
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
)

// newShipperHTTPClient builds the log shipper's HTTP client on the ECH-capable
// control-plane transport. The 30s timeout matches the shipper's previous
// built-in default (logging.NewShipper).
func newShipperHTTPClient() *http.Client {
	return ech.NewClient(nil, 30*time.Second, nil)
}
