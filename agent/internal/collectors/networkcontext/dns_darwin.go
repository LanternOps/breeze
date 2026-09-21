//go:build darwin

package networkcontext

import (
	"bufio"
	"bytes"
	"context"
	"net/netip"
	"strconv"
	"strings"
)

// ParseScopedDNS consumes only the fixed scutil --dns schema. Missing scope or
// malformed fields lower completeness rather than fabricating empty DNS state.
func ParseScopedDNS(raw []byte) ResolverSection {
	out := ResolverSection{Rows: []ResolverRow{}, Outcome: Complete}
	if len(raw) > 1024*1024 {
		out.Outcome = Partial
		out.ReasonCode = "limit_exceeded"
		return out
	}
	type block struct {
		addresses []string
		domains   []Domain
		index     int
		invalid   bool
		seen      bool
	}
	b := block{}
	flush := func() {
		if !b.seen {
			return
		}
		if b.invalid {
			out.Outcome = Partial
			out.ReasonCode = "malformed"
		}
		for _, value := range b.addresses {
			ip, e := netip.ParseAddr(value)
			if e != nil {
				out.Outcome = Partial
				out.ReasonCode = "malformed"
				continue
			}
			var iface, zone *string
			if b.index > 0 {
				iface = ptr(darwinIndexKey(b.index))
			}
			if ip.Zone() != "" {
				zone = ptr(ip.Zone())
				ip = ip.WithZone("")
			}
			if ip.Is6() && ip.IsLinkLocalUnicast() {
				if iface == nil {
					out.Outcome = Partial
					out.ReasonCode = "resolver_scope_unknown"
					continue
				}
				zone = iface
			}
			domains := append([]Domain{}, b.domains...)
			r := ResolverRow{Address: ip.String(), Zone: zone, InterfaceKey: iface, IsLocalStub: ip.IsLoopback(), Port: 53, Transport: "udp_tcp", Domains: domains, Mechanism: "scutil"}
			r.RowKey = rowIdentity(r)
			out.Rows = append(out.Rows, r)
		}
		b = block{}
	}
	scanner := bufio.NewScanner(bytes.NewReader(raw))
	scanner.Buffer(make([]byte, 4096), 64*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "resolver #") {
			flush()
			b.seen = true
			continue
		}
		if !b.seen {
			continue
		}
		parts := strings.SplitN(line, ":", 2)
		if len(parts) != 2 {
			continue
		}
		key, value := strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
		switch {
		case strings.HasPrefix(key, "nameserver["):
			b.addresses = append(b.addresses, value)
		case key == "if_index":
			fields := strings.Fields(value)
			if len(fields) == 0 {
				b.invalid = true
				continue
			}
			n, e := strconv.Atoi(fields[0])
			if e != nil || n <= 0 {
				b.invalid = true
			} else {
				b.index = n
			}
		case key == "domain":
			if value != "" {
				b.domains = append(b.domains, Domain{Name: value, RouteOnly: true})
			} else {
				b.invalid = true
			}
		case strings.HasPrefix(key, "search domain["):
			if value != "" {
				b.domains = append(b.domains, Domain{Name: value})
			} else {
				b.invalid = true
			}
		}
	}
	flush()
	if scanner.Err() != nil {
		out.Outcome = Partial
		out.ReasonCode = "malformed"
	}
	if len(out.Rows) == 0 && !strings.Contains(string(raw), "No DNS configuration available") {
		out.Outcome = Partial
		out.ReasonCode = "resolver_read_incomplete"
	}
	out.RowCount = len(out.Rows)
	return out
}
func ReadScopedDNS(ctx context.Context, runner CommandRunner) (ResolverSection, error) {
	b, e := runner.Output(ctx, "/usr/sbin/scutil", "--dns")
	if e != nil {
		return ResolverSection{Outcome: Failed, ReasonCode: "resolver_read_failed"}, e
	}
	s := ParseScopedDNS(b)
	return s, nil
}
