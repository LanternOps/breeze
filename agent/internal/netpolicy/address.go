package netpolicy

import (
	"net/netip"
	"net/url"
	"strconv"
	"strings"
)

// PolicyError is the only error type this package originates. It carries a
// bounded reason constant and nothing else: reasons are surfaced in structured
// security logs, and the values that would be most useful to an attacker
// reading those logs (resolved private addresses, download URLs carrying
// capability query strings, bearer material) must never reach a log line
// through an error string.
type PolicyError struct {
	Reason string
}

func (e *PolicyError) Error() string { return "netpolicy: " + e.Reason }

// Is lets callers match with errors.Is against a sentinel carrying the same
// reason (e.g. errors.Is(err, ErrResponseTooLarge)).
func (e *PolicyError) Is(target error) bool {
	t, ok := target.(*PolicyError)
	return ok && t.Reason == e.Reason
}

// Reason constants are a closed set. Callers must not invent new reasons or
// attach free-form text.
const (
	ReasonMalformedURL             = "malformed_url"
	ReasonSchemeNotAllowed         = "scheme_not_allowed"
	ReasonEmptyHost                = "empty_host"
	ReasonUserinfoPresent          = "userinfo_present"
	ReasonInvalidPort              = "invalid_port"
	ReasonAmbiguousIPEncoding      = "ambiguous_ip_encoding"
	ReasonInvalidHostname          = "invalid_hostname"
	ReasonForbiddenHostname        = "forbidden_hostname"
	ReasonCleartextNotAllowed      = "cleartext_not_allowed"
	ReasonInvalidOrigin            = "invalid_origin"
	ReasonInvalidPolicy            = "invalid_policy"
	ReasonResolutionFailed         = "resolution_failed"
	ReasonNoAddresses              = "no_addresses"
	ReasonForbiddenAddress         = "forbidden_address"
	ReasonPrivateAddressNotAllowed = "private_address_not_allowed"
	ReasonTooManyRedirects         = "too_many_redirects"
	ReasonSchemeDowngrade          = "scheme_downgrade"
	ReasonDialFailed               = "dial_failed"
	ReasonResponseTooLarge         = "response_too_large"
	ReasonInvalidBound             = "invalid_bound"
)

// addressClass ranks a destination address. The values are ordered by
// severity so a composite classification can take the worst of two readings.
type addressClass uint8

const (
	// classPublic is a globally routable destination.
	classPublic addressClass = iota
	// classPrivate is RFC1918 or IPv6 ULA: reachable only from inside the
	// customer network, and permitted only when the exact request origin is a
	// configured control-plane origin or an approved private origin.
	classPrivate
	// classForbidden is universally unsafe and is NEVER allowlistable by any
	// Policy field: loopback, link-local unicast/multicast, unspecified,
	// multicast, and cloud metadata endpoints.
	classForbidden
)

func (c addressClass) String() string {
	switch c {
	case classPublic:
		return "public"
	case classPrivate:
		return "private"
	case classForbidden:
		return "forbidden"
	}
	return "unknown"
}

// metadataAddresses are instance-metadata endpoints that must never be dialed.
// 169.254.169.254 (EC2/Azure/GCP/DO) and 169.254.170.2 (ECS task metadata) are
// already link-local, but they are listed explicitly so the deny set survives
// any future change to the link-local handling. 100.100.100.200 (Alibaba) sits
// in the CGNAT range and is NOT otherwise covered.
var metadataAddresses = []netip.Addr{
	netip.MustParseAddr("169.254.169.254"),
	netip.MustParseAddr("169.254.170.2"),
	netip.MustParseAddr("100.100.100.200"),
}

// forbiddenHostnames are names that must never be dialed regardless of what
// they resolve to. metadata.google.internal is the brief's named case: a
// hostile resolver could answer it with anything, and the name itself is the
// signal.
var forbiddenHostnames = map[string]struct{}{
	"metadata.google.internal": {},
}

// IPv6 prefixes that embed an IPv4 address in their text form. An attacker who
// cannot get a raw 127.0.0.1 past the classifier will otherwise try the same
// destination wrapped in one of these. IPv4-mapped (::ffff:0:0/96) is absent
// because classifyAddress unmaps before classifying.
var (
	prefix6to4       = netip.MustParsePrefix("2002::/16")       // RFC 3056
	prefixTeredo     = netip.MustParsePrefix("2001::/32")       // RFC 4380
	prefixNAT64      = netip.MustParsePrefix("64:ff9b::/96")    // RFC 6052 well-known
	prefixV4Compat   = netip.MustParsePrefix("::/96")           // RFC 4291 IPv4-compatible (deprecated)
	prefixV4Translat = netip.MustParsePrefix("::ffff:0:0:0/96") // RFC 6145 IPv4-translated
)

// reservedForbiddenPrefixes are ranges that are reachable on a real network but
// are never a legitimate download source. They are forbidden outright,
// alongside the named classes, and no Policy field can re-enable them.
// 255.255.255.255 falls inside 240.0.0.0/4 and is additionally excluded by the
// IsGlobalUnicast test below.
var reservedForbiddenPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),     // RFC 1122 "this network"
	netip.MustParsePrefix("192.0.0.0/24"),  // RFC 6890 IETF protocol assignments
	netip.MustParsePrefix("198.18.0.0/15"), // RFC 2544 benchmarking
	netip.MustParsePrefix("240.0.0.0/4"),   // RFC 1112 reserved, incl. 255.255.255.255
}

// prefixCGNAT is RFC 6598 carrier-grade NAT space. It is also Tailscale's
// range, so a tailnet-joined endpoint would otherwise be an SSRF pivot onto
// arbitrary tailnet peers. A legitimate CDN is never CGNAT, so it is gated by
// exact-origin approval exactly like RFC1918 and ULA rather than banned.
var prefixCGNAT = netip.MustParsePrefix("100.64.0.0/10")

// classifyAddress classifies a resolved address by its effective destination,
// not its text form: an IPv4-mapped, 6to4, Teredo or NAT64 encoding is
// classified as the worst of the wrapper and the IPv4 address it carries.
func classifyAddress(a netip.Addr) addressClass {
	if !a.IsValid() {
		return classForbidden
	}
	worst := classifyEffective(a.Unmap())
	if v4, ok := embeddedIPv4(a); ok {
		if c := classifyEffective(v4); c > worst {
			worst = c
		}
	}
	return worst
}

// classifyEffective is a POSITIVE test: an address has to earn "public" by
// being global unicast and outside every reserved range. A closed deny list
// leaves whatever it forgets dialable, which is the wrong failure direction for
// a package that assumes its input is hostile.
//
// IsGlobalUnicast already excludes unspecified, loopback, multicast (including
// link-local and interface-local) and link-local unicast, plus the IPv4
// broadcast address.
func classifyEffective(a netip.Addr) addressClass {
	if !a.IsGlobalUnicast() {
		return classForbidden
	}
	for _, m := range metadataAddresses {
		if a == m {
			return classForbidden
		}
	}
	for _, p := range reservedForbiddenPrefixes {
		if p.Contains(a) {
			return classForbidden
		}
	}
	if a.IsPrivate() || prefixCGNAT.Contains(a) {
		return classPrivate
	}
	return classPublic
}

// embeddedIPv4 extracts the IPv4 address carried inside an IPv6 transition
// encoding, if any. IPv4-mapped addresses are handled by Unmap and are
// deliberately not repeated here.
func embeddedIPv4(a netip.Addr) (netip.Addr, bool) {
	if !a.Is6() || a.Is4In6() {
		return netip.Addr{}, false
	}
	b := a.As16()
	switch {
	case prefix6to4.Contains(a):
		return netip.AddrFrom4([4]byte{b[2], b[3], b[4], b[5]}), true
	case prefixTeredo.Contains(a):
		return netip.AddrFrom4([4]byte{^b[12], ^b[13], ^b[14], ^b[15]}), true
	case prefixNAT64.Contains(a), prefixV4Compat.Contains(a), prefixV4Translat.Contains(a):
		return netip.AddrFrom4([4]byte{b[12], b[13], b[14], b[15]}), true
	}
	return netip.Addr{}, false
}

// validateResolution accepts or rejects a DNS answer as a whole. A single
// unsafe answer poisons the entire set: an attacker who can return one good
// and one bad address must not get a coin flip at dial time.
//
// privateAllowed is true only when the exact request origin is a configured
// control-plane origin or an approved private origin. It never relaxes the
// universally-unsafe classes.
func validateResolution(addrs []netip.Addr, privateAllowed bool) error {
	if len(addrs) == 0 {
		return &PolicyError{Reason: ReasonNoAddresses}
	}
	sawPrivate := false
	for _, a := range addrs {
		switch classifyAddress(a) {
		case classForbidden:
			return &PolicyError{Reason: ReasonForbiddenAddress}
		case classPrivate:
			sawPrivate = true
		}
	}
	if sawPrivate && !privateAllowed {
		return &PolicyError{Reason: ReasonPrivateAddressNotAllowed}
	}
	return nil
}

// normalizeHostname lowercases a host and drops every trailing root dot so that
// "Host.Example.", "host.example.." and "host.example" all compare equal. A
// single TrimSuffix would let "metadata.google.internal.." slip past the
// forbidden-hostname map.
func normalizeHostname(host string) string {
	h := strings.ToLower(strings.TrimSpace(host))
	return strings.TrimRight(h, ".")
}

func isForbiddenHostname(normalized string) bool {
	_, ok := forbiddenHostnames[normalized]
	return ok
}

// checkHostShape validates the textual form of a host. It performs no DNS:
// address classification happens at dial time against the resolved answers.
// Any IP literal must be in canonical, unambiguous form — a zone identifier,
// an IPv4-in-IPv6 encoding, a non-canonical text form, or a numeric host that
// is not a valid IP (decimal, octal or hex IPv4 shorthand) is rejected so that
// the string this package classifies is the string the kernel would dial.
func checkHostShape(host string) error {
	if strings.TrimSpace(host) == "" {
		return &PolicyError{Reason: ReasonEmptyHost}
	}
	h := normalizeHostname(host)
	if h == "" {
		return &PolicyError{Reason: ReasonEmptyHost}
	}
	if a, err := netip.ParseAddr(h); err == nil {
		if a.Zone() != "" || a.Is4In6() || a.String() != h {
			return &PolicyError{Reason: ReasonAmbiguousIPEncoding}
		}
		return nil
	}
	if isNumericLookingHost(h) {
		return &PolicyError{Reason: ReasonAmbiguousIPEncoding}
	}
	// An empty label ("host..example", ".host") is not a valid DNS name, and
	// tolerating one would give every hostname-level control a trivial bypass
	// spelling.
	if strings.HasPrefix(h, ".") || strings.Contains(h, "..") {
		return &PolicyError{Reason: ReasonInvalidHostname}
	}
	return nil
}

// isNumericLookingHost reports whether a host that failed IP parsing is still
// an attempt at writing an IPv4 address (e.g. "2130706433", "0177.0.0.1",
// "0x7f.0.0.1", "127.1"). Such a host must not be handed to a resolver.
func isNumericLookingHost(h string) bool {
	// Hex letters are only treated as part of a numeric host when the string
	// actually carries a "0x" marker, so real names like "beef.cafe" are not
	// mistaken for IPv4 shorthand.
	hexMarker := strings.Contains(h, "0x") || strings.Contains(h, "0X")
	hasDigit := false
	for _, r := range h {
		switch {
		case r >= '0' && r <= '9':
			hasDigit = true
		case r == '.', r == 'x', r == 'X':
		case hexMarker && (r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F'):
		default:
			return false
		}
	}
	return hasDigit
}

// effectivePort returns the port an origin comparison should use, filling in
// the scheme default when the URL omits it.
func effectivePort(scheme, port string) (string, error) {
	if port == "" {
		switch scheme {
		case "http":
			return "80", nil
		case "https":
			return "443", nil
		}
		return "", &PolicyError{Reason: ReasonSchemeNotAllowed}
	}
	n, err := strconv.Atoi(port)
	if err != nil || n < 1 || n > 65535 {
		return "", &PolicyError{Reason: ReasonInvalidPort}
	}
	return strconv.Itoa(n), nil
}

// originFromURL renders the normalized origin of u as
// "scheme://hostname:effective-port": lowercase scheme and DNS name, no
// userinfo, no path, no query, no fragment. Comparison of two such strings is
// exact — there is no wildcard or suffix matching anywhere in this package.
func originFromURL(u *url.URL) (string, error) {
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return "", &PolicyError{Reason: ReasonSchemeNotAllowed}
	}
	if u.User != nil {
		return "", &PolicyError{Reason: ReasonUserinfoPresent}
	}
	host := normalizeHostname(u.Hostname())
	if err := checkHostShape(host); err != nil {
		return "", err
	}
	port, err := effectivePort(scheme, u.Port())
	if err != nil {
		return "", err
	}
	if a, err := netip.ParseAddr(host); err == nil && a.Is6() {
		host = "[" + host + "]"
	}
	return scheme + "://" + host + ":" + port, nil
}

// parseOrigin normalizes a configured origin string. Every failure collapses
// to ReasonInvalidOrigin because these values come from configuration, not
// from a request. It performs no DNS.
func parseOrigin(raw string) (string, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", &PolicyError{Reason: ReasonInvalidOrigin}
	}
	origin, err := originFromURL(u)
	if err != nil {
		return "", &PolicyError{Reason: ReasonInvalidOrigin}
	}
	return origin, nil
}

// originSet is a set of normalized origins matched by exact string equality.
type originSet map[string]struct{}

// newOriginSet normalizes every configured origin up front so a malformed
// entry fails at client construction rather than at dial time. Blank entries
// are ignored.
func newOriginSet(lists ...[]string) (originSet, error) {
	set := make(originSet)
	for _, list := range lists {
		for _, raw := range list {
			if strings.TrimSpace(raw) == "" {
				continue
			}
			origin, err := parseOrigin(raw)
			if err != nil {
				return nil, err
			}
			set[origin] = struct{}{}
		}
	}
	return set, nil
}

func (s originSet) contains(origin string) bool {
	if origin == "" {
		return false
	}
	_, ok := s[origin]
	return ok
}
