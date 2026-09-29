package timesync

import (
	"net/netip"
	"regexp"
	"strings"
)

var hostLabel = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$`)
var peerFlags = regexp.MustCompile(`(?i)(?:,0x[0-9a-f]+)+$`)

func IsValidNtpServerHost(s string) bool {
	if len(s) == 0 || len(s) > 253 {
		return false
	}
	if ip, err := netip.ParseAddr(s); err == nil {
		return ip.Zone() == ""
	}
	for _, label := range strings.Split(s, ".") {
		if !hostLabel.MatchString(label) {
			return false
		}
	}
	return true
}

func ParseNtpServerHosts(raw string) []string {
	out := []string{}
	for _, item := range strings.Fields(raw) {
		out = append(out, peerFlags.ReplaceAllString(item, ""))
	}
	return out
}
