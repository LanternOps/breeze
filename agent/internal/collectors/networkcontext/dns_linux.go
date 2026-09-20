//go:build linux

package networkcontext

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/netip"
	"os"
	"strconv"
	"strings"
)

func busProperty(ctx context.Context, runner CommandRunner, service, path, iface, property string) (any, error) {
	b, e := runner.Output(ctx, "/usr/bin/busctl", "--system", "--json=short", "get-property", service, path, iface, property)
	if e != nil {
		return nil, e
	}
	var reply struct {
		Type string `json:"type"`
		Data []any  `json:"data"`
	}
	if e = json.Unmarshal(b, &reply); e != nil || len(reply.Data) != 1 {
		return nil, ErrMalformed
	}
	return reply.Data[0], nil
}
func parseResolvedDNS(value, domains any) ([]ResolverRow, error) {
	entries, ok := value.([]any)
	if !ok {
		return nil, ErrMalformed
	}
	domainRows, ok := domains.([]any)
	if !ok {
		return nil, ErrMalformed
	}
	byLink := map[int][]Domain{}
	for _, v := range domainRows {
		row, ok := v.([]any)
		if !ok || len(row) != 3 {
			return nil, ErrMalformed
		}
		index, ok := row[0].(float64)
		name, ok2 := row[1].(string)
		routeOnly, ok3 := row[2].(bool)
		if !ok || !ok2 || !ok3 {
			return nil, ErrMalformed
		}
		byLink[int(index)] = append(byLink[int(index)], Domain{Name: name, RouteOnly: routeOnly})
	}
	rows := []ResolverRow{}
	for _, v := range entries {
		entry, ok := v.([]any)
		if !ok || len(entry) != 3 {
			return rows, ErrMalformed
		}
		index, ok := entry[0].(float64)
		family, ok2 := entry[1].(float64)
		octets, ok3 := entry[2].([]any)
		if !ok || !ok2 || !ok3 {
			return rows, ErrMalformed
		}
		raw := make([]byte, len(octets))
		for i, value := range octets {
			n, ok := value.(float64)
			if !ok || n < 0 || n > 255 || n != float64(byte(n)) {
				return rows, ErrMalformed
			}
			raw[i] = byte(n)
		}
		ip, e := linuxIP(raw, byte(family))
		if e != nil {
			return rows, e
		}
		var iface, zone *string
		if index > 0 {
			iface = ptr("linux-ifindex:" + strconv.Itoa(int(index)))
		}
		if ip.Is6() && ip.IsLinkLocalUnicast() {
			if iface == nil {
				return rows, ErrMalformed
			}
			zone = iface
		}
		ds := append([]Domain{}, byLink[int(index)]...)
		r := ResolverRow{Address: ip.String(), Zone: zone, InterfaceKey: iface, IsLocalStub: ip.IsLoopback(), Port: 53, Transport: "udp_tcp", Domains: ds, Mechanism: "systemd_resolved"}
		r.RowKey = rowIdentity(r)
		rows = append(rows, r)
	}
	return rows, nil
}
func readResolved(ctx context.Context, runner CommandRunner) (ResolverSection, error) {
	dns, e := busProperty(ctx, runner, "org.freedesktop.resolve1", "/org/freedesktop/resolve1", "org.freedesktop.resolve1.Manager", "DNS")
	if e != nil {
		return ResolverSection{}, e
	}
	domains, e := busProperty(ctx, runner, "org.freedesktop.resolve1", "/org/freedesktop/resolve1", "org.freedesktop.resolve1.Manager", "Domains")
	if e != nil {
		return ResolverSection{}, e
	}
	rows, e := parseResolvedDNS(dns, domains)
	return ResolverSection{Rows: rows}, e
}
func variantData(v any) any {
	if m, ok := v.(map[string]any); ok {
		if d, ok := m["data"]; ok {
			return d
		}
	}
	return v
}
func readNetworkManagerDNS(ctx context.Context, runner CommandRunner) (ResolverSection, error) {
	value, e := busProperty(ctx, runner, "org.freedesktop.NetworkManager", "/org/freedesktop/NetworkManager/DnsManager", "org.freedesktop.NetworkManager.DnsManager", "Configuration")
	if e != nil {
		return ResolverSection{}, e
	}
	entries, ok := value.([]any)
	if !ok {
		return ResolverSection{}, ErrMalformed
	}
	rows := []ResolverRow{}
	for _, entry := range entries {
		dict, ok := entry.(map[string]any)
		if !ok {
			return ResolverSection{}, ErrMalformed
		}
		servers, ok := variantData(dict["nameservers"]).([]any)
		if !ok {
			return ResolverSection{}, ErrMalformed
		}
		var iface *string
		if name, ok := variantData(dict["interface"]).(string); ok && name != "" {
			iface = ptr("linux-ifname:" + name)
		}
		domains := []Domain{}
		if values, ok := variantData(dict["domains"]).([]any); ok {
			for _, value := range values {
				domain, ok := value.(string)
				if !ok {
					return ResolverSection{}, ErrMalformed
				}
				domains = append(domains, Domain{Name: strings.TrimPrefix(domain, "~"), RouteOnly: strings.HasPrefix(domain, "~")})
			}
		}
		for _, server := range servers {
			value, ok := server.(string)
			if !ok {
				return ResolverSection{}, ErrMalformed
			}
			ip, e := netip.ParseAddr(value)
			if e != nil {
				return ResolverSection{}, e
			}
			var zone *string
			if ip.Is6() && ip.IsLinkLocalUnicast() {
				if iface == nil {
					return ResolverSection{}, ErrMalformed
				}
				zone = iface
			}
			r := ResolverRow{Address: ip.WithZone("").String(), Zone: zone, InterfaceKey: iface, IsLocalStub: ip.IsLoopback(), Port: 53, Transport: "udp_tcp", Domains: domains, Mechanism: "network_manager"}
			r.RowKey = rowIdentity(r)
			rows = append(rows, r)
		}
	}
	return ResolverSection{Rows: rows}, nil
}
func parseResolvConf(raw []byte) ResolverSection {
	s := ResolverSection{Outcome: Partial, ReasonCode: "split_dns_unavailable", Rows: []ResolverRow{}}
	domains := []Domain{}
	addresses := []string{}
	scan := bufio.NewScanner(bytes.NewReader(raw))
	scan.Buffer(make([]byte, 4096), 64*1024)
	for scan.Scan() {
		line := strings.SplitN(scan.Text(), "#", 2)[0]
		fields := strings.Fields(line)
		if len(fields) < 2 {
			continue
		}
		switch fields[0] {
		case "nameserver":
			addresses = append(addresses, fields[1])
		case "search", "domain":
			for _, name := range fields[1:] {
				domains = append(domains, Domain{Name: name})
			}
		}
	}
	for _, address := range addresses {
		ip, e := netip.ParseAddr(address)
		if e != nil {
			continue
		}
		var zone *string
		if ip.Zone() != "" {
			zone = ptr(ip.Zone())
			ip = ip.WithZone("")
		}
		if ip.Is6() && ip.IsLinkLocalUnicast() && zone == nil {
			continue
		}
		r := ResolverRow{Address: ip.String(), Zone: zone, IsLocalStub: ip.IsLoopback(), Port: 53, Transport: "udp_tcp", Domains: domains, Mechanism: "resolv_conf"}
		r.RowKey = rowIdentity(r)
		s.Rows = append(s.Rows, r)
	}
	s.RowCount = len(s.Rows)
	return s
}
func readLinuxDNS(ctx context.Context) (ResolverSection, error) {
	runner := boundedRunner{}
	if s, e := readResolved(ctx, runner); e == nil {
		return s, nil
	}
	if ctx.Err() != nil {
		return ResolverSection{}, ctx.Err()
	}
	if s, e := readNetworkManagerDNS(ctx, runner); e == nil {
		return s, nil
	}
	if ctx.Err() != nil {
		return ResolverSection{}, ctx.Err()
	}
	f, e := os.Open("/etc/resolv.conf")
	if e != nil {
		return ResolverSection{}, e
	}
	defer func() { _ = f.Close() }()
	b, e := io.ReadAll(io.LimitReader(f, 1024*1024+1))
	if e != nil {
		return ResolverSection{}, e
	}
	if len(b) > 1024*1024 {
		return ResolverSection{}, ErrLimit
	}
	return parseResolvConf(b), nil
}
