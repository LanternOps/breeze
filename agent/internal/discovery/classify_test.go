package discovery

import (
	"testing"
)

func TestClassifyAssetPrinter(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
	}{
		{
			name: "printer_by_snmp",
			host: DiscoveredHost{
				IP:       "10.0.0.10",
				SNMPData: &SNMPInfo{SysDescr: "HP LaserJet Printer"},
			},
		},
		{
			name: "printer_by_port_9100",
			host: DiscoveredHost{
				IP:        "10.0.0.11",
				OpenPorts: []OpenPort{{Port: 9100, Service: "printer"}},
			},
		},
		{
			name: "printer_by_port_631",
			host: DiscoveredHost{
				IP:        "10.0.0.12",
				OpenPorts: []OpenPort{{Port: 631, Service: "ipp"}},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != "printer" {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "printer")
			}
		})
	}
}

func TestClassifyAssetRouter(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
	}{
		{
			name: "router_by_snmp_descr",
			host: DiscoveredHost{
				IP:       "10.0.0.1",
				SNMPData: &SNMPInfo{SysDescr: "Cisco Router 2900"},
			},
		},
		{
			name: "router_by_snmp_oid",
			host: DiscoveredHost{
				IP:       "10.0.0.1",
				SNMPData: &SNMPInfo{SysObjectID: "1.3.6.1.4.1.9.router.1"},
			},
		},
		{
			name: "router_by_gateway_heuristic",
			host: DiscoveredHost{
				IP:        "192.168.1.1",
				OpenPorts: []OpenPort{{Port: 80, Service: "http"}},
			},
		},
		{
			name: "router_by_gateway_254",
			host: DiscoveredHost{
				IP:        "192.168.1.254",
				OpenPorts: []OpenPort{{Port: 443, Service: "https"}},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != "router" {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "router")
			}
		})
	}
}

func TestClassifyAssetGatewayIPWithSSHIsNotRouter(t *testing.T) {
	// Gateway IP with SSH should be classified as workstation/server, not router
	host := DiscoveredHost{
		IP: "192.168.1.1",
		OpenPorts: []OpenPort{
			{Port: 80, Service: "http"},
			{Port: 22, Service: "ssh"},
		},
	}
	assetType, _, _ := ClassifyAsset(host)
	if assetType == "router" {
		t.Fatalf("gateway IP with SSH should not be router, got %q", assetType)
	}
}

func TestClassifyAssetSwitch(t *testing.T) {
	host := DiscoveredHost{
		IP:       "10.0.0.2",
		SNMPData: &SNMPInfo{SysDescr: "HP ProCurve Switch 2920"},
	}
	assetType, _, _ := ClassifyAsset(host)
	if assetType != "switch" {
		t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "switch")
	}
}

func TestClassifyAssetFirewall(t *testing.T) {
	host := DiscoveredHost{
		IP:       "10.0.0.3",
		SNMPData: &SNMPInfo{SysDescr: "FortiGate Firewall 60F"},
	}
	assetType, _, _ := ClassifyAsset(host)
	if assetType != "firewall" {
		t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "firewall")
	}
}

func TestClassifyAssetNAS(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
	}{
		{
			name: "nas_by_snmp",
			host: DiscoveredHost{
				IP:       "10.0.0.4",
				SNMPData: &SNMPInfo{SysDescr: "Synology DiskStation NAS"},
			},
		},
		{
			name: "nas_by_qnap",
			host: DiscoveredHost{
				IP:       "10.0.0.5",
				SNMPData: &SNMPInfo{SysDescr: "QNAP TS-453D"},
			},
		},
		{
			name: "nas_by_synology_ports",
			host: DiscoveredHost{
				IP: "10.0.0.6",
				OpenPorts: []OpenPort{
					{Port: 5000, Service: ""},
					{Port: 5001, Service: ""},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != "nas" {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "nas")
			}
		})
	}
}

func TestClassifyAssetAccessPoint(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
	}{
		{
			name: "ap_by_access_point",
			host: DiscoveredHost{
				IP:       "10.0.0.7",
				SNMPData: &SNMPInfo{SysDescr: "UniFi Access.Point UAP-AC"},
			},
		},
		{
			name: "ap_by_wireless",
			host: DiscoveredHost{
				IP:       "10.0.0.8",
				SNMPData: &SNMPInfo{SysDescr: "Cisco Wireless Controller"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != "access_point" {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "access_point")
			}
		})
	}
}

func TestClassifyAssetServer(t *testing.T) {
	tests := []struct {
		name  string
		host  DiscoveredHost
	}{
		{
			name: "ssh_and_postgres",
			host: DiscoveredHost{
				IP: "10.0.0.20",
				OpenPorts: []OpenPort{
					{Port: 22, Service: "ssh"},
					{Port: 5432, Service: "postgres"},
				},
			},
		},
		{
			name: "ssh_and_mysql",
			host: DiscoveredHost{
				IP: "10.0.0.21",
				OpenPorts: []OpenPort{
					{Port: 22, Service: "ssh"},
					{Port: 3306, Service: "mysql"},
				},
			},
		},
		{
			name: "ssh_and_redis",
			host: DiscoveredHost{
				IP: "10.0.0.22",
				OpenPorts: []OpenPort{
					{Port: 22, Service: "ssh"},
					{Port: 6379, Service: "redis"},
				},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != "server" {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "server")
			}
		})
	}
}

func TestClassifyAssetWorkstation(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
	}{
		{
			name: "rdp_only",
			host: DiscoveredHost{
				IP:        "10.0.0.30",
				OpenPorts: []OpenPort{{Port: 3389, Service: "rdp"}},
			},
		},
		{
			name: "smb_only",
			host: DiscoveredHost{
				IP:        "10.0.0.31",
				OpenPorts: []OpenPort{{Port: 445, Service: "smb"}},
			},
		},
		{
			name: "ssh_only",
			host: DiscoveredHost{
				IP:        "10.0.0.32",
				OpenPorts: []OpenPort{{Port: 22, Service: "ssh"}},
			},
		},
		{
			name: "vnc_only",
			host: DiscoveredHost{
				IP:        "10.0.0.33",
				OpenPorts: []OpenPort{{Port: 5900, Service: "vnc"}},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != "workstation" {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "workstation")
			}
		})
	}
}

func TestClassifyAssetUnknown(t *testing.T) {
	tests := []struct {
		name string
		host DiscoveredHost
	}{
		{
			name: "no_ports_no_snmp",
			host: DiscoveredHost{IP: "10.0.0.40"},
		},
		{
			name: "http_only",
			host: DiscoveredHost{
				IP:        "10.0.0.41",
				OpenPorts: []OpenPort{{Port: 80, Service: "http"}},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assetType, _, _ := ClassifyAsset(tt.host)
			if assetType != "unknown" {
				t.Fatalf("ClassifyAsset() assetType = %q, want %q", assetType, "unknown")
			}
		})
	}
}

func TestClassifyAssetManufacturer(t *testing.T) {
	tests := []struct {
		name     string
		sysDescr string
		want     string
	}{
		{"cisco", "Cisco IOS Software, C2960", "Cisco"},
		{"hp_long", "Hewlett-Packard J9729A", "HP"},
		{"hp_short", "HP ProCurve Switch", "HP"},
		{"dell", "Dell Networking S3048", "Dell"},
		{"juniper", "Juniper Networks EX3400", "Juniper"},
		{"mikrotik", "MikroTik RouterOS 6.49", "MikroTik"},
		{"synology", "Synology DiskStation DS920+", "Synology"},
		{"qnap", "QNAP TS-453D", "QNAP"},
		{"ubiquiti", "Ubiquiti EdgeSwitch", "Ubiquiti"},
		{"unifi", "UniFi Switch USW-48-POE", "Ubiquiti"},
		{"fortinet", "Fortinet FortiGate-60F", "Fortinet"},
		{"fortigate", "FortiGate-100E v6.4", "Fortinet"},
		{"unknown_vendor", "Some Unknown Device", ""},
		{"empty", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host := DiscoveredHost{
				IP:       "10.0.0.1",
				SNMPData: &SNMPInfo{SysDescr: tt.sysDescr},
			}
			_, manufacturer, _ := ClassifyAsset(host)
			if manufacturer != tt.want {
				t.Fatalf("ClassifyAsset() manufacturer = %q, want %q", manufacturer, tt.want)
			}
		})
	}
}

func TestClassifyAssetNoSNMP(t *testing.T) {
	host := DiscoveredHost{
		IP:        "10.0.0.50",
		OpenPorts: []OpenPort{{Port: 22, Service: "ssh"}},
	}
	_, manufacturer, model := ClassifyAsset(host)
	if manufacturer != "" {
		t.Fatalf("manufacturer should be empty without SNMP, got %q", manufacturer)
	}
	if model != "" {
		t.Fatalf("model should be empty without SNMP, got %q", model)
	}
}

func TestClassifyAssetModelFromSNMPObjectID(t *testing.T) {
	host := DiscoveredHost{
		IP: "10.0.0.51",
		SNMPData: &SNMPInfo{
			SysDescr:    "Linux server",
			SysObjectID: "1.3.6.1.4.1.8072.3.2.10",
		},
	}
	_, _, model := ClassifyAsset(host)
	if model != "1.3.6.1.4.1.8072.3.2.10" {
		t.Fatalf("model = %q, want %q", model, "1.3.6.1.4.1.8072.3.2.10")
	}
}

func TestIsGatewayIP(t *testing.T) {
	tests := []struct {
		name string
		ip   string
		want bool
	}{
		{"gateway_1", "192.168.1.1", true},
		{"gateway_254", "192.168.1.254", true},
		{"not_gateway_100", "192.168.1.100", false},
		{"not_gateway_0", "192.168.1.0", false},
		{"not_gateway_255", "192.168.1.255", false},
		{"gateway_10_1", "10.0.0.1", true},
		{"invalid_ip", "not-an-ip", false},
		{"empty_string", "", false},
		{"ipv6", "::1", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isGatewayIP(tt.ip); got != tt.want {
				t.Fatalf("isGatewayIP(%q) = %v, want %v", tt.ip, got, tt.want)
			}
		})
	}
}

func TestHasPort(t *testing.T) {
	ports := []OpenPort{
		{Port: 22, Service: "ssh"},
		{Port: 80, Service: "http"},
		{Port: 443, Service: "https"},
	}

	tests := []struct {
		port int
		want bool
	}{
		{22, true},
		{80, true},
		{443, true},
		{8080, false},
		{0, false},
	}

	for _, tt := range tests {
		if got := hasPort(ports, tt.port); got != tt.want {
			t.Fatalf("hasPort(ports, %d) = %v, want %v", tt.port, got, tt.want)
		}
	}
}

func TestHasPortEmptySlice(t *testing.T) {
	if hasPort(nil, 80) {
		t.Fatal("hasPort(nil, 80) should be false")
	}
	if hasPort([]OpenPort{}, 80) {
		t.Fatal("hasPort([], 80) should be false")
	}
}

func TestHasAnyPort(t *testing.T) {
	ports := []OpenPort{
		{Port: 22, Service: "ssh"},
		{Port: 5432, Service: "postgres"},
	}

	if !hasAnyPort(ports, []int{3306, 5432, 6379}) {
		t.Fatal("hasAnyPort should return true when one port matches")
	}
	if hasAnyPort(ports, []int{3306, 1433, 6379}) {
		t.Fatal("hasAnyPort should return false when no ports match")
	}
	if hasAnyPort(nil, []int{22}) {
		t.Fatal("hasAnyPort(nil, ...) should be false")
	}
	if hasAnyPort(ports, nil) {
		t.Fatal("hasAnyPort(ports, nil) should be false")
	}
}

func TestClassifyAssetPrinterPriorityOverRouter(t *testing.T) {
	// Printer should take priority over router even if SNMP says router
	host := DiscoveredHost{
		IP:        "10.0.0.60",
		SNMPData:  &SNMPInfo{SysDescr: "HP Printer with router capabilities"},
		OpenPorts: []OpenPort{{Port: 9100, Service: "printer"}},
	}
	assetType, _, _ := ClassifyAsset(host)
	if assetType != "printer" {
		t.Fatalf("printer should take priority, got %q", assetType)
	}
}

func TestClassifyAssetFirewallByObjectID(t *testing.T) {
	host := DiscoveredHost{
		IP:       "10.0.0.61",
		SNMPData: &SNMPInfo{SysObjectID: "1.3.6.1.4.1.9.firewall.1"},
	}
	assetType, _, _ := ClassifyAsset(host)
	if assetType != "firewall" {
		t.Fatalf("firewall by OID, got %q", assetType)
	}
}
