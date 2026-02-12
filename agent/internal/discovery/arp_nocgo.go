//go:build !cgo

package discovery

import (
	"log/slog"
	"net"
	"time"
)

// ScanARP is a no-op when built without CGO since gopacket/pcap requires CGO.
// The scanner will fall back to reading the OS ARP cache instead.
func ScanARP(subnets []*net.IPNet, exclude map[string]struct{}, timeout time.Duration) (map[string]string, error) {
	slog.Info("ARP scan unavailable (built without CGO/pcap), falling back to ARP cache")
	return make(map[string]string), nil
}
