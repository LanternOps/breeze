package workloads

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"time"
)

// ErrReadOnly is returned for any request the read-only transport refuses.
var ErrReadOnly = errors.New("workloads: request refused by read-only transport")

// DialFunc opens one connection to a runtime's local API endpoint (a unix
// socket or a Windows named pipe).
type DialFunc func(ctx context.Context) (net.Conn, error)

// allowedRequests is the complete set of (path, raw query) pairs the Docker
// driver may issue. Anything else, including every mutating Docker API path,
// is refused before a connection is dialed.
var allowedRequests = map[string]map[string]bool{
	"/_ping":           {"": true},
	"/version":         {"": true},
	"/containers/json": {"all=1": true},
	"/images/json":     {"": true, imageIdentityQuery: true},
}

// ReadOnlyTransport wraps a RoundTripper and refuses everything except GET or
// HEAD on an allowlisted path and query. The agent runs as root/SYSTEM and the
// engine socket is root-equivalent, so "collection cannot change anything" is a
// property of this type, not a convention of its callers.
type ReadOnlyTransport struct {
	Inner http.RoundTripper
}

func (t ReadOnlyTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		_ = req.Body.Close()
	}
	if req.Method != http.MethodGet && req.Method != http.MethodHead {
		return nil, fmt.Errorf("%w: method %s", ErrReadOnly, req.Method)
	}
	queries, ok := allowedRequests[req.URL.Path]
	if !ok {
		return nil, fmt.Errorf("%w: path %s", ErrReadOnly, req.URL.Path)
	}
	if !queries[req.URL.RawQuery] {
		return nil, fmt.Errorf("%w: query on %s", ErrReadOnly, req.URL.Path)
	}
	return t.Inner.RoundTrip(req)
}

// newReadOnlyClient builds an HTTP client that talks to one endpoint through
// dial. The URL host is ignored; keep-alives are off so no connection outlives
// a collection.
func newReadOnlyClient(dial DialFunc, timeout time.Duration) *http.Client {
	inner := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dial(ctx)
		},
		DisableKeepAlives:     true,
		ResponseHeaderTimeout: timeout,
	}
	return &http.Client{
		Transport: ReadOnlyTransport{Inner: inner},
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}
