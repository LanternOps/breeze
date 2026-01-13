package discovery

import "strings"

// ClassifyAsset infers asset type, manufacturer, and model using discovery data.
func ClassifyAsset(host DiscoveredHost) (string, string, string) {
	var assetType string
	var manufacturer string
	var model string

	sysDescr := ""
	sysObjectID := ""
	if host.SNMPData != nil {
		sysDescr = strings.ToLower(host.SNMPData.SysDescr)
		sysObjectID = strings.ToLower(host.SNMPData.SysObjectID)
	}

	switch {
	case strings.Contains(sysDescr, "printer") || hasPort(host.OpenPorts, 9100) || hasPort(host.OpenPorts, 631):
		assetType = "printer"
	case strings.Contains(sysDescr, "switch") || strings.Contains(sysObjectID, "switch"):
		assetType = "switch"
	case strings.Contains(sysDescr, "router") || strings.Contains(sysObjectID, "router"):
		assetType = "router"
	case hasPort(host.OpenPorts, 3389) || hasPort(host.OpenPorts, 445):
		assetType = "windows"
	case hasPort(host.OpenPorts, 22):
		assetType = "linux"
	case hasPort(host.OpenPorts, 80) || hasPort(host.OpenPorts, 443):
		assetType = "web"
	default:
		assetType = "unknown"
	}

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
	}

	if model == "" && host.SNMPData != nil {
		model = strings.TrimSpace(host.SNMPData.SysObjectID)
	}

	return assetType, manufacturer, model
}

func hasPort(openPorts []OpenPort, port int) bool {
	for _, openPort := range openPorts {
		if openPort.Port == port {
			return true
		}
	}
	return false
}
