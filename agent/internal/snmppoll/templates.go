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
//
// Deprecated: not used in production — the server sends the device's template
// as `oids`/`oidSpecs` on every poll command (spec §7.1), and these hardcoded
// lists carry no mode or cadence, so wiring them in would GET table columns and
// reproduce the silent-null bug W02 exists to fix. Kept only as the offline
// fallback set a future disconnected mode would start from.
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

	LldpRemChassisIDSubtypeOID = "1.0.8802.1.1.2.1.4.1.1.4" // lldpRemChassisIdSubtype
	LldpRemPortIDSubtypeOID    = "1.0.8802.1.1.2.1.4.1.1.6" // lldpRemPortIdSubtype
	LldpLocPortIDSubtypeOID    = "1.0.8802.1.1.2.1.3.7.1.2" // lldpLocPortIdSubtype
	LldpLocPortDescOID         = "1.0.8802.1.1.2.1.3.7.1.4" // lldpLocPortDesc
	// lldpRemManAddrIfSubtype; the management address itself lives in the row
	// index: timeMark.localPortNum.remIndex.addrSubtype.addrLen.addr...
	LldpRemManAddrIfSubtypeOID = "1.0.8802.1.1.2.1.4.2.1.3"
)

// Cisco CDP cdpCacheTable columns under 1.3.6.1.4.1.9.9.23.1.2.1.1.
const (
	CdpCacheDeviceIDOID    = "1.3.6.1.4.1.9.9.23.1.2.1.1.6" // cdpCacheDeviceId
	CdpCacheDevicePortOID  = "1.3.6.1.4.1.9.9.23.1.2.1.1.7" // cdpCacheDevicePort
	CdpCacheAddressOID     = "1.3.6.1.4.1.9.9.23.1.2.1.1.4" // cdpCacheAddress
	CdpCacheAddressTypeOID = "1.3.6.1.4.1.9.9.23.1.2.1.1.3" // cdpCacheAddressType (1 = ip)
	CdpGlobalOID           = "1.3.6.1.4.1.9.9.23.1.3"       // cdpGlobal group (support probe)
)

// IfNameOID is ifName (ifXTable), used to resolve a local ifIndex to a port name.
const IfNameOID = "1.3.6.1.2.1.31.1.1.1.1"

// Interface inventory and bridge-port mapping columns.
const (
	IfAliasOID              = "1.3.6.1.2.1.31.1.1.1.18" // ifAlias
	IfPhysAddressOID        = "1.3.6.1.2.1.2.2.1.6"     // ifPhysAddress
	Dot1dBasePortIfIndexOID = "1.3.6.1.2.1.17.1.4.1.2"  // dot1dBasePortIfIndex (bridge port → ifIndex)
	Dot1dTpFdbPortOID       = "1.3.6.1.2.1.17.4.3.1.2"  // dot1dTpFdbPort
)
