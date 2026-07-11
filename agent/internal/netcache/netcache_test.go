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
	c.lookup = func(_ context.Context, host string) ([]string, error) {
		t.Fatalf("unexpected lookup for %q", host)
		return nil, nil
	}
	return c, dialed
}

// dnsFailDial returns a dial stub that fails hostname-form addresses with a
// *net.DNSError (what net.Dialer surfaces when resolution fails) and
// delegates IP-literal addresses to onIP.
func dnsFailDial(dialed *[]string, onIP func(addr string) (net.Conn, error)) func(context.Context, string, string) (net.Conn, error) {
	return func(_ context.Context, _, addr string) (net.Conn, error) {
		*dialed = append(*dialed, addr)
		host, _, err := net.SplitHostPort(addr)
		if err == nil && net.ParseIP(host) == nil {
			return nil, &net.OpError{Op: "dial", Net: "tcp", Err: &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}}
		}
		return onIP(addr)
	}
}

func TestSuccessfulDialUsesHostnameAndPersistsIPs(t *testing.T) {
	c, dialed := newTestCache(t)
	c.lookup = func(_ context.Context, host string) ([]string, error) {
		return []string{"203.0.113.10"}, nil
	}
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	// The dial must receive the HOSTNAME (stock resolver + Happy Eyeballs
	// preserved), never a pre-resolved IP.
	if want := []string{"api.example.com:443"}; !reflect.DeepEqual(*dialed, want) {
		t.Fatalf("dialed %v, want hostname passthrough %v", *dialed, want)
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
	c.dial = dnsFailDial(dialed, func(_ string) (net.Conn, error) {
		return fakeConn{}, nil
	})
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	want := []string{"api.example.com:443", "203.0.113.10:443"}
	if !reflect.DeepEqual(*dialed, want) {
		t.Fatalf("dialed %v, want hostname attempt then cached ip", *dialed)
	}
}

func TestDNSErrorWithEmptyCacheSurfacesOriginalError(t *testing.T) {
	c, dialed := newTestCache(t)
	c.dial = dnsFailDial(dialed, func(_ string) (net.Conn, error) {
		t.Fatal("no cached IP should be dialed")
		return nil, nil
	})
	_, err := c.DialContext(context.Background(), "tcp", "api.example.com:443")
	var got *net.DNSError
	if !errors.As(err, &got) {
		t.Fatalf("want original DNS error, got %v", err)
	}
}

func TestConnectErrorDoesNotConsultCache(t *testing.T) {
	c, dialed := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10"}
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
	if _, err := c.DialContext(context.Background(), "tcp", "192.0.2.5:443"); err != nil {
		t.Fatal(err)
	}
	if (*dialed)[0] != "192.0.2.5:443" {
		t.Fatalf("dialed %v", *dialed)
	}
}

func TestIPv6LiteralBypassesResolutionAndCache(t *testing.T) {
	c, dialed := newTestCache(t)
	if _, err := c.DialContext(context.Background(), "tcp", "[2001:db8::1]:443"); err != nil {
		t.Fatal(err)
	}
	if (*dialed)[0] != "[2001:db8::1]:443" {
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

func TestFailedRefreshLookupKeepsPreviousEntry(t *testing.T) {
	c, _ := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10"}
	c.lookup = func(_ context.Context, _ string) ([]string, error) {
		return nil, errors.New("resolver hiccup after successful dial")
	}
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com:443"); err != nil {
		t.Fatal(err)
	}
	if got := c.cachedIPs("api.example.com"); len(got) != 1 || got[0] != "203.0.113.10" {
		t.Fatalf("cached ips = %v, want previous entry retained", got)
	}
}

func TestUnsplittableAddressPassesThrough(t *testing.T) {
	c, dialed := newTestCache(t)
	if _, err := c.DialContext(context.Background(), "tcp", "api.example.com"); err != nil {
		t.Fatal(err)
	}
	if want := []string{"api.example.com"}; !reflect.DeepEqual(*dialed, want) {
		t.Fatalf("dialed %v, want %v", *dialed, want)
	}
}

func TestCacheFallbackTriesIPsInOrderAndSurfacesOriginalDNSError(t *testing.T) {
	c, dialed := newTestCache(t)
	c.entries["api.example.com"] = []string{"203.0.113.10", "198.51.100.7"}
	c.dial = dnsFailDial(dialed, func(_ string) (net.Conn, error) {
		return nil, errors.New("cached IP unavailable")
	})

	_, err := c.DialContext(context.Background(), "tcp", "api.example.com:443")
	var got *net.DNSError
	if !errors.As(err, &got) || got.Name != "api.example.com" {
		t.Fatalf("error = %v, want the original DNS error", err)
	}
	want := []string{"api.example.com:443", "203.0.113.10:443", "198.51.100.7:443"}
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

// TestConcurrentStoreAndReadDoNotSerializeOnDisk drives store (which
// persists) concurrently with cachedIPs readers for a different host under
// -race, pinning that the entries lock is released before disk I/O.
func TestConcurrentStoreAndReadDoNotSerializeOnDisk(t *testing.T) {
	c, _ := newTestCache(t)
	c.entries["other.example.com"] = []string{"198.51.100.1"}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100; i++ {
			c.store("api.example.com", []string{"203.0.113.10", "203.0.113.11"})
			c.store("api.example.com", []string{"203.0.113.12"})
		}
	}()
	for i := 0; i < 1000; i++ {
		if got := c.cachedIPs("other.example.com"); len(got) != 1 || got[0] != "198.51.100.1" {
			t.Fatalf("cachedIPs = %v, want stable unrelated entry", got)
		}
	}
	<-done
}

// TestConcurrentStoresNeverRegressPersistedFile pins the snapshot-ordering
// fix: two writers updating different hosts concurrently must both survive
// in the final on-disk file — an earlier writer's stale snapshot may never
// erase a later writer's entry.
func TestConcurrentStoresNeverRegressPersistedFile(t *testing.T) {
	c, _ := newTestCache(t)

	done := make(chan struct{}, 2)
	go func() {
		for i := 0; i < 50; i++ {
			c.store("a.example.com", []string{"203.0.113.10"})
			c.store("a.example.com", []string{"203.0.113.11"})
		}
		done <- struct{}{}
	}()
	go func() {
		for i := 0; i < 50; i++ {
			c.store("b.example.com", []string{"198.51.100.7"})
			c.store("b.example.com", []string{"198.51.100.8"})
		}
		done <- struct{}{}
	}()
	<-done
	<-done

	c2 := New(c.path)
	if got := c2.cachedIPs("a.example.com"); len(got) == 0 {
		t.Fatal("host a missing from persisted cache after concurrent stores")
	}
	if got := c2.cachedIPs("b.example.com"); len(got) == 0 {
		t.Fatal("host b missing from persisted cache after concurrent stores")
	}
}
