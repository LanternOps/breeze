package httpguard

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

func mustRequest(t *testing.T, rawURL string) *http.Request {
	t.Helper()
	r, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		t.Fatalf("bad url %q: %v", rawURL, err)
	}
	return r
}

func TestRefuseUntrustedRedirect(t *testing.T) {
	tests := []struct {
		name    string
		prev    string
		target  string
		wantErr bool
	}{
		{"same host, different path", "https://api.example.com/a", "https://api.example.com/b", false},
		{"http to https upgrade on the same host", "http://api.example.com/a", "https://api.example.com/b", false},
		{"host comparison ignores case", "https://api.example.com/a", "https://API.Example.com/b", false},
		{"different port on the same host", "https://api.example.com/a", "https://api.example.com:8443/b", false},
		{"different host", "https://api.example.com/a", "https://other.example.com/b", true},
		{"subdomain of the host", "https://api.example.com/a", "https://sub.api.example.com/b", true},
		{"parent domain of the host", "https://api.example.com/a", "https://example.com/b", true},
		{"https to http on the same host", "https://api.example.com:8443/a", "http://api.example.com:8443/b", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := RefuseUntrustedRedirect(mustRequest(t, tt.target), []*http.Request{mustRequest(t, tt.prev)})
			if (err != nil) != tt.wantErr {
				t.Fatalf("error = %v, wantErr = %v", err, tt.wantErr)
			}
		})
	}
	if err := RefuseUntrustedRedirect(mustRequest(t, "https://api.example.com/a"), nil); err != nil {
		t.Fatalf("a request with no previous hop must be allowed, got %v", err)
	}
}

// Every hop is compared with the one before it, so a chain cannot step off
// the host and back.
func TestRefuseUntrustedRedirectChecksEachHop(t *testing.T) {
	via := []*http.Request{mustRequest(t, "https://api.example.com/a"), mustRequest(t, "https://other.example.com/b")}
	if err := RefuseUntrustedRedirect(mustRequest(t, "https://api.example.com/c"), via); err == nil {
		t.Fatal("a hop from another host was allowed")
	}
}

// Installing any CheckRedirect replaces net/http's default ten-hop limit, so
// the policy keeps one.
func TestRefuseUntrustedRedirectStopsAfterMaxRedirects(t *testing.T) {
	var via []*http.Request
	for i := 0; i < MaxRedirects-1; i++ {
		via = append(via, mustRequest(t, "https://api.example.com/loop"))
	}
	if err := RefuseUntrustedRedirect(mustRequest(t, "https://api.example.com/loop"), via); err != nil {
		t.Fatalf("hop %d refused: %v", len(via), err)
	}
	via = append(via, mustRequest(t, "https://api.example.com/loop"))
	err := RefuseUntrustedRedirect(mustRequest(t, "https://api.example.com/loop"), via)
	if !errors.Is(err, ErrTooManyRedirects) {
		t.Fatalf("hop %d: error = %v, want ErrTooManyRedirects", len(via), err)
	}
}

func TestNewClient(t *testing.T) {
	transport := &http.Transport{}
	c := NewClient(transport, 7*time.Second)
	if c.Transport != transport || c.Timeout != 7*time.Second {
		t.Fatalf("client = %+v, want the given transport and timeout", c)
	}
	httpguardtest.RequireSameHostRedirectsOnly(t, c)
}

func TestSameOrigin(t *testing.T) {
	tests := []struct {
		a, b string
		want bool
	}{
		{"https://api.example.com", "https://api.example.com/path?q=1", true},
		{"https://api.example.com", "https://API.EXAMPLE.COM:443/x", true},
		{"HTTPS://api.example.com", "https://api.example.com", true},
		{"http://api.example.com", "http://api.example.com:80/x", true},
		{"https://api.example.com:8443", "https://api.example.com:8443/x", true},
		{"https://[2001:db8::1]:8443", "https://[2001:DB8::1]:8443/x", true},
		{"https://api.example.com", "https://api.example.com:8443/x", false},
		{"https://api.example.com", "http://api.example.com/x", false},
		{"https://api.example.com", "https://cdn.example.com/x", false},
		{"https://api.example.com", "https://sub.api.example.com/x", false},
		{"https://api.example.com", "https://user:pass@api.example.com/x", false},
		{"https://api.example.com", "ftp://api.example.com/x", false},
		{"https://api.example.com", "/relative/path", false},
		{"https://api.example.com", "https://api.example.com:0/x", false},
		{"https://api.example.com", "https://api.example.com:99999/x", false},
		{"", "", false},
		{"not a url", "not a url", false},
	}
	for _, tt := range tests {
		if got := SameOrigin(tt.a, tt.b); got != tt.want {
			t.Errorf("SameOrigin(%q, %q) = %v, want %v", tt.a, tt.b, got, tt.want)
		}
	}
}
