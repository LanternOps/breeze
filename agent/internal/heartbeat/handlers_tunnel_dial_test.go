package heartbeat

import (
	"context"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/tunnel"
)

// stubCheckedDestination makes "printer.example" resolve to 192.0.2.10 and
// records what the handler passed to the destination check.
func stubCheckedDestination(t *testing.T) *[]string {
	t.Helper()
	var seenRules []string
	previous := resolveTunnelDestination
	resolveTunnelDestination = func(host string, port int, isVNC bool, rules []tunnel.AllowlistRule) (string, error) {
		if host != "printer.example" || port != 8443 || isVNC {
			t.Fatalf("destination check got %s:%d vnc=%v", host, port, isVNC)
		}
		for _, r := range rules {
			seenRules = append(seenRules, r.Network.String())
		}
		return "192.0.2.10", nil
	}
	t.Cleanup(func() { resolveTunnelDestination = previous })
	return &seenRules
}

func TestTunnelOpenConnectsToTheCheckedAddress(t *testing.T) {
	seenRules := stubCheckedDestination(t)
	var openedHost string
	var openedPort int
	previous := openTunnelSession
	openTunnelSession = func(_ *tunnel.Manager, _ string, host string, port int, _ string, _ tunnel.DataCallback, _ tunnel.CloseCallback) error {
		openedHost, openedPort = host, port
		return nil
	}
	t.Cleanup(func() { openTunnelSession = previous })

	h := &Heartbeat{tunnelMgr: tunnel.NewManager(false)}
	result := handleTunnelOpen(h, tunnelOpenPayload("printer.example", 8443, "proxy", "192.0.2.0/24:8443"))

	if result.Status != "completed" {
		t.Fatalf("result = %+v, want completed", result)
	}
	if openedHost != "192.0.2.10" || openedPort != 8443 {
		t.Fatalf("opened %s:%d, want the checked address 192.0.2.10:8443", openedHost, openedPort)
	}
	if len(*seenRules) != 1 || (*seenRules)[0] != "192.0.2.0/24" {
		t.Fatalf("destination check saw rules %v", *seenRules)
	}
}

func TestHttpRequestFetchesTheCheckedAddress(t *testing.T) {
	stubCheckedDestination(t)
	var got tunnel.FetchRequest
	previous := fetchTunnelHTTP
	fetchTunnelHTTP = func(_ context.Context, req tunnel.FetchRequest, _ time.Duration, _ int64) (*tunnel.FetchResponse, error) {
		got = req
		return &tunnel.FetchResponse{Status: 200}, nil
	}
	t.Cleanup(func() { fetchTunnelHTTP = previous })

	result := handleHttpRequest(nil, Command{Payload: map[string]any{
		"targetHost":     "printer.example",
		"targetPort":     float64(8443),
		"scheme":         "https",
		"method":         "GET",
		"path":           "/",
		"allowlistRules": []interface{}{"192.0.2.0/24:8443"},
	}})

	if result.Status != "completed" {
		t.Fatalf("result = %+v, want completed", result)
	}
	if got.DialIP != "192.0.2.10" || got.Host != "printer.example" || got.Port != 8443 {
		t.Fatalf("fetch got DialIP=%q Host=%q Port=%d, want the checked address with the original host", got.DialIP, got.Host, got.Port)
	}
}
