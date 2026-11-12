package tunnel

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// AllowlistRule represents a CIDR + port range rule.
// Pattern format: "CIDR:portRange" — e.g. "192.168.0.0/16:80-443", "10.0.0.0/8:*"
type AllowlistRule struct {
	Network  *net.IPNet
	PortMin  int
	PortMax  int
	AllPorts bool
}

// Hardcoded blocked networks — cannot be allowlisted regardless of rules.
// Pre-parsed at init to avoid repeated net.ParseCIDR calls on every check.
var blockedNetworks []struct {
	network *net.IPNet
	reason  string
}

// lookupIP resolves a destination host name. A variable so tests can supply
// fixed address sets.
var lookupIP = net.LookupIP

func init() {
	raw := []struct{ cidr, reason string }{
		{"127.0.0.0/8", "localhost"},
		{"::1/128", "localhost"},
		{"169.254.0.0/16", "link-local / cloud metadata (SSRF)"},
		{"fe80::/10", "link-local"},
		{"fd00:ec2::254/128", "cloud metadata"},
		{"fd20:ce::254/128", "cloud metadata"},
		{"0.0.0.0/32", "wildcard bind"},
		{"::/128", "wildcard bind"},
	}
	for _, r := range raw {
		_, network, err := net.ParseCIDR(r.cidr)
		if err != nil {
			panic("invalid blocked CIDR: " + r.cidr)
		}
		blockedNetworks = append(blockedNetworks, struct {
			network *net.IPNet
			reason  string
		}{network, r.reason})
	}
}

// ParseAllowlistRule parses a "CIDR:portRange" pattern. The address is an
// IPv4 or IPv6 address or CIDR; the port part follows the last colon.
// Examples: "192.168.0.0/16:80-443", "10.0.0.5/32:9090", "172.16.0.0/12:*",
// "2001:db8::/32:443", "2001:db8::1:22"
func ParseAllowlistRule(pattern string) (AllowlistRule, error) {
	sep := strings.LastIndex(pattern, ":")
	if sep <= 0 || sep == len(pattern)-1 {
		return AllowlistRule{}, fmt.Errorf("invalid pattern %q: expected CIDR:portRange", pattern)
	}

	cidr := pattern[:sep]
	portPart := pattern[sep+1:]
	if portPart != "*" && strings.IndexFunc(portPart, func(r rune) bool {
		return (r < '0' || r > '9') && r != '-'
	}) >= 0 {
		return AllowlistRule{}, fmt.Errorf("invalid port range %q", portPart)
	}

	// If CIDR is a single IP without mask, add /32 or /128.
	if !strings.Contains(cidr, "/") {
		if strings.Contains(cidr, ":") {
			cidr += "/128"
		} else {
			cidr += "/32"
		}
	}

	ip, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return AllowlistRule{}, fmt.Errorf("invalid CIDR %q: %w", cidr, err)
	}
	// An IPv6 prefix must be written as its network address, so a host address
	// with a short prefix length (for example "2001:db8::5/32") is not silently
	// widened to the whole prefix.
	if strings.Contains(cidr, ":") && !ip.Equal(network.IP) {
		return AllowlistRule{}, fmt.Errorf("invalid CIDR %q: address has bits set beyond the prefix length", cidr)
	}

	rule := AllowlistRule{Network: network}

	if portPart == "*" {
		rule.AllPorts = true
	} else if strings.Contains(portPart, "-") {
		rangeParts := strings.SplitN(portPart, "-", 2)
		rule.PortMin, err = strconv.Atoi(rangeParts[0])
		if err != nil {
			return AllowlistRule{}, fmt.Errorf("invalid port min %q: %w", rangeParts[0], err)
		}
		rule.PortMax, err = strconv.Atoi(rangeParts[1])
		if err != nil {
			return AllowlistRule{}, fmt.Errorf("invalid port max %q: %w", rangeParts[1], err)
		}
		if rule.PortMin > rule.PortMax || rule.PortMin < 1 || rule.PortMax > 65535 {
			return AllowlistRule{}, fmt.Errorf("invalid port range %d-%d", rule.PortMin, rule.PortMax)
		}
	} else {
		port, err := strconv.Atoi(portPart)
		if err != nil {
			return AllowlistRule{}, fmt.Errorf("invalid port %q: %w", portPart, err)
		}
		if port < 1 || port > 65535 {
			return AllowlistRule{}, fmt.Errorf("port %d out of range", port)
		}
		rule.PortMin = port
		rule.PortMax = port
	}

	return rule, nil
}

// Matches returns true if the given host:port matches this rule.
func (r AllowlistRule) Matches(ip net.IP, port int) bool {
	if !r.Network.Contains(ip) {
		return false
	}
	if r.AllPorts {
		return true
	}
	return port >= r.PortMin && port <= r.PortMax
}

// resolveAddresses returns the literal address, or every address the name
// resolves to.
func resolveAddresses(host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	ips, err := lookupIP(host)
	if err != nil {
		return nil, err
	}
	if len(ips) == 0 {
		return nil, fmt.Errorf("no addresses for %q", host)
	}
	return ips, nil
}

// isLocalVNCEndpoint reports whether a VNC tunnel targets the one local
// endpoint the platform uses for VNC relay.
func isLocalVNCEndpoint(host string, port int, isVNC bool) bool {
	return isVNC && host == "127.0.0.1" && port == 5900
}

// blockedAddress checks one address against the hardcoded deny list.
func blockedAddress(ip net.IP, localVNC bool) (bool, string) {
	if ip.Equal(net.IPv6zero) || ip.Equal(net.IPv4zero) {
		return true, "wildcard bind address"
	}
	for _, b := range blockedNetworks {
		if b.network.Contains(ip) {
			// Special exception: VNC is allowed on 127.0.0.1:5900 only.
			if localVNC && ip.Equal(net.IPv4(127, 0, 0, 1)) {
				continue
			}
			return true, b.reason
		}
	}
	return false, ""
}

func permittedAddress(ip net.IP, port int, rules []AllowlistRule) bool {
	for _, r := range rules {
		if r.Matches(ip, port) {
			return true
		}
	}
	return false
}

// IsBlocked returns true if the target, or any address it resolves to, is on
// the hardcoded deny list. VNC (127.0.0.1:5900) is the only exception to the
// localhost block.
func IsBlocked(host string, port int, isVNC bool) (bool, string) {
	ips, err := resolveAddresses(host)
	if err != nil {
		return true, "unresolvable hostname"
	}
	localVNC := isLocalVNCEndpoint(host, port, isVNC)
	for _, ip := range ips {
		if blocked, reason := blockedAddress(ip, localVNC); blocked {
			return true, reason
		}
	}
	return false, ""
}

// IsAllowed checks the target against the allowlist rules. Every address the
// target resolves to must be permitted by at least one rule.
func IsAllowed(host string, port int, rules []AllowlistRule) bool {
	ips, err := resolveAddresses(host)
	if err != nil {
		return false
	}
	for _, ip := range ips {
		if !permittedAddress(ip, port, rules) {
			return false
		}
	}
	return true
}

// ResolveDestination validates a tunnel destination and returns the numeric
// address to dial. Every address the host resolves to must pass the deny list
// and, unless the target is the local VNC endpoint, the allowlist rules.
// Callers dial the returned address so the connection goes to an address that
// was checked, not to a fresh resolution of the name.
func ResolveDestination(host string, port int, isVNC bool, rules []AllowlistRule) (string, error) {
	if port < 1 || port > 65535 {
		return "", fmt.Errorf("target %s:%d is not a valid destination", host, port)
	}
	target := net.JoinHostPort(host, strconv.Itoa(port))
	ips, err := resolveAddresses(host)
	if err != nil {
		return "", fmt.Errorf("target %s is blocked: unresolvable hostname", target)
	}
	localVNC := isLocalVNCEndpoint(host, port, isVNC)
	for _, ip := range ips {
		if blocked, reason := blockedAddress(ip, localVNC); blocked {
			return "", fmt.Errorf("target %s is blocked: %s", target, reason)
		}
		if !localVNC && !permittedAddress(ip, port, rules) {
			return "", fmt.Errorf("target %s not permitted by allowlist", target)
		}
	}
	return ips[0].String(), nil
}
