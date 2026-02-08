package discovery

import (
	"bufio"
	"log/slog"
	"net"
	"os/exec"
	"regexp"
	"runtime"
	"strings"
)

// macPattern matches MAC addresses in common formats: aa:bb:cc:dd:ee:ff or aa-bb-cc-dd-ee-ff
var macPattern = regexp.MustCompile(`([0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2}[:\-][0-9a-fA-F]{1,2})`)

// ReadARPCache reads the OS ARP table to get IP-to-MAC mappings without requiring root.
// Works on macOS (`arp -a`), Linux (`arp -an`), and Windows (`arp -a`).
// Useful as a fallback when pcap-based ARP scanning fails due to permissions.
func ReadARPCache() map[string]string {
	results := make(map[string]string)

	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("arp", "-a")
	case "linux":
		cmd = exec.Command("arp", "-an")
	case "windows":
		cmd = exec.Command("arp", "-a")
	default:
		slog.Debug("ARP cache reading not supported on this OS", "os", runtime.GOOS)
		return results
	}

	out, err := cmd.Output()
	if err != nil {
		slog.Debug("Failed to read ARP cache", "error", err)
		return results
	}

	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		line := scanner.Text()
		ip, mac := parseARPLine(line)
		if ip != "" && mac != "" {
			results[ip] = mac
		}
	}

	// Also add the local machine's own IPs — these won't be in the ARP cache
	// because you don't ARP yourself.
	addLocalInterfaces(results)

	slog.Debug("Read ARP cache", "entries", len(results))
	return results
}

// addLocalInterfaces adds the machine's own IP→MAC mappings from its network interfaces.
func addLocalInterfaces(results map[string]string) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		if len(iface.HardwareAddr) == 0 {
			continue
		}
		mac := iface.HardwareAddr.String()
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipNet, ok := addr.(*net.IPNet)
			if !ok || ipNet.IP.To4() == nil {
				continue
			}
			ip := ipNet.IP.String()
			if _, exists := results[ip]; !exists {
				results[ip] = mac
			}
		}
	}
}

// parseARPLine extracts IP and MAC from a single line of arp output.
// Handles formats:
//   - macOS:  "? (192.168.0.1) at aa:bb:cc:dd:ee:ff on en0 ifscope [ethernet]"
//   - Linux:  "? (192.168.0.1) at aa:bb:cc:dd:ee:ff [ether] on eth0"
//   - Windows: "  192.168.0.1          aa-bb-cc-dd-ee-ff     dynamic"
func parseARPLine(line string) (string, string) {
	line = strings.TrimSpace(line)
	if line == "" {
		return "", ""
	}

	// Skip incomplete entries
	lower := strings.ToLower(line)
	if strings.Contains(lower, "incomplete") || strings.Contains(lower, "(incomplete)") {
		return "", ""
	}

	// Extract IP: look for (x.x.x.x) pattern or bare IP
	var ip string
	if idx := strings.Index(line, "("); idx >= 0 {
		end := strings.Index(line[idx:], ")")
		if end > 0 {
			candidate := line[idx+1 : idx+end]
			if net.ParseIP(candidate) != nil {
				ip = candidate
			}
		}
	}
	if ip == "" {
		// Windows format: bare IP at start of line
		fields := strings.Fields(line)
		if len(fields) >= 2 {
			if net.ParseIP(fields[0]) != nil {
				ip = fields[0]
			}
		}
	}

	if ip == "" {
		return "", ""
	}

	// Extract MAC
	macMatch := macPattern.FindString(line)
	if macMatch == "" {
		return "", ""
	}

	// Normalize MAC to colon-separated lowercase with zero-padded octets
	mac := normalizeMAC(macMatch)
	if mac == "" {
		return "", ""
	}

	return ip, mac
}

// normalizeMAC converts a MAC address to the standard format: aa:bb:cc:dd:ee:ff
func normalizeMAC(raw string) string {
	hw, err := net.ParseMAC(raw)
	if err != nil {
		return ""
	}
	return hw.String()
}
