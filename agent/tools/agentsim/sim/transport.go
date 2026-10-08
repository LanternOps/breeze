package sim

import (
	"context"
	"net/http"
	"sync/atomic"
	"time"
)

type attemptKey struct{}

// withLogicalRequest marks ctx as one logical request; every attempt
// httputil.Do makes under it shares the counter, so the first is the request
// and the rest are retries.
func withLogicalRequest(ctx context.Context) context.Context {
	return context.WithValue(ctx, attemptKey{}, new(atomic.Int32))
}

func isFirstAttempt(ctx context.Context) bool {
	n, ok := ctx.Value(attemptKey{}).(*atomic.Int32)
	if !ok {
		return true // a plain client.Do (no retry wrapper) is always its own request
	}
	return n.Add(1) == 1
}

// recordingTransport records every attempt by route template.
type recordingTransport struct {
	base http.RoundTripper
	rec  *Recorder
}

func (t *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	route := RouteKey(req.Method, req.URL.Path)
	first := isFirstAttempt(req.Context())
	start := time.Now()
	resp, err := t.base.RoundTrip(req)
	status := 0
	if resp != nil {
		status = resp.StatusCode
	}
	t.rec.ObserveHTTP(route, first, start, time.Since(start), status, err)
	return resp, err
}
