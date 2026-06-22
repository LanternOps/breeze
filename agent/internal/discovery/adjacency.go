package discovery

import (
	"fmt"
	"net"
	"strings"
	"time"

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

// FdbEntry — Phase 2 populates this; Phase 1 always emits an empty slice.
type FdbEntry struct {
	MAC        string `json:"mac"`
	BridgePort int    `json:"bridgePort"`
	IfName     string `json:"ifName,omitempty"`
	VLAN       int    `json:"vlan,omitempty"`
}

// DeviceAdjacency is the per-source-device adjacency block emitted in the scan result.
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

// lldpLocalPort derives the local-port key from an lldpRemTable index.
// lldpRemTable is indexed by lldpRemTimeMark.lldpRemLocalPortNum.lldpRemIndex;
// we key rows on "<timeMark>.<localPortNum>" so columns join consistently.
func lldpLocalPort(suffix string) string {
	parts := strings.Split(suffix, ".")
	if len(parts) >= 2 {
		return parts[0] + "." + parts[1]
	}
	return suffix
}

func snmpValueToString(pdu gosnmp.SnmpPDU) string {
	switch v := pdu.Value.(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		if pdu.Value == nil {
			return ""
		}
		return gosnmp.ToBigInt(pdu.Value).String()
	}
}

// macFromBytes formats a 6-byte chassis-id as colon-separated hex; falls back to string otherwise.
func macFromBytes(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if ok && len(b) == 6 {
		parts := make([]string, 6)
		for i, c := range b {
			parts[i] = fmt.Sprintf("%02x", c)
		}
		return strings.Join(parts, ":")
	}
	return snmpValueToString(pdu)
}

// ipFromBytes formats a 4-byte address as dotted IPv4; falls back to string.
func ipFromBytes(pdu gosnmp.SnmpPDU) string {
	b, ok := pdu.Value.([]byte)
	if ok && len(b) == 4 {
		return net.IP(b).String()
	}
	return snmpValueToString(pdu)
}

func parseLLDPNeighbors(chassis, portID, sysName []gosnmp.SnmpPDU) []LldpNeighbor {
	ports := map[string]string{}
	for _, p := range portID {
		ports[indexSuffix(p.Name, snmppoll.LldpRemPortIDOID)] = snmpValueToString(p)
	}
	names := map[string]string{}
	for _, n := range sysName {
		names[indexSuffix(n.Name, snmppoll.LldpRemSysNameOID)] = snmpValueToString(n)
	}
	out := make([]LldpNeighbor, 0, len(chassis))
	for _, ch := range chassis {
		idx := indexSuffix(ch.Name, snmppoll.LldpRemChassisIDOID)
		if idx == "" {
			continue
		}
		out = append(out, LldpNeighbor{
			LocalPort:       lldpLocalPort(idx),
			RemoteChassisID: macFromBytes(ch),
			RemotePortID:    ports[idx],
			RemoteSysName:   names[idx],
		})
	}
	return out
}

func parseCDPNeighbors(deviceID, devicePort, address []gosnmp.SnmpPDU) []CdpNeighbor {
	ports := map[string]string{}
	for _, p := range devicePort {
		ports[indexSuffix(p.Name, snmppoll.CdpCacheDevicePortOID)] = snmpValueToString(p)
	}
	addrs := map[string]string{}
	for _, a := range address {
		addrs[indexSuffix(a.Name, snmppoll.CdpCacheAddressOID)] = ipFromBytes(a)
	}
	out := make([]CdpNeighbor, 0, len(deviceID))
	for _, d := range deviceID {
		idx := indexSuffix(d.Name, snmppoll.CdpCacheDeviceIDOID)
		if idx == "" {
			continue
		}
		// cdpCacheTable index is cdpCacheIfIndex.cdpCacheDeviceIndex → local port = first element.
		localPort := idx
		if dot := strings.Index(idx, "."); dot > 0 {
			localPort = idx[:dot]
		}
		out = append(out, CdpNeighbor{
			LocalPort:      localPort,
			RemoteDeviceID: snmpValueToString(d),
			RemotePortID:   ports[idx],
			RemoteAddress:  addrs[idx],
		})
	}
	return out
}

// collectDeviceAdjacency walks LLDP then CDP on one connected SNMP client.
// Errors degrade per-table: a failed walk yields no rows for that protocol.
func collectDeviceAdjacency(client *snmppoll.SNMPClient, sourceIP string) DeviceAdjacency {
	adj := DeviceAdjacency{SourceDeviceIP: sourceIP, Lldp: []LldpNeighbor{}, Cdp: []CdpNeighbor{}, Fdb: []FdbEntry{}}

	chassis, errC := client.Walk(snmppoll.LldpRemChassisIDOID)
	if errC == nil && len(chassis) > 0 {
		portID, _ := client.Walk(snmppoll.LldpRemPortIDOID)
		sysName, _ := client.Walk(snmppoll.LldpRemSysNameOID)
		adj.Lldp = parseLLDPNeighbors(chassis, portID, sysName)
	}

	cdpDev, errD := client.Walk(snmppoll.CdpCacheDeviceIDOID)
	if errD == nil && len(cdpDev) > 0 {
		cdpPort, _ := client.Walk(snmppoll.CdpCacheDevicePortOID)
		cdpAddr, _ := client.Walk(snmppoll.CdpCacheAddressOID)
		adj.Cdp = parseCDPNeighbors(cdpDev, cdpPort, cdpAddr)
	}

	return adj
}

// collectAdjacencyFor is the per-host network seam (stubbed in tests).
var collectAdjacencyFor = collectDeviceAdjacencyForHost

// collectDeviceAdjacencyForHost connects via the first usable community and walks LLDP/CDP.
func collectDeviceAdjacencyForHost(ip string, communities []string, timeout time.Duration) DeviceAdjacency {
	empty := DeviceAdjacency{SourceDeviceIP: ip, Lldp: []LldpNeighbor{}, Cdp: []CdpNeighbor{}, Fdb: []FdbEntry{}}
	for _, community := range communities {
		community = strings.TrimSpace(community)
		if community == "" {
			continue
		}
		cfg := snmppoll.SNMPClientConfig{Target: ip, Timeout: timeout}
		if strings.HasPrefix(strings.ToLower(community), "v3:") {
			cfg.Version = gosnmp.Version3
			cfg.Auth = snmppoll.SNMPAuth{Username: strings.TrimPrefix(community, "v3:")}
		} else {
			cfg.Version = gosnmp.Version2c
			cfg.Auth = snmppoll.SNMPAuth{Community: community}
		}
		client, err := snmppoll.NewClient(cfg)
		if err != nil {
			continue
		}
		adj := collectDeviceAdjacency(client, ip)
		client.Close()
		if len(adj.Lldp) > 0 || len(adj.Cdp) > 0 {
			return adj
		}
	}
	return empty
}
