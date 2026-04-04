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

func init() {
	raw := []struct{ cidr, reason string }{
		{"127.0.0.0/8", "localhost"},
		{"169.254.0.0/16", "link-local / cloud metadata (SSRF)"},
		{"0.0.0.0/32", "wildcard bind"},
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

// ParseAllowlistRule parses a "CIDR:portRange" pattern.
// Examples: "192.168.0.0/16:80-443", "10.0.0.5/32:9090", "172.16.0.0/12:*"
func ParseAllowlistRule(pattern string) (AllowlistRule, error) {
	parts := strings.SplitN(pattern, ":", 2)
	if len(parts) != 2 {
		return AllowlistRule{}, fmt.Errorf("invalid pattern %q: expected CIDR:portRange", pattern)
	}

	cidr := parts[0]
	portPart := parts[1]

	// If CIDR is a single IP without mask, add /32 or /128.
	if !strings.Contains(cidr, "/") {
		if strings.Contains(cidr, ":") {
			cidr += "/128"
		} else {
			cidr += "/32"
		}
	}

	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return AllowlistRule{}, fmt.Errorf("invalid CIDR %q: %w", cidr, err)
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

// IsBlocked returns true if the target is on the hardcoded deny list.
// VNC (127.0.0.1:5900) is the only exception to the localhost block.
func IsBlocked(host string, port int, isVNC bool) (bool, string) {
	ip := net.ParseIP(host)
	if ip == nil {
		// Attempt to resolve hostname.
		ips, err := net.LookupIP(host)
		if err != nil || len(ips) == 0 {
			return true, "unresolvable hostname"
		}
		ip = ips[0]
	}

	// Check for IPv6 wildcard.
	if ip.Equal(net.IPv6zero) {
		return true, "wildcard bind address"
	}

	for _, b := range blockedNetworks {
		if b.network.Contains(ip) {
			// Special exception: VNC is allowed on 127.0.0.1:5900 only.
			if isVNC && b.network.String() == "127.0.0.0/8" && ip.Equal(net.IPv4(127, 0, 0, 1)) && port == 5900 {
				continue
			}
			return true, b.reason
		}
	}

	return false, ""
}

// IsAllowed checks the target against the allowlist rules.
// Returns true if at least one rule permits the target.
func IsAllowed(host string, port int, rules []AllowlistRule) bool {
	ip := net.ParseIP(host)
	if ip == nil {
		ips, err := net.LookupIP(host)
		if err != nil || len(ips) == 0 {
			return false
		}
		ip = ips[0]
	}

	for _, r := range rules {
		if r.Matches(ip, port) {
			return true
		}
	}

	return false
}
