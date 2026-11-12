package heartbeat

import (
	"strings"
	"testing"
)

func tunnelOpenPayload(host string, port int, tunnelType string, rules ...string) Command {
	raw := make([]interface{}, 0, len(rules))
	for _, r := range rules {
		raw = append(raw, r)
	}
	return Command{Payload: map[string]any{
		"tunnelId":       "tun-dest",
		"targetHost":     host,
		"targetPort":     float64(port),
		"tunnelType":     tunnelType,
		"allowlistRules": raw,
	}}
}

func TestTunnelOpenRefusesIPv6LoopbackAndLinkLocal(t *testing.T) {
	for _, host := range []string{"::1", "0:0:0:0:0:0:0:1", "fe80::1"} {
		result := handleTunnelOpen(&Heartbeat{}, tunnelOpenPayload(host, 8080, "proxy", "::/0:*"))
		if result.Status != "failed" || !strings.Contains(result.Error, "blocked") {
			t.Fatalf("host=%q result=%+v, want a blocked destination", host, result)
		}
	}
}

func TestTunnelOpenVNCTypeOnlyReachesLocalVNCEndpoint(t *testing.T) {
	for _, target := range []struct {
		host string
		port int
	}{
		{"::1", 5900},
		{"192.0.2.1", 5900},
		{"127.0.0.1", 22},
	} {
		result := handleTunnelOpen(&Heartbeat{}, tunnelOpenPayload(target.host, target.port, "vnc"))
		if result.Status != "failed" || !(strings.Contains(result.Error, "blocked") || strings.Contains(result.Error, "not permitted")) {
			t.Fatalf("vnc %s:%d result=%+v, want the destination refused", target.host, target.port, result)
		}
	}
}

func TestTunnelOpenAppliesIPv6DestinationRules(t *testing.T) {
	// Not in the rule: refused by the rules.
	result := handleTunnelOpen(&Heartbeat{}, tunnelOpenPayload("2001:db9::1", 443, "proxy", "2001:db8::/32:443"))
	if result.Status != "failed" || !strings.Contains(result.Error, "not permitted") {
		t.Fatalf("outside rule: %+v", result)
	}
	// Inside the rule: passes destination checks and reaches the manager.
	result = handleTunnelOpen(&Heartbeat{}, tunnelOpenPayload("2001:db8::1", 443, "proxy", "2001:db8::/32:443"))
	if result.Status != "failed" || !strings.Contains(result.Error, "tunnel manager not initialized") {
		t.Fatalf("inside rule: %+v, want destination accepted", result)
	}
}

func TestHttpRequestRefusesIPv6Loopback(t *testing.T) {
	for _, host := range []string{"::1", "fe80::1"} {
		result := handleHttpRequest(nil, Command{Payload: map[string]any{
			"targetHost":     host,
			"targetPort":     float64(8080),
			"method":         "GET",
			"path":           "/",
			"allowlistRules": []interface{}{"::/0:*"},
		}})
		if result.Status != "failed" || !strings.Contains(result.Error, "blocked") {
			t.Fatalf("host=%q result=%+v, want a blocked destination", host, result)
		}
	}
}
