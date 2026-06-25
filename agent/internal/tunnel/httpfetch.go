package tunnel

import (
	"bytes"
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// FetchRequest is one proxied HTTP request to a LAN target.
type FetchRequest struct {
	Scheme  string              // "http" | "https" (derived from target port if empty)
	Host    string              // target IP/host
	Port    int                 // target port
	Method  string              // GET/POST/...
	Path    string              // path + raw query, e.g. "/admin/index.html?x=1"
	Headers map[string][]string // forwarded request headers (already filtered by caller)
	Body    []byte              // request body (may be nil)
}

// FetchResponse holds the proxied response.
type FetchResponse struct {
	Status    int
	Headers   map[string][]string
	Body      []byte // capped at maxBody bytes
	Truncated bool   // true when the response body exceeded maxBody
}

// hopByHop lists headers that must not be forwarded in either direction.
var hopByHop = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

// Fetch performs the one-shot HTTP/HTTPS request described by req.
// timeout caps total round-trip time; maxBody caps response bytes read
// (the response is marked Truncated if the body exceeded the cap).
func Fetch(ctx context.Context, req FetchRequest, timeout time.Duration, maxBody int64) (*FetchResponse, error) {
	scheme := req.Scheme
	if scheme == "" {
		if req.Port == 443 {
			scheme = "https"
		} else {
			scheme = "http"
		}
	}

	// SECURITY: build the URL with net/url and pin the host to req.Host.
	// A browser-supplied path like "@evil.com/x" or "//evil.com/x" would, if
	// string-concatenated, re-parse so the host becomes evil.com — bypassing the
	// IsBlocked/IsAllowed checks (which only validated req.Host). Reject anything
	// that is not a plain relative path before constructing the request.
	if !strings.HasPrefix(req.Path, "/") {
		return nil, fmt.Errorf("path must start with /")
	}
	ref, err := url.Parse(req.Path)
	if err != nil {
		return nil, err
	}
	if ref.IsAbs() || ref.Host != "" || ref.User != nil || ref.Scheme != "" {
		return nil, fmt.Errorf("path must be a relative path, not a URL")
	}
	u := &url.URL{
		Scheme:   scheme,
		Host:     net.JoinHostPort(req.Host, strconv.Itoa(req.Port)),
		Path:     ref.Path,
		RawQuery: ref.RawQuery,
	}
	// Defense-in-depth: the constructed URL must still target exactly req.Host
	// with no userinfo component.
	if u.User != nil || !strings.EqualFold(u.Hostname(), req.Host) {
		return nil, fmt.Errorf("refusing to fetch: host/userinfo mismatch")
	}

	var bodyReader io.Reader
	if len(req.Body) > 0 {
		bodyReader = bytes.NewReader(req.Body)
	}

	hreq, err := http.NewRequestWithContext(ctx, req.Method, u.String(), bodyReader)
	if err != nil {
		return nil, err
	}

	for k, vs := range req.Headers {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			hreq.Header.Add(k, v)
		}
	}

	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			// Self-signed printer/device certs are the norm on a LAN. The tunnel
			// target is already constrained to the tunnel_session's host:port and
			// re-checked against the org allowlist, so cert pinning adds no security
			// here while breaking every real device. Skip verification deliberately.
			TLSClientConfig:   &tls.Config{InsecureSkipVerify: true}, //nolint:gosec
			DisableKeepAlives: true,
			Proxy:             nil,
		},
		// Do not auto-follow redirects — the API layer rewrites Location headers.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}

	resp, err := client.Do(hreq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	// Read up to maxBody+1 bytes so we can detect truncation.
	limited := io.LimitReader(resp.Body, maxBody+1)
	b, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	truncated := int64(len(b)) > maxBody
	if truncated {
		b = b[:maxBody]
	}

	outHeaders := make(map[string][]string)
	for k, vs := range resp.Header {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		outHeaders[k] = vs
	}

	return &FetchResponse{
		Status:    resp.StatusCode,
		Headers:   outHeaders,
		Body:      b,
		Truncated: truncated,
	}, nil
}
