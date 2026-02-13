package mgmtdetect

import "strings"

// deriveJoinType computes the join type from identity flags.
func deriveJoinType(id IdentityStatus) JoinType {
	switch {
	case id.AzureAdJoined && id.DomainJoined:
		return JoinTypeHybridAzureAD
	case id.AzureAdJoined:
		return JoinTypeAzureAD
	case id.DomainJoined:
		return JoinTypeOnPremAD
	case id.WorkplaceJoined:
		return JoinTypeWorkplace
	default:
		return JoinTypeNone
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
