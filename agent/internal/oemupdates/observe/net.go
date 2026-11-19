package observe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// observeHosts is the only network observe may touch, each host bound to the one
// method observe uses there. It lives here, not in the root package's
// allowlist.json as the amendment first planned (§2.2 "observeHosts"), because
// observe must not import the root package, which holds fetch and install.
// HTTPS only; no redirect is followed; nothing read is written to disk.
var observeHosts = map[string]string{
	"hpia.hpcloud.hp.com": http.MethodHead, // HP's HPIA reference catalog: HEAD only
	"download.lenovo.com": http.MethodGet,  // Lenovo's per-MTM catalog: GET only
}

const netTimeout = 20 * time.Second

var (
	// ErrHostNotAllowed is a URL off observeHosts, or not https.
	ErrHostNotAllowed = errors.New("observe: host is not on the observe allowlist")
	// ErrMethodNotAllowed is a method the host's entry does not permit.
	ErrMethodNotAllowed = errors.New("observe: method is not allowed for this host")
)

// Client is the only way observe reaches the network.
type Client struct {
	http  *http.Client
	allow map[string]string // host, or host:port in tests -> method
}

// NewClient is the production client: the default transport (system proxy
// settings, TLS verification on), a 20 s budget per request, and redirects
// returned rather than followed, so a 3xx is recorded as a status.
func NewClient() *Client {
	return &Client{
		http:  &http.Client{Timeout: netTimeout, CheckRedirect: noRedirect},
		allow: observeHosts,
	}
}

func noRedirect(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }

// check accepts only an https URL with no userinfo whose host is listed for
// method. An entry without a port matches only the default port.
func (c *Client) check(method, rawURL string) error {
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("%w: unparseable url", ErrHostNotAllowed)
	}
	if u.Scheme != "https" || u.User != nil || u.Opaque != "" {
		return ErrHostNotAllowed
	}
	host, port := strings.ToLower(u.Hostname()), u.Port()
	want, ok := c.allow[strings.ToLower(u.Host)]
	if !ok && (port == "" || port == "443") {
		want, ok = c.allow[host]
	}
	if !ok {
		return ErrHostNotAllowed
	}
	if want != method {
		return ErrMethodNotAllowed
	}
	return nil
}

func (c *Client) do(ctx context.Context, method, rawURL string) (*http.Response, error) {
	if c == nil || c.http == nil {
		return nil, errors.New("observe: no network client")
	}
	if err := c.check(method, rawURL); err != nil {
		return nil, err
	}
	client := *c.http
	client.CheckRedirect = noRedirect
	req, err := http.NewRequestWithContext(ctx, method, rawURL, nil)
	if err != nil {
		return nil, err
	}
	return client.Do(req)
}

// Head sends one HEAD and returns the status only.
func (c *Client) Head(ctx context.Context, rawURL string) (int, error) {
	resp, err := c.do(ctx, http.MethodHead, rawURL)
	if err != nil {
		return 0, err
	}
	_ = resp.Body.Close()
	return resp.StatusCode, nil
}

// Get sends one GET and reads at most limit bytes of the body into memory.
// truncated says the body was longer; the bytes past limit are never read.
func (c *Client) Get(ctx context.Context, rawURL string, limit int64) (status int, body []byte, truncated bool, err error) {
	resp, err := c.do(ctx, http.MethodGet, rawURL)
	if err != nil {
		return 0, nil, false, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return resp.StatusCode, nil, false, nil
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return resp.StatusCode, nil, false, err
	}
	if int64(len(data)) > limit {
		return resp.StatusCode, data[:limit], true, nil
	}
	return resp.StatusCode, data, false, nil
}

// netCode names a network failure without its text.
func netCode(err error) string {
	switch {
	case errors.Is(err, ErrHostNotAllowed):
		return "host_not_allowed"
	case errors.Is(err, ErrMethodNotAllowed):
		return "method_not_allowed"
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	}
	return "network_error"
}
