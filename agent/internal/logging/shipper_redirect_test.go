package logging

import (
	"net/http"
	"net/http/cookiejar"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/pkg/httpguard/httpguardtest"
)

func TestDefaultShipperClientKeepsRedirectsOnServerHost(t *testing.T) {
	s := NewShipper(ShipperConfig{ServerURL: func() string { return httpguardtest.Origin }})
	httpguardtest.RequireSameHostRedirectsOnly(t, s.httpClient)
}

// A caller-supplied client with no redirect policy of its own gets the
// shared one; its timeout, transport and cookie jar are kept.
func TestInjectedShipperClientKeepsRedirectsOnServerHost(t *testing.T) {
	transport := &http.Transport{}
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatal(err)
	}
	s := NewShipper(ShipperConfig{
		ServerURL:  func() string { return httpguardtest.Origin },
		HTTPClient: &http.Client{Timeout: 5 * time.Second, Transport: transport, Jar: jar},
	})
	httpguardtest.RequireSameHostRedirectsOnly(t, s.httpClient)
	if s.httpClient.Timeout != 5*time.Second || s.httpClient.Transport != transport || s.httpClient.Jar != jar {
		t.Fatalf("injected client settings not kept: timeout=%v transport=%T jar=%v", s.httpClient.Timeout, s.httpClient.Transport, s.httpClient.Jar)
	}
}

// A caller-supplied client that already has a redirect policy keeps it.
func TestInjectedShipperClientKeepsItsOwnRedirectPolicy(t *testing.T) {
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	s := NewShipper(ShipperConfig{ServerURL: func() string { return httpguardtest.Origin }, HTTPClient: client})
	if s.httpClient != client {
		t.Fatal("a client with its own redirect policy should be used as given")
	}
}
