package echtest

import (
	"context"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/ech"
)

func ok() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") })
}

func status(t *testing.T, c *http.Client, url string) int {
	t.Helper()
	resp, err := c.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

// Positive control: a transport on the shared ECH dialer is served.
func TestRig_ECHClientServed(t *testing.T) {
	rig := Start(t, "control.echtest.invalid", ok())
	c := ech.NewClient(&tls.Config{RootCAs: rig.Pool}, 5*time.Second, nil)
	if got := status(t, c, rig.URL("/")); got != http.StatusOK {
		t.Fatalf("status = %d, want 200", got)
	}
}

// Negative control: a plain TLS client reaching the same server is refused,
// so a 200 from the rig proves the ECH dialer was used.
func TestRig_PlainClientRefused(t *testing.T) {
	rig := Start(t, "control.echtest.invalid", ok())
	c := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{
		DialContext: func(ctx context.Context, network, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, rig.Addr)
		},
		TLSClientConfig: &tls.Config{RootCAs: rig.Pool},
	}}
	if got := status(t, c, rig.URL("/")); got != http.StatusMisdirectedRequest {
		t.Fatalf("status = %d, want 421", got)
	}
}
