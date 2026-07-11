package netcache

import (
	"context"
	"errors"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

// fakeConn satisfies net.Conn minimally for dial stubs.
type fakeConn struct{ net.Conn }

func newTestCache(t *testing.T) (*Cache, *[]string) {
	t.Helper()
	dialed := &[]string{}
	c := New(filepath.Join(t.TempDir(), "dns-cache.json"))
	c.dial = func(_ context.Context, _, addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		return fakeConn{}, nil
	}
	return c, dialed
}

func TestSuccessfulDialPersistsIPs(t *testing.T) {
	c, _ := newTestCache(t)
	c.lookup = func(_ context.Context, host string) ([]string, error) {
		return []string{"203.0.113.10"}, nil
	}
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	// Fresh Cache reading the same file sees the persisted entry.
	c2 := New(c.path)
	if got := c2.cachedIPs("api.example.com"); len(got) != 1 || got[0] != "203.0.113.10" {
		t.Fatalf("persisted ips = %v", got)
	}
}

func TestDNSErrorFallsBackToCache(t *testing.T) {
	c, dialed := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10"}
	c.lookup = func(_ context.Context, host string) ([]string, error) {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	if len(*dialed) != 1 || (*dialed)[0] != "203.0.113.10:443" {
		t.Fatalf("dialed %v, want cached ip", *dialed)
	}
}

func TestDNSErrorWithEmptyCacheSurfacesOriginalError(t *testing.T) {
	c, _ := newTestCache(t)
	dnsErr := &net.DNSError{Err: "no such host", Name: "api.example.com", IsNotFound: true}
	c.lookup = func(_ context.Context, _ string) ([]string, error) { return nil, dnsErr }
	_, err := c.DialContext(context.Background(), "tcp", "api.example.com:443")
	var got *net.DNSError
	if !errors.As(err, &got) {
		t.Fatalf("want original DNS error, got %v", err)
	}
}

func TestConnectErrorDoesNotConsultCache(t *testing.T) {
	c, dialed := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10"}
	c.lookup = func(_ context.Context, _ string) ([]string, error) {
		return []string{"198.51.100.7"}, nil // DNS fine
	}
	connRefused := errors.New("connect: connection refused")
	c.dial = func(_ context.Context, _, addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		return nil, connRefused
	}
	_, err := c.DialContext(context.Background(), "tcp", "api.example.com:443")
	if !errors.Is(err, connRefused) {
		t.Fatalf("want connect error surfaced, got %v", err)
	}
	for _, a := range *dialed {
		if a == "203.0.113.10:443" {
			t.Fatal("cache consulted on a non-DNS failure")
		}
	}
}

func TestIPLiteralBypassesResolutionAndCache(t *testing.T) {
	c, dialed := newTestCache(t)
	c.lookup = func(_ context.Context, _ string) ([]string, error) {
		t.Fatal("lookup called for IP literal")
		return nil, nil
	}
	if _, err := c.DialContext(context.Background(), "tcp", "192.0.2.5:443"); err != nil {
		t.Fatal(err)
	}
	if (*dialed)[0] != "192.0.2.5:443" {
		t.Fatalf("dialed %v", *dialed)
	}
}

func TestCorruptCacheFileIsIgnored(t *testing.T) {
	path := filepath.Join(t.TempDir(), "dns-cache.json")
	if err := os.WriteFile(path, []byte("not-json"), 0o644); err != nil {
		t.Fatal(err)
	}

	c := New(path)
	if got := c.cachedIPs("api.example.com"); len(got) != 0 {
		t.Fatalf("cached ips = %v, want empty cache", got)
	}
}

func TestFreshDNSIPsAreTriedInOrder(t *testing.T) {
	c, dialed := newTestCache(t)
	c.lookup = func(_ context.Context, _ string) ([]string, error) {
		return []string{"198.51.100.7", "203.0.113.10"}, nil
	}
	firstErr := errors.New("first IP unavailable")
	c.dial = func(_ context.Context, _, addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		if addr == "198.51.100.7:443" {
			return nil, firstErr
		}
		return fakeConn{}, nil
	}

	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	want := []string{"198.51.100.7:443", "203.0.113.10:443"}
	if !reflect.DeepEqual(*dialed, want) {
		t.Fatalf("dialed %v, want %v", *dialed, want)
	}
}

func TestUnsplittableAddressPassesThrough(t *testing.T) {
	c, dialed := newTestCache(t)
	c.lookup = func(_ context.Context, _ string) ([]string, error) {
		t.Fatal("lookup called for unsplittable address")
		return nil, nil
	}

	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com"); err != nil {
		t.Fatal(err)
	}
	if want := []string{"api.example.com"}; !reflect.DeepEqual(*dialed, want) {
		t.Fatalf("dialed %v, want %v", *dialed, want)
	}
}

func TestCacheFallbackFailureSurfacesOriginalDNSError(t *testing.T) {
	c, dialed := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10", "198.51.100.7"}
	dnsErr := &net.DNSError{Err: "no such host", Name: "api.example.com", IsNotFound: true}
	c.lookup = func(_ context.Context, _ string) ([]string, error) { return nil, dnsErr }
	c.dial = func(_ context.Context, _, addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		return nil, errors.New("cached IP unavailable")
	}

	_, err := c.DialContext(context.Background(), "tcp", "api.example.com:443")
	if err != dnsErr {
		t.Fatalf("error = %v, want original DNS error %v", err, dnsErr)
	}
	want := []string{"203.0.113.10:443", "198.51.100.7:443"}
	if !reflect.DeepEqual(*dialed, want) {
		t.Fatalf("dialed %v, want %v", *dialed, want)
	}
}

func TestUnchangedIPSetDoesNotRewriteCache(t *testing.T) {
	c, _ := newTestCache(t)
	ips := []string{"198.51.100.7", "203.0.113.10"}
	c.lookup = func(_ context.Context, _ string) ([]string, error) { return ips, nil }
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}

	oldTime := time.Unix(1, 0)
	if err := os.Chtimes(c.path, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}
	ips = []string{"203.0.113.10", "198.51.100.7"}
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}

	info, err := os.Stat(c.path)
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(oldTime) {
		t.Fatalf("cache modtime = %v, want unchanged %v", info.ModTime(), oldTime)
	}
}
