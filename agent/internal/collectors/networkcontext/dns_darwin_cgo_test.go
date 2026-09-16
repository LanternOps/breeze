//go:build darwin && cgo

package networkcontext

import "testing"

func TestSystemConfigurationStructuredDNS(t *testing.T) {
	raw := []byte(`<plist><dict><key>State:/Network/Service/a/IPv4</key><dict><key>InterfaceName</key><string>en0</string></dict><key>State:/Network/Service/a/DNS</key><dict><key>ServerAddresses</key><array><string>192.0.2.53</string></array><key>SupplementalMatchDomains</key><array><string>vpn.example.test</string></array></dict></dict></plist>`)
	s, e := parseSystemConfigurationDNS(raw)
	if e != nil || s.Outcome != Complete || len(s.Rows) != 1 || *s.Rows[0].InterfaceKey != "darwin-ifname:en0" || !s.Rows[0].Domains[0].RouteOnly {
		t.Fatal(s, e)
	}
}
