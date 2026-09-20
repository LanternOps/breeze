package networkdiagnostic

import (
	"errors"
	"golang.org/x/net/dns/dnsmessage"
	"net/netip"
	"strings"
)

func parseDNSResponse(wire []byte, id uint16, name dnsmessage.Name, typ dnsmessage.Type) ([]netip.Addr, error) {
	var response dnsmessage.Message
	if err := response.Unpack(wire); err != nil {
		return nil, err
	}
	if response.ID != id || !response.Response || response.RCode != dnsmessage.RCodeSuccess || response.Truncated || len(response.Questions) != 1 {
		return nil, errors.New("invalid_dns_response")
	}
	q := response.Questions[0]
	if !strings.EqualFold(q.Name.String(), name.String()) || q.Type != typ || q.Class != dnsmessage.ClassINET {
		return nil, errors.New("dns_question_mismatch")
	}
	owner := strings.ToLower(name.String())
	seen := map[string]bool{}
	for depth := 0; ; depth++ {
		if depth > 8 || seen[owner] {
			return nil, errors.New("invalid_cname_chain")
		}
		seen[owner] = true
		next := ""
		for _, answer := range response.Answers {
			if answer.Header.Class != dnsmessage.ClassINET || strings.ToLower(answer.Header.Name.String()) != owner {
				continue
			}
			if cname, ok := answer.Body.(*dnsmessage.CNAMEResource); ok {
				target := strings.ToLower(cname.CNAME.String())
				if next != "" && next != target {
					return nil, errors.New("ambiguous_cname_chain")
				}
				next = target
			}
		}
		if next == "" {
			break
		}
		owner = next
	}
	ips := []netip.Addr{}
	unique := map[netip.Addr]bool{}
	for _, answer := range response.Answers {
		if answer.Header.Class != dnsmessage.ClassINET || strings.ToLower(answer.Header.Name.String()) != owner {
			continue
		}
		var ip netip.Addr
		switch body := answer.Body.(type) {
		case *dnsmessage.AResource:
			if typ == dnsmessage.TypeA {
				ip = netip.AddrFrom4(body.A)
			}
		case *dnsmessage.AAAAResource:
			if typ == dnsmessage.TypeAAAA {
				ip = netip.AddrFrom16(body.AAAA)
			}
		}
		if ip.IsValid() && !unique[ip] {
			unique[ip] = true
			ips = append(ips, ip)
		}
		if len(ips) > 2 {
			return nil, errors.New("address_limit_exceeded")
		}
	}
	return ips, nil
}
