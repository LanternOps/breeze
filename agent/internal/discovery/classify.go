package discovery

import (
	"net"
	"strings"
)

// ClassifyAsset infers asset type, manufacturer, and model using discovery data.
// Returns valid DB enum values: workstation, server, printer, router, switch,
// firewall, access_point, nas, phone, iot, camera, unknown.
func ClassifyAsset(host DiscoveredHost) (string, string, string) {
	var manufacturer string
	var model string

	sysDescr := ""
	sysObjectID := ""
	if host.SNMPData != nil {
		sysDescr = strings.ToLower(host.SNMPData.SysDescr)
		sysObjectID = strings.ToLower(host.SNMPData.SysObjectID)
	}

	assetType := classifyType(host, sysDescr, sysObjectID)

	switch {
	case strings.Contains(sysDescr, "cisco"):
		manufacturer = "Cisco"
	case strings.Contains(sysDescr, "hewlett-packard") || strings.Contains(sysDescr, "hp"):
		manufacturer = "HP"
	case strings.Contains(sysDescr, "dell"):
		manufacturer = "Dell"
	case strings.Contains(sysDescr, "juniper"):
		manufacturer = "Juniper"
	case strings.Contains(sysDescr, "mikrotik"):
		manufacturer = "MikroTik"
	case strings.Contains(sysDescr, "synology"):
		manufacturer = "Synology"
	case strings.Contains(sysDescr, "qnap"):
		manufacturer = "QNAP"
	case strings.Contains(sysDescr, "ubiquiti") || strings.Contains(sysDescr, "unifi"):
		manufacturer = "Ubiquiti"
	case strings.Contains(sysDescr, "fortinet") || strings.Contains(sysDescr, "fortigate"):
		manufacturer = "Fortinet"
	}

	if model == "" && host.SNMPData != nil {
		model = strings.TrimSpace(host.SNMPData.SysObjectID)
	}

	return assetType, manufacturer, model
}

// classifyType determines the asset type using a priority-based approach.
// Priority order: printer > router > switch > firewall > NAS > access_point > server > workstation > unknown
func classifyType(host DiscoveredHost, sysDescr, sysObjectID string) string {
	// 1. Printer: SNMP or printer ports
	if strings.Contains(sysDescr, "printer") ||
		hasPort(host.OpenPorts, 9100) || hasPort(host.OpenPorts, 631) {
		return "printer"
	}

	// 2. Router: SNMP or gateway heuristic
	if strings.Contains(sysDescr, "router") || strings.Contains(sysObjectID, "router") {
		return "router"
	}

	// 3. Switch: SNMP
	if strings.Contains(sysDescr, "switch") || strings.Contains(sysObjectID, "switch") {
		return "switch"
	}

	// 4. Firewall: SNMP
	if strings.Contains(sysDescr, "firewall") || strings.Contains(sysObjectID, "firewall") {
		return "firewall"
	}

	// 5. NAS: SNMP or Synology/QNAP indicators or Synology web UI ports
	if strings.Contains(sysDescr, "nas") ||
		strings.Contains(sysDescr, "synology") || strings.Contains(sysDescr, "qnap") ||
		(hasPort(host.OpenPorts, 5000) && hasPort(host.OpenPorts, 5001)) {
		return "nas"
	}

	// 6. Access Point: SNMP
	if strings.Contains(sysDescr, "access.point") || strings.Contains(sysDescr, "wireless") ||
		strings.Contains(sysObjectID, "access.point") {
		return "access_point"
	}

	// Gateway heuristic: IP ends in .1 or .254 AND has HTTP but no SSH/RDP → router
	if isGatewayIP(host.IP) &&
		(hasPort(host.OpenPorts, 80) || hasPort(host.OpenPorts, 443)) &&
		!hasPort(host.OpenPorts, 22) && !hasPort(host.OpenPorts, 3389) {
		return "router"
	}

	// 7. Server: SSH + server-specific ports
	serverPorts := []int{3306, 5432, 1433, 6379, 8443, 27017}
	if hasPort(host.OpenPorts, 22) && hasAnyPort(host.OpenPorts, serverPorts) {
		return "server"
	}

	// 8. Workstation: RDP, SMB, SSH alone, or VNC/Screen Sharing
	if hasPort(host.OpenPorts, 3389) || hasPort(host.OpenPorts, 445) ||
		hasPort(host.OpenPorts, 22) || hasPort(host.OpenPorts, 5900) {
		return "workstation"
	}

	// 9. Unknown: HTTP-only or no ports (too ambiguous)
	return "unknown"
}

// isGatewayIP checks if the IP ends in .1 or .254 (common gateway addresses).
func isGatewayIP(ipStr string) bool {
	ip := net.ParseIP(ipStr)
	if ip == nil {
		return false
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	lastOctet := ip4[3]
	return lastOctet == 1 || lastOctet == 254
}

func hasPort(openPorts []OpenPort, port int) bool {
	for _, openPort := range openPorts {
		if openPort.Port == port {
			return true
		}
	}
	return false
}

func hasAnyPort(openPorts []OpenPort, ports []int) bool {
	for _, port := range ports {
		if hasPort(openPorts, port) {
			return true
		}
	}
	return false
}
