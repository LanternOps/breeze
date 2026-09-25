package discovery

import (
	"strings"

	"github.com/breeze-rmm/agent/internal/snmppoll"
	"github.com/gosnmp/gosnmp"
)

// LldpNeighbor neighbor row (see cross-phase locked contract).
type LldpNeighbor struct {
	LocalPort       string `json:"localPort"`
	LocalIfName     string `json:"localIfName,omitempty"`
	RemoteChassisID string `json:"remoteChassisId"`
	RemotePortID    string `json:"remotePortId"`
	RemoteSysName   string `json:"remoteSysName,omitempty"`
}

// CdpNeighbor neighbor row.
type CdpNeighbor struct {
	LocalPort      string `json:"localPort"`
	RemoteDeviceID string `json:"remoteDeviceId"`
	RemotePortID   string `json:"remotePortId"`
	RemoteAddress  string `json:"remoteAddress,omitempty"`
}

// FdbEntry is the legacy scalar-VLAN FDB row.
type FdbEntry struct {
	MAC        string `json:"mac"`
	BridgePort int    `json:"bridgePort"`
	IfName     string `json:"ifName,omitempty"`
	VLAN       int    `json:"vlan,omitempty"`
}

// DeviceAdjacency is the legacy per-source-device adjacency block emitted in
// the scan result. It is now a lossy projection of the V2 sections (see
// LegacyAdjacencyFromSections); its shape is unchanged for existing consumers.
type DeviceAdjacency struct {
	SourceDeviceIP  string         `json:"sourceDeviceIp"`
	SourceChassisID string         `json:"sourceChassisId,omitempty"`
	Lldp            []LldpNeighbor `json:"lldp"`
	Cdp             []CdpNeighbor  `json:"cdp"`
	Fdb             []FdbEntry     `json:"fdb"`
}

// indexSuffix returns the dotted index after rootOID (no leading dot), or "" if name is not under root.
func indexSuffix(name, root string) string {
	name = strings.TrimPrefix(name, ".")
	root = strings.TrimPrefix(root, ".")
	if !strings.HasPrefix(name, root+".") {
		return ""
	}
	return strings.TrimPrefix(name, root+".")
}

func snmpValueToString(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case string:
		return v
	case []byte:
		// Same hazard as snmppoll.OctetStringToText guards. lldpRemPortId with
		// portIdSubtype = macAddress(3) is a raw 6-octet MAC, and this is also
		// the fallback in macFromBytes/ipFromBytes for payloads that aren't
		// exactly 6/4 bytes. These values only key in-memory lookups today, but
		// they populate LldpNeighbor.RemotePortID/.RemoteSysName and
		// CdpNeighbor.RemoteDeviceID, so the moment anyone persists them a raw
		// cast becomes the same NUL insert failure.
		return snmppoll.OctetStringToText(v)
	default:
		if pdu.Value == nil {
			return ""
		}
		return gosnmp.ToBigInt(pdu.Value).String()
	}
}

// LegacyAdjacencyFromSections projects V2 sections onto the legacy block.
//   - LLDP LocalPort is the lldp_local port number (never the timeMark);
//     LocalIfName is the resolved interface's name when resolution was unique.
//   - Remote chassis ids keep their decoded value (MAC only for mac_address).
//   - FDB drops invalid/self rows and port zero, and sets a scalar VLAN only
//     when the V2 mapping is complete and names exactly one VLAN.
func LegacyAdjacencyFromSections(sourceIP string, sections []PhysicalSection) DeviceAdjacency {
	adj := DeviceAdjacency{SourceDeviceIP: sourceIP, Lldp: []LldpNeighbor{}, Cdp: []CdpNeighbor{}, Fdb: []FdbEntry{}}
	names := map[string]string{}
	for _, s := range sections {
		for _, i := range s.Interfaces {
			if i.IfName != nil {
				names[i.InterfaceKey] = *i.IfName
			}
		}
	}
	for _, s := range sections {
		for _, r := range s.Lldp {
			n := LldpNeighbor{LocalPort: r.LocalPort.Value, RemoteChassisID: r.RemoteChassis.Value, RemotePortID: r.RemotePort.Value, RemoteSysName: r.RemoteSysName}
			if r.LocalPort.ResolvedInterfaceKey != nil {
				n.LocalIfName = names[*r.LocalPort.ResolvedInterfaceKey]
			}
			adj.Lldp = append(adj.Lldp, n)
		}
		for _, r := range s.Cdp {
			adj.Cdp = append(adj.Cdp, CdpNeighbor{LocalPort: r.LocalPort.Value, RemoteDeviceID: r.RemoteDevice.Value, RemotePortID: r.RemotePort.Value, RemoteAddress: r.RemoteAddress})
		}
		for _, r := range s.Fdb {
			if r.Status == snmppoll.FdbStatusInvalid || r.Status == snmppoll.FdbStatusSelf || r.BridgePort == 0 {
				continue
			}
			e := FdbEntry{MAC: r.MAC, BridgePort: int(r.BridgePort), IfName: r.IfName}
			if r.VLANMapping == snmppoll.VLANMappingComplete && len(r.VLANs) == 1 {
				e.VLAN = int(r.VLANs[0])
			}
			adj.Fdb = append(adj.Fdb, e)
		}
	}
	return adj
}

func (a DeviceAdjacency) hasRows() bool { return len(a.Lldp) > 0 || len(a.Cdp) > 0 || len(a.Fdb) > 0 }
