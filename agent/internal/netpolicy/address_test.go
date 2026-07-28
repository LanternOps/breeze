package netpolicy

import (
	"errors"
	"net/netip"
	"testing"
)

// assertReason fails unless err is a *PolicyError carrying the wanted reason.
func assertReason(t *testing.T, err error, want string) {
	t.Helper()
	if err == nil {
		t.Fatalf("expected error with reason %q, got nil", want)
	}
	var pe *PolicyError
	if !errors.As(err, &pe) {
		t.Fatalf("expected *PolicyError, got %T (%v)", err, err)
	}
	if pe.Reason != want {
		t.Fatalf("reason = %q, want %q", pe.Reason, want)
	}
}

func TestClassifyAddress(t *testing.T) {
	tests := []struct {
		name string
		addr string
		want addressClass
	}{
		// Loopback — never allowlistable.
		{"ipv4 loopback", "127.0.0.1", classForbidden},
		{"ipv4 loopback high", "127.99.42.7", classForbidden},
		{"ipv6 loopback", "::1", classForbidden},
		{"ipv4-mapped loopback", "::ffff:127.0.0.1", classForbidden},

		// Unspecified.
		{"ipv4 unspecified", "0.0.0.0", classForbidden},
		{"ipv6 unspecified", "::", classForbidden},

		// Link-local unicast.
		{"ipv4 link-local", "169.254.13.37", classForbidden},
		{"ipv6 link-local", "fe80::1", classForbidden},

		// Multicast, including link-local and interface-local multicast.
		{"ipv4 multicast", "224.0.0.251", classForbidden},
		{"ipv4 multicast high", "239.1.2.3", classForbidden},
		{"ipv6 link-local multicast", "ff02::1", classForbidden},
		{"ipv6 interface-local multicast", "ff01::1", classForbidden},
		{"ipv6 global multicast", "ff0e::1", classForbidden},
		{"ipv4-mapped multicast", "::ffff:224.0.0.251", classForbidden},

		// Explicit metadata endpoints.
		{"aws/azure/gcp metadata", "169.254.169.254", classForbidden},
		{"ecs task metadata", "169.254.170.2", classForbidden},
		{"alibaba metadata", "100.100.100.200", classForbidden},
		{"ipv4-mapped metadata", "::ffff:169.254.169.254", classForbidden},

		// Ambiguous IPv6 encodings that carry an unsafe IPv4 inside.
		{"6to4 wrapping loopback", "2002:7f00:1::", classForbidden},
		{"6to4 wrapping metadata", "2002:a9fe:a9fe::", classForbidden},
		{"teredo wrapping loopback", "2001::80ff:fffe", classForbidden},
		{"nat64 wrapping loopback", "64:ff9b::7f00:1", classForbidden},
		{"nat64 wrapping rfc1918", "64:ff9b::a00:5", classPrivate},
		{"ipv4-compatible wrapping loopback", "::7f00:1", classForbidden},
		{"ipv4-compatible wrapping rfc1918", "::a00:5", classPrivate},
		{"ipv4-translated wrapping loopback", "::ffff:0:7f00:1", classForbidden},
		{"ipv4-translated wrapping metadata", "::ffff:0:a9fe:a9fe", classForbidden},

		// D3: reserved ranges that are reachable on a real network but are
		// never a legitimate download source.
		{"this-network 0.0.0.0/8", "0.1.2.3", classForbidden},
		{"this-network high", "0.255.255.255", classForbidden},
		{"ietf protocol assignments", "192.0.0.1", classForbidden},
		{"ietf protocol assignments high", "192.0.0.255", classForbidden},
		{"benchmarking 198.18/15 low", "198.18.0.1", classForbidden},
		{"benchmarking 198.18/15 high", "198.19.255.255", classForbidden},
		{"reserved 240/4", "240.0.0.1", classForbidden},
		{"reserved 240/4 high", "255.255.255.254", classForbidden},
		{"limited broadcast", "255.255.255.255", classForbidden},

		// RFC1918 + IPv6 ULA — allowlistable by exact origin only.
		{"rfc1918 10/8", "10.0.0.5", classPrivate},
		{"rfc1918 172.16/12 low", "172.16.0.1", classPrivate},
		{"rfc1918 172.16/12 high", "172.31.255.255", classPrivate},
		{"rfc1918 192.168/16", "192.168.1.10", classPrivate},
		{"ipv4-mapped rfc1918", "::ffff:10.0.0.5", classPrivate},
		{"ipv6 ula fc00", "fc00::1", classPrivate},
		{"ipv6 ula fd00", "fd12:3456:789a::1", classPrivate},

		// D3: CGNAT is allowlist-gated private, not public. It is Tailscale's
		// range, so a tailnet-joined endpoint would otherwise be an SSRF pivot
		// onto arbitrary tailnet peers. A legitimate CDN is never CGNAT.
		{"cgnat low", "100.64.0.1", classPrivate},
		{"cgnat high", "100.127.255.255", classPrivate},
		{"cgnat metadata stays forbidden", "100.100.100.200", classForbidden},

		// Public.
		{"public ipv4", "8.8.8.8", classPublic},
		{"public ipv4 just outside 172.16/12", "172.32.0.1", classPublic},
		{"public ipv4 just below cgnat", "100.63.255.255", classPublic},
		{"public ipv4 just above cgnat", "100.128.0.1", classPublic},
		{"public ipv4 just above benchmarking", "198.20.0.1", classPublic},
		{"public ipv4 just above protocol assignments", "192.0.1.1", classPublic},
		{"public ipv6", "2606:4700::1111", classPublic},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			a, err := netip.ParseAddr(tt.addr)
			if err != nil {
				t.Fatalf("ParseAddr(%q): %v", tt.addr, err)
			}
			if got := classifyAddress(a); got != tt.want {
				t.Fatalf("classifyAddress(%s) = %v, want %v", tt.addr, got, tt.want)
			}
		})
	}
}

func TestClassifyAddressRejectsInvalid(t *testing.T) {
	if got := classifyAddress(netip.Addr{}); got != classForbidden {
		t.Fatalf("classifyAddress(zero) = %v, want classForbidden", got)
	}
}

func mustAddrs(t *testing.T, ss ...string) []netip.Addr {
	t.Helper()
	out := make([]netip.Addr, 0, len(ss))
	for _, s := range ss {
		a, err := netip.ParseAddr(s)
		if err != nil {
			t.Fatalf("ParseAddr(%q): %v", s, err)
		}
		out = append(out, a)
	}
	return out
}

func TestValidateResolution(t *testing.T) {
	tests := []struct {
		name           string
		addrs          []string
		privateAllowed bool
		wantReason     string // "" means accept
	}{
		{"all public", []string{"8.8.8.8", "2606:4700::1111"}, false, ""},
		{"empty answer", nil, true, ReasonNoAddresses},
		// Rule 4: reject the WHOLE resolution if any answer is unsafe.
		{"mixed public and loopback", []string{"8.8.8.8", "127.0.0.1"}, false, ReasonForbiddenAddress},
		{"mixed public and metadata", []string{"8.8.8.8", "169.254.169.254"}, true, ReasonForbiddenAddress},
		// Universally unsafe is never allowlistable, even with privates approved.
		{"loopback with private approved", []string{"127.0.0.1"}, true, ReasonForbiddenAddress},
		{"private plus loopback with private approved", []string{"10.0.0.5", "::1"}, true, ReasonForbiddenAddress},
		// Rule 5: private answers need an approved exact origin.
		{"mixed public and private unapproved", []string{"8.8.8.8", "10.0.0.5"}, false, ReasonPrivateAddressNotAllowed},
		{"private unapproved", []string{"192.168.1.10"}, false, ReasonPrivateAddressNotAllowed},
		{"ula unapproved", []string{"fd00::1"}, false, ReasonPrivateAddressNotAllowed},
		{"private approved", []string{"10.0.0.5"}, true, ""},
		{"mixed public and private approved", []string{"8.8.8.8", "192.168.1.10"}, true, ""},
		// D3: CGNAT behaves exactly like RFC1918 — gated, not banned.
		{"cgnat unapproved", []string{"100.64.1.2"}, false, ReasonPrivateAddressNotAllowed},
		{"cgnat approved", []string{"100.64.1.2"}, true, ""},
		// ...but a reserved range is never reachable, approved or not.
		{"reserved with private approved", []string{"240.1.2.3"}, true, ReasonForbiddenAddress},
		{"broadcast with private approved", []string{"255.255.255.255"}, true, ReasonForbiddenAddress},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateResolution(mustAddrs(t, tt.addrs...), tt.privateAllowed)
			if tt.wantReason == "" {
				if err != nil {
					t.Fatalf("validateResolution = %v, want nil", err)
				}
				return
			}
			assertReason(t, err, tt.wantReason)
		})
	}
}

func TestValidateResolutionErrorHidesAddresses(t *testing.T) {
	err := validateResolution(mustAddrs(t, "10.11.12.13"), false)
	assertReason(t, err, ReasonPrivateAddressNotAllowed)
	if got := err.Error(); contains(got, "10.11.12.13") {
		t.Fatalf("error string %q leaks the resolved private address", got)
	}
}

func contains(haystack, needle string) bool {
	return len(needle) > 0 && len(haystack) >= len(needle) &&
		func() bool {
			for i := 0; i+len(needle) <= len(haystack); i++ {
				if haystack[i:i+len(needle)] == needle {
					return true
				}
			}
			return false
		}()
}

func TestParseOrigin(t *testing.T) {
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{"default https port implied", "https://host.example", "https://host.example:443"},
		{"default https port explicit", "https://host.example:443", "https://host.example:443"},
		{"default http port implied", "http://host.example", "http://host.example:80"},
		{"non-default port", "https://host.example:8443", "https://host.example:8443"},
		{"uppercase scheme and host", "HTTPS://Host.EXAMPLE/", "https://host.example:443"},
		{"path query and fragment ignored", "https://host.example/a/b?tok=secret#frag", "https://host.example:443"},
		{"trailing dot stripped", "https://host.example./", "https://host.example:443"},
		{"ipv4 literal", "http://192.168.1.10:8080", "http://192.168.1.10:8080"},
		{"ipv6 literal", "https://[2001:db8::1]:8443", "https://[2001:db8::1]:8443"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseOrigin(tt.raw)
			if err != nil {
				t.Fatalf("parseOrigin(%q): %v", tt.raw, err)
			}
			if got != tt.want {
				t.Fatalf("parseOrigin(%q) = %q, want %q", tt.raw, got, tt.want)
			}
		})
	}
}

func TestParseOriginRejects(t *testing.T) {
	tests := []struct {
		name       string
		raw        string
		wantReason string
	}{
		{"empty", "", ReasonInvalidOrigin},
		{"no scheme", "host.example", ReasonInvalidOrigin},
		{"unsupported scheme", "ftp://host.example", ReasonInvalidOrigin},
		{"file scheme", "file:///etc/passwd", ReasonInvalidOrigin},
		{"userinfo", "https://user:pass@host.example", ReasonInvalidOrigin},
		{"empty host", "https://", ReasonInvalidOrigin},
		{"bad port", "https://host.example:0", ReasonInvalidOrigin},
		{"port out of range", "https://host.example:70000", ReasonInvalidOrigin},
		{"ambiguous ip encoding", "https://[::ffff:127.0.0.1]", ReasonInvalidOrigin},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := parseOrigin(tt.raw)
			if err == nil {
				t.Fatalf("parseOrigin(%q) = %q, want error", tt.raw, got)
			}
			assertReason(t, err, tt.wantReason)
		})
	}
}

// Origin matching is exact: no wildcard, suffix, scheme or port fuzz.
func TestOriginSetMatchingIsExact(t *testing.T) {
	set, err := newOriginSet(
		[]string{"https://breeze.example", "http://breeze.lan:8080"},
		[]string{"https://repo.internal:8443"},
	)
	if err != nil {
		t.Fatalf("newOriginSet: %v", err)
	}

	allowed := []string{
		"https://breeze.example:443",
		"https://BREEZE.example:443",
		"http://breeze.lan:8080",
		"https://repo.internal:8443",
	}
	for _, raw := range allowed {
		origin, err := parseOrigin(raw)
		if err != nil {
			t.Fatalf("parseOrigin(%q): %v", raw, err)
		}
		if !set.contains(origin) {
			t.Fatalf("origin %q should be allowed", origin)
		}
	}

	denied := []string{
		"https://sub.breeze.example:443",  // suffix lookalike
		"https://breeze.example.evil:443", // prefix lookalike
		"https://breeze.example:8443",     // different port
		"http://breeze.example:80",        // different scheme
		"https://breeze.lan:8080",         // scheme mismatch on private origin
		"http://breeze.lan:8081",          // port mismatch on private origin
		"https://xn--breeze-evil.example:443",
	}
	for _, raw := range denied {
		origin, err := parseOrigin(raw)
		if err != nil {
			t.Fatalf("parseOrigin(%q): %v", raw, err)
		}
		if set.contains(origin) {
			t.Fatalf("origin %q must not be allowed", origin)
		}
	}
}

func TestNewOriginSetRejectsMalformedEntry(t *testing.T) {
	if _, err := newOriginSet([]string{"https://ok.example", "not a url"}, nil); err == nil {
		t.Fatal("newOriginSet should reject a malformed configured origin")
	}
}

func TestCheckHostShape(t *testing.T) {
	valid := []string{
		"host.example",
		"HOST.example",
		"host.example.", // trailing dot is normalized away, not rejected
		"192.168.1.10",
		"8.8.8.8",
		"2001:db8::1",
		"::1", // shape is fine; the address check rejects it at dial time
	}
	for _, h := range valid {
		if err := checkHostShape(h); err != nil {
			t.Fatalf("checkHostShape(%q) = %v, want nil", h, err)
		}
	}

	invalid := []struct {
		host       string
		wantReason string
	}{
		{"", ReasonEmptyHost},
		{"::ffff:127.0.0.1", ReasonAmbiguousIPEncoding},
		{"::ffff:8.8.8.8", ReasonAmbiguousIPEncoding},
		{"fe80::1%eth0", ReasonAmbiguousIPEncoding},
		{"2001:0db8::1", ReasonAmbiguousIPEncoding},    // non-canonical text
		{"0:0:0:0:0:0:0:1", ReasonAmbiguousIPEncoding}, // non-canonical text
		{"2130706433", ReasonAmbiguousIPEncoding},      // decimal IPv4
		{"0177.0.0.1", ReasonAmbiguousIPEncoding},      // octal IPv4
		{"0x7f.0.0.1", ReasonAmbiguousIPEncoding},      // hex IPv4
		{"127.1", ReasonAmbiguousIPEncoding},           // short-form IPv4
		{"host..example", ReasonInvalidHostname},       // empty label
		{".host.example", ReasonInvalidHostname},       // leading empty label
	}
	for _, tt := range invalid {
		t.Run(tt.host, func(t *testing.T) {
			assertReason(t, checkHostShape(tt.host), tt.wantReason)
		})
	}
}

func TestForbiddenHostname(t *testing.T) {
	forbidden := []string{
		"metadata.google.internal",
		"METADATA.GOOGLE.INTERNAL",
		"metadata.google.internal.",
		// Extra root dots must not be a bypass spelling for the map lookup.
		"metadata.google.internal..",
		"Metadata.Google.Internal...",
	}
	for _, h := range forbidden {
		if !isForbiddenHostname(normalizeHostname(h)) {
			t.Fatalf("hostname %q must be forbidden", h)
		}
	}
	allowed := []string{"metadata.google.internal.example.com", "google.internal", "metadata.example"}
	for _, h := range allowed {
		if isForbiddenHostname(normalizeHostname(h)) {
			t.Fatalf("hostname %q must not be forbidden", h)
		}
	}
}
