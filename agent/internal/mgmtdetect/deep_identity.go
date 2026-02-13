package mgmtdetect

import "strings"

// deriveJoinType computes the join type from identity flags.
func deriveJoinType(id IdentityStatus) string {
	switch {
	case id.AzureAdJoined && id.DomainJoined:
		return "hybrid_azure_ad"
	case id.AzureAdJoined:
		return "azure_ad"
	case id.DomainJoined:
		return "on_prem_ad"
	case id.WorkplaceJoined:
		return "workplace"
	default:
		return "none"
	}
}

// parseDsregcmdOutput parses dsregcmd /status output into IdentityStatus.
func parseDsregcmdOutput(output string) IdentityStatus {
	id := IdentityStatus{Source: "dsregcmd"}
	for _, line := range strings.Split(output, "\n") {
		line = strings.TrimSpace(line)
		parts := strings.SplitN(line, " : ", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		switch key {
		case "AzureAdJoined":
			id.AzureAdJoined = strings.EqualFold(val, "YES")
		case "DomainJoined":
			id.DomainJoined = strings.EqualFold(val, "YES")
		case "WorkplaceJoined":
			id.WorkplaceJoined = strings.EqualFold(val, "YES")
		case "DomainName":
			id.DomainName = val
		case "TenantId":
			id.TenantId = val
		case "MdmUrl":
			id.MdmUrl = val
		}
	}
	id.JoinType = deriveJoinType(id)
	return id
}
