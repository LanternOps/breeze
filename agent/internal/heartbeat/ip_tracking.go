package heartbeat

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/collectors"
	"github.com/breeze-rmm/agent/internal/config"
)

const ipStateFileName = "ip_state.json"

// IPHistoryEntry represents a single IP assignment for tracking.
type IPHistoryEntry struct {
	InterfaceName  string   `json:"interfaceName"`
	IPAddress      string   `json:"ipAddress"`
	IPType         string   `json:"ipType"` // "ipv4" or "ipv6"
	AssignmentType string   `json:"assignmentType"`
	MACAddress     string   `json:"macAddress,omitempty"`
	SubnetMask     string   `json:"subnetMask,omitempty"`
	Gateway        string   `json:"gateway,omitempty"`
	DNSServers     []string `json:"dnsServers,omitempty"`
}

// IPHistoryUpdate contains IP changes detected since last heartbeat.
type IPHistoryUpdate struct {
	DeviceID   string           `json:"deviceId,omitempty"`
	CurrentIPs []IPHistoryEntry `json:"currentIPs"`
	ChangedIPs []IPHistoryEntry `json:"changedIPs"`
	RemovedIPs []IPHistoryEntry `json:"removedIPs"`
	DetectedAt time.Time        `json:"detectedAt"`
}

func ipEntryKey(entry IPHistoryEntry) string {
	return entry.InterfaceName + "|" + entry.IPAddress + "|" + entry.IPType
}

func entryMetadataChanged(previous, current IPHistoryEntry) bool {
	if previous.AssignmentType != current.AssignmentType {
		return true
	}
	if previous.MACAddress != current.MACAddress {
		return true
	}
	if previous.SubnetMask != current.SubnetMask {
		return true
	}
	if previous.Gateway != current.Gateway {
		return true
	}
	if len(previous.DNSServers) != len(current.DNSServers) {
		return true
	}
	for i := range previous.DNSServers {
		if previous.DNSServers[i] != current.DNSServers[i] {
			return true
		}
	}
	return false
}

// detectIPChanges compares current network state with previous state.
func detectIPChanges(current, previous []IPHistoryEntry) (changed, removed []IPHistoryEntry) {
	prevMap := make(map[string]IPHistoryEntry, len(previous))
	for _, ip := range previous {
		prevMap[ipEntryKey(ip)] = ip
	}

	currMap := make(map[string]IPHistoryEntry, len(current))
	for _, ip := range current {
		key := ipEntryKey(ip)
		currMap[key] = ip
		if prev, exists := prevMap[key]; !exists || entryMetadataChanged(prev, ip) {
			changed = append(changed, ip)
		}
	}

	for key, ip := range prevMap {
		if _, exists := currMap[key]; !exists {
			removed = append(removed, ip)
		}
	}

	sortIPHistoryEntries(changed)
	sortIPHistoryEntries(removed)

	return changed, removed
}

// determineAssignmentType heuristically determines if IP is DHCP, static, or VPN.
func determineAssignmentType(ifaceName, ipAddress string) string {
	if isVPNInterface(ifaceName) {
		return "vpn"
	}
	if isLinkLocal(ipAddress) {
		return "link-local"
	}
	if hasDHCPLease(ifaceName, ipAddress) {
		return "dhcp"
	}
	return "static"
}

// isVPNInterface checks whether an interface name likely represents a VPN interface.
func isVPNInterface(ifaceName string) bool {
	name := strings.ToLower(strings.TrimSpace(ifaceName))
	if name == "" {
		return false
	}

	prefixes := []string{"tun", "tap", "wg", "ppp", "utun"}
	for _, prefix := range prefixes {
		if strings.HasPrefix(name, prefix) {
			return true
		}
	}

	contains := []string{
		"vpn", "tailscale", "zerotier", "wireguard", "openvpn",
		"anyconnect", "globalprotect", "fortinet", "l2tp", "pptp",
		"ipsec", "protonvpn", "nordlynx", "hamachi", "wg",
	}
	for _, token := range contains {
		if strings.Contains(name, token) {
			return true
		}
	}

	return false
}

// hasDHCPLease uses lightweight interface/IP heuristics to infer DHCP assignment.
func hasDHCPLease(ifaceName, ipAddress string) bool {
	ip := net.ParseIP(ipAddress)
	if ip == nil || isVPNInterface(ifaceName) || isLinkLocal(ipAddress) {
		return false
	}

	name := strings.ToLower(strings.TrimSpace(ifaceName))
	if name == "" {
		return false
	}

	switch runtime.GOOS {
	case "linux":
		if linuxDHCPLeaseEvidence(ifaceName, ipAddress) {
			return true
		}
	case "darwin":
		if macOSDHCPLeaseEvidence(ifaceName, ipAddress) {
			return true
		}
	case "windows":
		if windowsDHCPLeaseEvidence(ifaceName, ipAddress) {
			return true
		}
	}

	switch runtime.GOOS {
	case "windows":
		if strings.Contains(name, "ethernet") || strings.Contains(name, "wi-fi") || strings.Contains(name, "wlan") {
			return ip.IsPrivate()
		}
	default:
		prefixes := []string{"eth", "en", "eno", "ens", "enp", "wlan", "wl"}
		for _, prefix := range prefixes {
			if strings.HasPrefix(name, prefix) {
				return ip.IsPrivate()
			}
		}
	}

	return false
}

func linuxDHCPLeaseEvidence(ifaceName, ipAddress string) bool {
	patterns := []string{
		"/run/systemd/netif/leases/*",
		"/var/lib/NetworkManager/*lease*",
		"/var/lib/dhcp/*.leases",
		"/var/lib/dhclient/*.leases",
	}

	for _, pattern := range patterns {
		matches, err := filepath.Glob(pattern)
		if err != nil || len(matches) == 0 {
			continue
		}
		for _, leasePath := range matches {
			if leaseFileContains(leasePath, ifaceName, ipAddress) {
				return true
			}
		}
	}

	return false
}

func leaseFileContains(path, ifaceName, ipAddress string) bool {
	data, err := os.ReadFile(path)
	if err != nil || len(data) == 0 {
		return false
	}

	content := strings.ToLower(string(data))
	iface := strings.ToLower(strings.TrimSpace(ifaceName))
	ip := strings.ToLower(strings.TrimSpace(ipAddress))

	if !strings.Contains(content, ip) {
		return false
	}
	if strings.Contains(content, iface) {
		return true
	}
	base := strings.ToLower(filepath.Base(path))
	return strings.Contains(base, iface)
}

func commandOutput(timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return exec.CommandContext(ctx, name, args...).CombinedOutput()
}

func macOSDHCPLeaseEvidence(ifaceName, ipAddress string) bool {
	out, err := commandOutput(750*time.Millisecond, "ipconfig", "getpacket", ifaceName)
	if err != nil || len(out) == 0 {
		return false
	}

	content := strings.ToLower(string(out))
	ip := strings.ToLower(strings.TrimSpace(ipAddress))
	if strings.Contains(content, "yiaddr") && strings.Contains(content, ip) {
		return true
	}
	return strings.Contains(content, "lease_time")
}

func windowsDHCPLeaseEvidence(ifaceName, ipAddress string) bool {
	out, err := commandOutput(1500*time.Millisecond, "ipconfig", "/all")
	if err != nil || len(out) == 0 {
		return false
	}

	section := windowsInterfaceSection(strings.ToLower(string(out)), strings.ToLower(strings.TrimSpace(ifaceName)))
	if section == "" {
		return false
	}

	if !strings.Contains(section, "dhcp enabled") || !strings.Contains(section, "yes") {
		return false
	}
	return strings.Contains(section, strings.ToLower(strings.TrimSpace(ipAddress)))
}

func windowsInterfaceSection(output, ifaceName string) string {
	idx := strings.Index(output, ifaceName)
	if idx < 0 {
		return ""
	}

	rest := output[idx:]
	next := strings.Index(rest, "\n\n")
	if next < 0 {
		return rest
	}
	return rest[:next]
}

// isLinkLocal checks if an IP is link-local.
func isLinkLocal(ipAddress string) bool {
	ip := net.ParseIP(ipAddress)
	if ip == nil {
		return false
	}

	if ipv4 := ip.To4(); ipv4 != nil {
		return ipv4[0] == 169 && ipv4[1] == 254
	}

	return ip.IsLinkLocalUnicast()
}

func normalizeIPType(value string, ipAddress string) string {
	typed := strings.ToLower(strings.TrimSpace(value))
	if typed == "ipv4" || typed == "ipv6" {
		return typed
	}
	if ip := net.ParseIP(ipAddress); ip != nil && ip.To4() == nil {
		return "ipv6"
	}
	return "ipv4"
}

func normalizeAssignmentType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "dhcp", "static", "vpn", "link-local", "unknown":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "unknown"
	}
}

func normalizeIPHistoryEntry(entry IPHistoryEntry) (IPHistoryEntry, bool) {
	entry.InterfaceName = strings.TrimSpace(entry.InterfaceName)
	entry.IPAddress = strings.TrimSpace(entry.IPAddress)
	entry.MACAddress = strings.TrimSpace(entry.MACAddress)
	entry.SubnetMask = strings.TrimSpace(entry.SubnetMask)
	entry.Gateway = strings.TrimSpace(entry.Gateway)
	entry.IPType = normalizeIPType(entry.IPType, entry.IPAddress)
	entry.AssignmentType = normalizeAssignmentType(entry.AssignmentType)

	if entry.InterfaceName == "" || entry.IPAddress == "" {
		return IPHistoryEntry{}, false
	}

	return entry, true
}

func dedupeEntries(entries []IPHistoryEntry) []IPHistoryEntry {
	byKey := make(map[string]IPHistoryEntry, len(entries))
	for _, entry := range entries {
		normalized, ok := normalizeIPHistoryEntry(entry)
		if !ok {
			continue
		}
		byKey[ipEntryKey(normalized)] = normalized
	}

	result := make([]IPHistoryEntry, 0, len(byKey))
	for _, entry := range byKey {
		result = append(result, entry)
	}
	sortIPHistoryEntries(result)
	return result
}

func sortIPHistoryEntries(entries []IPHistoryEntry) {
	sort.Slice(entries, func(i, j int) bool {
		left := entries[i]
		right := entries[j]
		if left.InterfaceName != right.InterfaceName {
			return left.InterfaceName < right.InterfaceName
		}
		if left.IPAddress != right.IPAddress {
			return left.IPAddress < right.IPAddress
		}
		return left.IPType < right.IPType
	})
}

func (h *Heartbeat) collectIPHistory() *IPHistoryUpdate {
	inventory := h.inventoryCol
	if inventory == nil {
		inventory = collectors.NewInventoryCollector()
	}

	adapters, err := inventory.CollectNetworkAdapters()
	if err != nil {
		log.Warn("failed to collect network adapters for ip history", "error", err)
		return nil
	}

	currentIPs := make([]IPHistoryEntry, 0, len(adapters))
	for _, adapter := range adapters {
		if strings.TrimSpace(adapter.IPAddress) == "" {
			continue
		}

		entry, ok := normalizeIPHistoryEntry(IPHistoryEntry{
			InterfaceName:  adapter.InterfaceName,
			IPAddress:      adapter.IPAddress,
			IPType:         adapter.IPType,
			AssignmentType: determineAssignmentType(adapter.InterfaceName, adapter.IPAddress),
			MACAddress:     adapter.MACAddress,
		})
		if !ok {
			continue
		}
		currentIPs = append(currentIPs, entry)
	}

	currentIPs = dedupeEntries(currentIPs)
	previousIPs := h.loadPreviousIPState()
	changedIPs, removedIPs := detectIPChanges(currentIPs, previousIPs)
	h.savePreviousIPState(currentIPs)

	if len(currentIPs) == 0 && len(changedIPs) == 0 && len(removedIPs) == 0 {
		return nil
	}

	return &IPHistoryUpdate{
		CurrentIPs: currentIPs,
		ChangedIPs: changedIPs,
		RemovedIPs: removedIPs,
		DetectedAt: time.Now().UTC(),
	}
}

func (h *Heartbeat) ipStatePath() string {
	if homeDir, err := os.UserHomeDir(); err == nil && strings.TrimSpace(homeDir) != "" {
		return filepath.Join(homeDir, ".breeze", ipStateFileName)
	}

	dataDir := strings.TrimSpace(config.GetDataDir())
	if dataDir == "" {
		return filepath.Join(os.TempDir(), "breeze", ipStateFileName)
	}
	return filepath.Join(dataDir, ipStateFileName)
}

// loadPreviousIPState loads IP history state from disk.
func (h *Heartbeat) loadPreviousIPState() []IPHistoryEntry {
	path := h.ipStatePath()
	raw, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Warn("failed to read ip history state", "path", path, "error", err)
		}
		return []IPHistoryEntry{}
	}

	var entries []IPHistoryEntry
	if err := json.Unmarshal(raw, &entries); err != nil {
		log.Warn("failed to decode ip history state", "path", path, "error", err)
		return []IPHistoryEntry{}
	}

	return dedupeEntries(entries)
}

// savePreviousIPState saves current IP state to disk.
func (h *Heartbeat) savePreviousIPState(current []IPHistoryEntry) {
	path := h.ipStatePath()
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		log.Warn("failed to create ip history state directory", "path", dir, "error", err)
		return
	}

	payload, err := json.Marshal(dedupeEntries(current))
	if err != nil {
		log.Warn("failed to encode ip history state", "error", err)
		return
	}

	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, payload, 0600); err != nil {
		log.Warn("failed to write ip history state temp file", "path", tmp, "error", err)
		return
	}

	if err := os.Rename(tmp, path); err != nil {
		log.Warn("failed to persist ip history state", "path", path, "error", err)
		_ = os.Remove(tmp)
	}
}
