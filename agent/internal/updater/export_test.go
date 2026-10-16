package updater

import "net/http"

// NewWithClientForTest builds an Updater whose HTTP client is c instead of the
// netpolicy client (which refuses loopback httptest servers). Test builds only.
func NewWithClientForTest(cfg *Config, c *http.Client) *Updater {
	u := New(cfg)
	u.client = c
	u.clientErr = nil
	return u
}
