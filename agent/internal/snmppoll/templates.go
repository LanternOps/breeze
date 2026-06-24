package snmppoll

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

// LLDP (IEEE 802.1AB) lldpRemTable columns under 1.0.8802.1.1.2.1.4.1.1.
const (
	LldpRemChassisIDOID = "1.0.8802.1.1.2.1.4.1.1.5" // lldpRemChassisId
	LldpRemPortIDOID    = "1.0.8802.1.1.2.1.4.1.1.7" // lldpRemPortId
	LldpRemSysNameOID   = "1.0.8802.1.1.2.1.4.1.1.9" // lldpRemSysName
	LldpLocPortIDOID    = "1.0.8802.1.1.2.1.3.7.1.3" // lldpLocPortId
)

// Cisco CDP cdpCacheTable columns under 1.3.6.1.4.1.9.9.23.1.2.1.1.
const (
	CdpCacheDeviceIDOID   = "1.3.6.1.4.1.9.9.23.1.2.1.1.6" // cdpCacheDeviceId
	CdpCacheDevicePortOID = "1.3.6.1.4.1.9.9.23.1.2.1.1.7" // cdpCacheDevicePort
	CdpCacheAddressOID    = "1.3.6.1.4.1.9.9.23.1.2.1.1.4" // cdpCacheAddress
)

// IfNameOID is ifName (ifXTable), used to resolve a local ifIndex to a port name.
const IfNameOID = "1.3.6.1.2.1.31.1.1.1.1"
