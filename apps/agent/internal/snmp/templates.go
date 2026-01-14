package snmp

import "strings"

var commonOIDs = []string{
	"1.3.6.1.2.1.1.3.0",    // sysUpTime
	"1.3.6.1.2.1.1.5.0",    // sysName
	"1.3.6.1.2.1.2.2.1.8",  // ifOperStatus
	"1.3.6.1.2.1.2.2.1.10", // ifInOctets
	"1.3.6.1.2.1.2.2.1.16", // ifOutOctets
}

var routerOIDs = []string{
	"1.3.6.1.2.1.4.1.0",  // ipForwarding
	"1.3.6.1.2.1.4.3.0",  // ipInReceives
	"1.3.6.1.2.1.4.10.0", // ipOutRequests
}

var switchOIDs = []string{
	"1.3.6.1.2.1.17.1.1.0", // dot1dBaseBridgeAddress
	"1.3.6.1.2.1.17.1.2.0", // dot1dBaseNumPorts
	"1.3.6.1.2.1.17.4.3",   // dot1dTpFdbTable
}

var printerOIDs = []string{
	"1.3.6.1.2.1.25.3.2.1.5",   // hrDeviceStatus
	"1.3.6.1.2.1.43.5.1.1.1.1", // prtGeneralPrinterStatus
	"1.3.6.1.2.1.43.10.2.1.4",  // prtMarkerLifeCount
	"1.3.6.1.2.1.43.11.1.1.9",  // prtMarkerSuppliesLevel
}

// GetTemplate returns a list of OIDs for the requested device type.
func GetTemplate(deviceType string) []string {
	deviceType = strings.ToLower(strings.TrimSpace(deviceType))

	template := append([]string{}, commonOIDs...)
	switch deviceType {
	case "router", "routers":
		template = append(template, routerOIDs...)
	case "switch", "switches":
		template = append(template, switchOIDs...)
	case "printer", "printers":
		template = append(template, printerOIDs...)
	}

	return template
}
