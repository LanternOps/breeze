package timesync

import (
	"context"
	"strings"
)

func nullableText(s string, max int) *string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return ptr(limitText(s, max))
}

func dnsName(s string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimLeft(strings.TrimSpace(s), `\`), "."))
}

func readDomain(ctx context.Context, sys System) Domain {
	d := Domain{JoinType: "unknown", Role: "unknown"}
	id, err := sys.Identity(ctx)
	if err != nil || !id.DetectionSupported() || id.Source == "dsregcmd_error_no_fallback" {
		return d
	}
	switch string(id.JoinType) {
	case "none", "workplace":
		d.JoinType = string(id.JoinType)
		d.Role = "workgroup"
		return d
	case "azure_ad":
		d.JoinType = "azure_ad"
		d.Role = "entra_only"
		return d
	case "on_prem_ad", "hybrid_azure_ad":
		d.JoinType = string(id.JoinType)
	default:
		return d
	}
	// dsregcmd's DomainName can be a NetBIOS name; only DsRole supplies domainDns.
	role, err := sys.PrimaryDomain(ctx)
	if err != nil {
		return d
	}
	d.DomainDNS = nullableText(role.DomainDNS, 255)
	d.ForestDNS = nullableText(role.ForestDNS, 255)
	if d.DomainDNS == nil || d.ForestDNS == nil {
		return d
	}
	pdc, pdcErr := sys.PDC(ctx, role.DomainDNS)
	if pdcErr == nil {
		d.PDCName = nullableText(dnsName(pdc), 255)
	}
	// Discovery failure remains fail-closed even on a known member.
	if pdcErr != nil || d.PDCName == nil {
		return d
	}
	switch role.MachineRole {
	case 1, 3:
		d.Role = "member"
		return d
	case 4, 5:
		local, err := sys.ComputerDNSName(ctx)
		if err != nil || !strings.Contains(local, ".") {
			return d
		}
		if dnsName(local) != dnsName(pdc) {
			d.Role = "dc"
			return d
		}
		d.Role = "pdc_emulator"
		if strings.EqualFold(role.DomainDNS, role.ForestDNS) {
			d.Role = "forest_root_pdc_emulator"
		}
	}
	return d
}

// limitText truncates s to at most max UTF-16 code units, matching Zod's
// .max(), which measures JavaScript string length rather than bytes or runes.
func limitText(s string, max int) string {
	used := 0
	var b strings.Builder
	for _, r := range s {
		n := 1
		if r > 0xffff {
			n = 2
		}
		if used+n > max {
			break
		}
		b.WriteRune(r)
		used += n
	}
	return b.String()
}
