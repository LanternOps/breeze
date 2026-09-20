package networkcontext

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"unicode/utf8"
)

func validKey(s string) bool {
	return s != "" && len(s) <= 255 && utf8.ValidString(s) && !strings.ContainsAny(s, "\x00\r\n")
}
func ptr[T any](v T) *T { return &v }
func Family(ip netip.Addr) string {
	if ip.Is4() {
		return "ipv4"
	}
	return "ipv6"
}
func normalizeIP(raw string, zone *string) (string, *string, error) {
	ip, err := netip.ParseAddr(raw)
	if err != nil {
		return "", nil, ErrMalformed
	}
	if ip.Zone() != "" {
		if zone != nil && *zone != ip.Zone() {
			return "", nil, ErrMalformed
		}
		zone = ptr(ip.Zone())
		ip = ip.WithZone("")
	}
	if ip.Is4In6() {
		ip = ip.Unmap()
	}
	if zone != nil && (!ip.Is6() || !validKey(*zone)) {
		return "", nil, ErrMalformed
	}
	if ip.IsLinkLocalUnicast() && ip.Is6() && zone == nil {
		return "", nil, ErrMalformed
	}
	return ip.String(), zone, nil
}
func normalizeMAC(raw string) (string, error) {
	m, e := net.ParseMAC(raw)
	if e != nil || len(m) != 6 {
		return "", ErrMalformed
	}
	return m.String(), nil
}
func rowIdentity(v any) string {
	b, _ := json.Marshal(v)
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// NormalizeRoutes preserves every distinct scoped route, including equal-cost
// alternatives. No metric comparison is an OS route selection substitute.
func NormalizeRoutes(rows []RouteRow) ([]RouteRow, error) {
	out := make([]RouteRow, 0, len(rows))
	seen := map[string]bool{}
	for _, r := range rows {
		prefix, e := netip.ParsePrefix(r.DestinationPrefix)
		if e != nil || Family(prefix.Addr()) != r.Family {
			return nil, ErrMalformed
		}
		r.DestinationPrefix = prefix.Masked().String()
		if !validKey(r.TableKey) {
			return nil, ErrMalformed
		}
		if r.InterfaceKey != nil && !validKey(*r.InterfaceKey) {
			return nil, ErrMalformed
		}
		if r.SourcePrefix != "" {
			p, e := netip.ParsePrefix(r.SourcePrefix)
			if e != nil || Family(p.Addr()) != r.Family {
				return nil, ErrMalformed
			}
			r.SourcePrefix = p.Masked().String()
		}
		if len(r.NextHops) > 64 {
			return nil, ErrLimit
		}
		if r.NextHops == nil {
			r.NextHops = []NextHop{}
		}
		for i, h := range r.NextHops {
			if h.Address != nil {
				a, z, e := normalizeIP(*h.Address, h.Zone)
				if e != nil {
					return nil, e
				}
				ip, _ := netip.ParseAddr(a)
				if Family(ip) != r.Family {
					return nil, ErrMalformed
				}
				h.Address = ptr(a)
				h.Zone = z
			} else if h.Zone != nil || (r.RouteType != "on_link" && h.InterfaceKey == nil && r.InterfaceKey == nil) {
				return nil, ErrMalformed
			}
			if h.InterfaceKey != nil && !validKey(*h.InterfaceKey) {
				return nil, ErrMalformed
			}
			r.NextHops[i] = h
		}
		sort.Slice(r.NextHops, func(i, j int) bool { return rowIdentity(r.NextHops[i]) < rowIdentity(r.NextHops[j]) })
		r.RowKey = ""
		r.RowKey = rowIdentity(r)
		if !seen[r.RowKey] {
			seen[r.RowKey] = true
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RowKey < out[j].RowKey })
	return out, nil
}
func NormalizeInterfaces(rows []InterfaceRow) ([]InterfaceRow, error) {
	out := make([]InterfaceRow, 0, len(rows))
	seen := map[string]bool{}
	addressCount := 0
	limited := false
	for _, r := range rows {
		if !validKey(r.InterfaceKey) || !validKey(r.Name) || seen[r.InterfaceKey] {
			return nil, ErrMalformed
		}
		seen[r.InterfaceKey] = true
		r.RowKey = r.InterfaceKey
		if r.Addresses == nil {
			r.Addresses = []AddressRow{}
		}
		for i, a := range r.Addresses {
			raw, zone, e := normalizeIP(a.Address, a.Zone)
			if e != nil {
				return nil, e
			}
			ip, _ := netip.ParseAddr(raw)
			if Family(ip) != a.Family || int(a.PrefixLength) > ip.BitLen() {
				return nil, ErrMalformed
			}
			a.Address, a.Zone = raw, zone
			r.Addresses[i] = a
		}
		if len(r.Addresses) > 1024-addressCount {
			r.Addresses = r.Addresses[:1024-addressCount]
			limited = true
		}
		addressCount += len(r.Addresses)
		sort.Slice(r.Addresses, func(i, j int) bool { return rowIdentity(r.Addresses[i]) < rowIdentity(r.Addresses[j]) })
		var e error
		if r.CurrentMAC != "" {
			r.CurrentMAC, e = normalizeMAC(r.CurrentMAC)
			if e != nil {
				return nil, e
			}
		}
		if r.PermanentMAC != "" {
			r.PermanentMAC, e = normalizeMAC(r.PermanentMAC)
			if e != nil {
				return nil, e
			}
		}
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].RowKey < out[j].RowKey })
	if limited {
		return out, ErrLimit
	}
	return out, nil
}

// ScopeKey uses a JSON tuple so delimiter-bearing native names cannot collide.
func ScopeKey(namespace, table, iface, family string) string {
	b, _ := json.Marshal([]string{namespace, table, iface, family})
	return string(b)
}
func requireSize(v any) error {
	b, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if len(b) > MaxEnvelopeBytes {
		return fmt.Errorf("envelope: %w", ErrLimit)
	}
	return nil
}
