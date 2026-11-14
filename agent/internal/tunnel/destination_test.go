package tunnel

import (
	"errors"
	"net"
	"strings"
	"testing"
)

func withLookup(t *testing.T, fn func(string) ([]net.IP, error)) {
	t.Helper()
	previous := lookupIP
	lookupIP = fn
	t.Cleanup(func() { lookupIP = previous })
}

func TestResolveDestinationRefusesLoopbackAndLinkLocalInBothFamilies(t *testing.T) {
	allowAll := []AllowlistRule{
		mustParseRule(t, "0.0.0.0/0:*"),
		mustParseRule(t, "::/0:*"),
	}
	for _, host := range []string{
		"127.0.0.1", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1",
		"169.254.169.254", "fe80::1", "0.0.0.0", "::",
		"fd00:ec2::254", "fd20:ce::254",
	} {
		if got, err := ResolveDestination(host, 8080, false, allowAll); err == nil {
			t.Fatalf("ResolveDestination(%q) = %q, want refusal", host, got)
		}
	}
}

func TestResolveDestinationChecksEveryResolvedAddress(t *testing.T) {
	rules := []AllowlistRule{mustParseRule(t, "192.0.2.0/24:443"), mustParseRule(t, "2001:db8::/32:443")}
	for _, records := range [][]net.IP{
		{net.ParseIP("192.0.2.10"), net.ParseIP("127.0.0.1")},
		{net.ParseIP("192.0.2.10"), net.ParseIP("::1")},
		{net.ParseIP("2001:db8::1"), net.ParseIP("fe80::1")},
		{net.ParseIP("192.0.2.10"), net.ParseIP("198.51.100.7")},
	} {
		records := records
		withLookup(t, func(string) ([]net.IP, error) { return records, nil })
		if got, err := ResolveDestination("service.example", 443, false, rules); err == nil {
			t.Fatalf("records %v: ResolveDestination = %q, want refusal", records, got)
		}
	}

	withLookup(t, func(string) ([]net.IP, error) { return []net.IP{net.ParseIP("2001:db8::1")}, nil })
	got, err := ResolveDestination("service.example", 443, false, rules)
	if err != nil || got != "2001:db8::1" {
		t.Fatalf("ResolveDestination(IPv6 permitted) = %q, %v", got, err)
	}

	withLookup(t, func(string) ([]net.IP, error) { return nil, errors.New("no such host") })
	if _, err := ResolveDestination("missing.example", 443, false, rules); err == nil {
		t.Fatal("unresolvable destination accepted")
	}
}

func TestResolveDestinationReturnsTheCheckedAddress(t *testing.T) {
	rules := []AllowlistRule{mustParseRule(t, "192.0.2.0/24:443")}
	withLookup(t, func(string) ([]net.IP, error) { return []net.IP{net.ParseIP("192.0.2.10")}, nil })
	got, err := ResolveDestination("printer.example", 443, false, rules)
	if err != nil || got != "192.0.2.10" {
		t.Fatalf("ResolveDestination = %q, %v; want the checked numeric address", got, err)
	}
}

func TestResolveDestinationVNCExceptionIsTheLocalVNCEndpointOnly(t *testing.T) {
	if got, err := ResolveDestination("127.0.0.1", 5900, true, nil); err != nil || got != "127.0.0.1" {
		t.Fatalf("local VNC endpoint = %q, %v", got, err)
	}
	for _, target := range []struct {
		host string
		port int
	}{
		{"::1", 5900},
		{"localhost", 5900},
		{"127.0.0.1", 22},
		{"127.0.0.2", 5900},
		{"192.0.2.1", 5900},
		{"10.0.0.5", 3389},
	} {
		got, err := ResolveDestination(target.host, target.port, true, nil)
		if err == nil {
			t.Fatalf("VNC to %s:%d = %q, want refusal", target.host, target.port, got)
		}
		if !strings.Contains(err.Error(), "blocked") && !strings.Contains(err.Error(), "not permitted") {
			t.Fatalf("VNC to %s:%d refused with unexpected error %v", target.host, target.port, err)
		}
	}
}
