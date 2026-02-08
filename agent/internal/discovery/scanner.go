package discovery

import (
	"bytes"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"strings"
	"time"
)

// ScanConfig defines the parameters for a network discovery scan.
type ScanConfig struct {
	Subnets          []string
	ExcludeIPs       []string
	Methods          []string
	PortRanges       []string
	SNMPCommunities  []string
	Timeout          time.Duration
	Concurrency      int
	DeepScan         bool
	IdentifyOS       bool
	ResolveHostnames bool
}

// OpenPort represents an open TCP port and the identified service.
type OpenPort struct {
	Port    int    `json:"port"`
	Service string `json:"service"`
}

// SNMPInfo captures basic SNMP system identifiers.
type SNMPInfo struct {
	SysDescr    string `json:"sysDescr"`
	SysObjectID string `json:"sysObjectId"`
	SysName     string `json:"sysName"`
}

// DiscoveredHost represents a device found during discovery.
type DiscoveredHost struct {
	IP             string     `json:"ip"`
	MAC            string     `json:"mac,omitempty"`
	Hostname       string     `json:"hostname,omitempty"`
	NetbiosName    string     `json:"netbiosName,omitempty"`
	AssetType      string     `json:"assetType"`
	Manufacturer   string     `json:"manufacturer,omitempty"`
	Model          string     `json:"model,omitempty"`
	OpenPorts      []OpenPort `json:"openPorts,omitempty"`
	OSFingerprint  string     `json:"osFingerprint,omitempty"`
	SNMPData       *SNMPInfo  `json:"snmpData,omitempty"`
	ResponseTimeMs float64    `json:"responseTimeMs,omitempty"`
	Methods        []string   `json:"methods"`
	FirstSeen      time.Time  `json:"firstSeen"`
	LastSeen       time.Time  `json:"lastSeen"`
}

// Scanner coordinates network discovery methods.
type Scanner struct {
	config ScanConfig
}

// NewScanner creates a new Scanner with the given configuration.
func NewScanner(config ScanConfig) *Scanner {
	return &Scanner{
		config: normalizeConfig(config),
	}
}

// Scan executes the configured discovery methods and returns discovered hosts.
func (s *Scanner) Scan() ([]DiscoveredHost, error) {
	slog.Info("Starting network discovery scan")

	subnets, err := parseSubnets(s.config.Subnets)
	if err != nil {
		return nil, err
	}
	if len(subnets) == 0 {
		return nil, fmt.Errorf("no valid subnets provided")
	}

	exclude := make(map[string]struct{}, len(s.config.ExcludeIPs))
	for _, ip := range s.config.ExcludeIPs {
		exclude[ip] = struct{}{}
	}

	targets := expandTargets(subnets, exclude, s.config.DeepScan)
	if len(targets) == 0 {
		return nil, fmt.Errorf("no target IPs to scan")
	}

	methods := normalizeMethods(s.config.Methods)
	hosts := make(map[string]*DiscoveredHost)
	now := time.Now()

	if methods["arp"] {
		arpResults, err := ScanARP(subnets, exclude, s.config.Timeout)
		if err != nil {
			slog.Warn("ARP scan failed", "error", err)
		}
		for ip, mac := range arpResults {
			host := getOrCreateHost(hosts, ip, now)
			host.MAC = mac
			host.Methods = addMethod(host.Methods, "arp")
		}
	}

	var aliveTargets []net.IP
	if methods["ping"] {
		pingResults := PingSweep(targets, s.config.Timeout, s.config.Concurrency)
		for _, pr := range pingResults {
			aliveTargets = append(aliveTargets, pr.IP)
			host := getOrCreateHost(hosts, pr.IP.String(), now)
			host.ResponseTimeMs = float64(pr.RTT.Microseconds()) / 1000.0
			host.Methods = addMethod(host.Methods, "ping")
		}
	}

	portTargets := targets
	if len(aliveTargets) > 0 {
		portTargets = aliveTargets
	}

	if methods["ports"] || methods["port_scan"] {
		portRanges, err := parsePortRanges(s.config.PortRanges)
		if err != nil {
			return nil, err
		}
		portResults := ScanPorts(portTargets, portRanges, s.config.Timeout, s.config.Concurrency)
		for ip, openPorts := range portResults {
			host := getOrCreateHost(hosts, ip, now)
			host.OpenPorts = openPorts
			host.Methods = addMethod(host.Methods, "port_scan")
		}
	}

	if methods["snmp"] {
		snmpResults := DiscoverSNMP(portTargets, s.config.SNMPCommunities, s.config.Timeout, s.config.Concurrency)
		for ip, snmpInfo := range snmpResults {
			host := getOrCreateHost(hosts, ip, now)
			host.SNMPData = snmpInfo
			host.Methods = addMethod(host.Methods, "snmp")
		}
	}

	// Fill in missing MACs from the OS ARP cache.
	// After port scanning, hosts are typically in the kernel ARP table
	// even if pcap-based ARP scan failed (requires root).
	arpCache := ReadARPCache()
	for ip, mac := range arpCache {
		if host, ok := hosts[ip]; ok && host.MAC == "" {
			host.MAC = mac
		}
	}

	for _, host := range hosts {
		if s.config.ResolveHostnames {
			if hostname := resolveHostname(host.IP); hostname != "" {
				host.Hostname = hostname
			}
		}
		if s.config.IdentifyOS {
			host.OSFingerprint = fingerprintOS(*host)
		}
		host.AssetType, host.Manufacturer, host.Model = ClassifyAsset(*host)
		host.LastSeen = time.Now()
	}

	result := make([]DiscoveredHost, 0, len(hosts))
	for _, host := range hosts {
		result = append(result, *host)
	}

	sort.Slice(result, func(i, j int) bool {
		return compareIPs(result[i].IP, result[j].IP)
	})

	slog.Info("Scan completed", "hostsDiscovered", len(result))
	return result, nil
}

func normalizeConfig(config ScanConfig) ScanConfig {
	if config.Timeout == 0 {
		config.Timeout = 2 * time.Second
	}
	if config.Concurrency <= 0 {
		config.Concurrency = 128
	}
	if len(config.Methods) == 0 {
		config.Methods = []string{"arp", "ping", "port_scan", "snmp"}
	}
	if len(config.PortRanges) == 0 {
		config.PortRanges = []string{"22,80,443,445,3389,161,139,135,5985,5986,9100"}
	}
	if len(config.SNMPCommunities) == 0 {
		config.SNMPCommunities = []string{"public"}
	}
	return config
}

func normalizeMethods(methods []string) map[string]bool {
	result := make(map[string]bool, len(methods))
	for _, method := range methods {
		result[strings.ToLower(strings.TrimSpace(method))] = true
	}
	return result
}

func parseSubnets(subnets []string) ([]*net.IPNet, error) {
	if len(subnets) == 0 {
		return nil, nil
	}

	parsed := make([]*net.IPNet, 0, len(subnets))
	for _, subnet := range subnets {
		subnet = strings.TrimSpace(subnet)
		if subnet == "" {
			continue
		}

		if strings.Contains(subnet, "/") {
			_, ipNet, err := net.ParseCIDR(subnet)
			if err != nil {
				return nil, fmt.Errorf("invalid subnet %q: %w", subnet, err)
			}
			parsed = append(parsed, ipNet)
			continue
		}

		ip := net.ParseIP(subnet)
		if ip == nil {
			return nil, fmt.Errorf("invalid IP %q", subnet)
		}
		ipNet := &net.IPNet{IP: ip, Mask: net.CIDRMask(32, 32)}
		parsed = append(parsed, ipNet)
	}

	return parsed, nil
}

func expandTargets(subnets []*net.IPNet, exclude map[string]struct{}, deepScan bool) []net.IP {
	var targets []net.IP
	for _, subnet := range subnets {
		if subnet == nil || subnet.IP.To4() == nil {
			continue
		}

		ones, bits := subnet.Mask.Size()
		hosts := uint64(1) << uint(bits-ones)
		if hosts > 65536 && !deepScan {
			slog.Warn("Subnet too large, enable DeepScan to scan fully", "subnet", subnet.String())
			continue
		}

		for ip := subnet.IP.Mask(subnet.Mask); subnet.Contains(ip); incIP(ip) {
			ipCopy := make(net.IP, len(ip))
			copy(ipCopy, ip)
			if ipCopy.To4() == nil {
				continue
			}
			if _, excluded := exclude[ipCopy.String()]; excluded {
				continue
			}
			targets = append(targets, ipCopy)
		}
	}
	return targets
}

func incIP(ip net.IP) {
	for j := len(ip) - 1; j >= 0; j-- {
		ip[j]++
		if ip[j] != 0 {
			break
		}
	}
}

func parsePortRanges(ranges []string) ([]PortRange, error) {
	var result []PortRange
	for _, entry := range ranges {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		parts := strings.Split(entry, ",")
		for _, part := range parts {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			if strings.Contains(part, "-") {
				bounds := strings.SplitN(part, "-", 2)
				start, err := parsePort(bounds[0])
				if err != nil {
					return nil, err
				}
				end, err := parsePort(bounds[1])
				if err != nil {
					return nil, err
				}
				if start > end {
					start, end = end, start
				}
				result = append(result, PortRange{Start: start, End: end})
				continue
			}

			port, err := parsePort(part)
			if err != nil {
				return nil, err
			}
			result = append(result, PortRange{Start: port, End: port})
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("no valid port ranges provided")
	}
	return result, nil
}

func parsePort(value string) (int, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, fmt.Errorf("empty port value")
	}
	var port int
	_, err := fmt.Sscanf(value, "%d", &port)
	if err != nil || port <= 0 || port > 65535 {
		return 0, fmt.Errorf("invalid port %q", value)
	}
	return port, nil
}

func getOrCreateHost(hosts map[string]*DiscoveredHost, ip string, now time.Time) *DiscoveredHost {
	host, ok := hosts[ip]
	if !ok {
		host = &DiscoveredHost{IP: ip, FirstSeen: now, LastSeen: now}
		hosts[ip] = host
	}
	return host
}

func addMethod(methods []string, method string) []string {
	for _, existing := range methods {
		if existing == method {
			return methods
		}
	}
	return append(methods, method)
}

func resolveHostname(ip string) string {
	addrs, err := net.LookupAddr(ip)
	if err != nil || len(addrs) == 0 {
		return ""
	}
	return strings.TrimSuffix(addrs[0], ".")
}

func fingerprintOS(host DiscoveredHost) string {
	if host.SNMPData != nil {
		lower := strings.ToLower(host.SNMPData.SysDescr)
		switch {
		case strings.Contains(lower, "windows"):
			return "Windows"
		case strings.Contains(lower, "linux"):
			return "Linux"
		case strings.Contains(lower, "darwin"):
			return "macOS"
		case strings.Contains(lower, "cisco"):
			return "Cisco IOS"
		}
	}

	for _, port := range host.OpenPorts {
		switch port.Port {
		case 3389, 445, 139:
			return "Windows"
		case 22:
			return "Unix"
		}
	}

	return ""
}

func compareIPs(a, b string) bool {
	ipA := net.ParseIP(a)
	ipB := net.ParseIP(b)
	if ipA == nil || ipB == nil {
		return a < b
	}
	return bytes.Compare(ipA.To4(), ipB.To4()) < 0
}
