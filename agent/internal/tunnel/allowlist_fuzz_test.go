package tunnel

import (
	"net"
	"testing"
)

// FuzzParseAllowlistRule checks the tunnel allowlist parser. An accepted rule
// must have a network and either allow all ports or a port range inside
// 1..65535 with min <= max, and Matches must agree with that range.
func FuzzParseAllowlistRule(f *testing.F) {
	f.Add("192.168.0.0/16:80-443", 443)
	f.Add("10.0.0.5/32:9090", 443)
	f.Add("172.16.0.0/12:*", 443)
	f.Add("10.0.0.1:0", 443)
	f.Add("10.0.0.1:65536", 443)
	f.Add("10.0.0.0/8:443-80", 443)
	f.Add("::1:22", 443)

	f.Fuzz(func(t *testing.T, pattern string, port int) {
		rule, err := ParseAllowlistRule(pattern)
		if err != nil {
			return
		}
		if rule.Network == nil {
			t.Fatalf("%q accepted with nil network", pattern)
		}
		if !rule.AllPorts && (rule.PortMin < 1 || rule.PortMax > 65535 || rule.PortMin > rule.PortMax) {
			t.Fatalf("%q accepted with port range %d-%d", pattern, rule.PortMin, rule.PortMax)
		}
		ip := rule.Network.IP
		inRange := rule.AllPorts || (port >= rule.PortMin && port <= rule.PortMax)
		if rule.Matches(ip, port) != inRange {
			t.Fatalf("%q: Matches(%v, %d) disagrees with the parsed range", pattern, ip, port)
		}
		if outside := lastAddrPlusOne(rule.Network); outside != nil && rule.Matches(outside, port) {
			t.Fatalf("%q matched %v, outside its network", pattern, outside)
		}
	})
}

// lastAddrPlusOne returns the first address after the network, or nil when the
// network already ends at the top of the address space.
func lastAddrPlusOne(n *net.IPNet) net.IP {
	ip := make(net.IP, len(n.IP))
	for i := range ip {
		ip[i] = n.IP[i] | ^n.Mask[i]
	}
	for i := len(ip) - 1; i >= 0; i-- {
		ip[i]++
		if ip[i] != 0 {
			return ip
		}
	}
	return nil
}
