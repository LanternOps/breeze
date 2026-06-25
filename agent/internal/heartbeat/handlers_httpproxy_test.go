package heartbeat

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/tunnel"
)

// TestFetchAndEncodeHttp exercises the post-guard fetch→encode path against a
// loopback httptest server. This helper does NOT run IsBlocked, so binding to
// 127.0.0.1 is fine here — the guards are tested separately in
// TestHandleHttpRequest. This runs deterministically in ANY environment,
// including CI containers that only have a loopback interface.
func TestFetchAndEncodeHttp(t *testing.T) {
	const responseBody = "hello from loopback proxy"

	var gotHeader string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHeader = r.Header.Get("X-Forwarded-Probe")
		w.Header().Set("X-Test", "yes")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(responseBody))
	}))
	defer srv.Close()

	u, err := url.Parse(srv.URL)
	if err != nil {
		t.Fatalf("parse server URL: %v", err)
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil {
		t.Fatalf("parse server port: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	result := fetchAndEncodeHttp(ctx, tunnel.FetchRequest{
		Scheme:  "http",
		Host:    u.Hostname(),
		Port:    port,
		Method:  "GET",
		Path:    "/",
		Headers: map[string][]string{"X-Forwarded-Probe": {"probe-value"}},
	}, time.Now())

	if result.Status != "completed" {
		t.Fatalf("status = %q, error = %q, want completed", result.Status, result.Error)
	}

	var payload struct {
		Status    int                 `json:"status"`
		Headers   map[string][]string `json:"headers"`
		BodyB64   string              `json:"bodyB64"`
		Truncated bool                `json:"truncated"`
	}
	if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
		t.Fatalf("unmarshal stdout: %v\nstdout=%s", err, result.Stdout)
	}

	if payload.Status != http.StatusOK {
		t.Errorf("payload.status = %d, want 200", payload.Status)
	}
	if payload.Truncated {
		t.Errorf("payload.truncated = true, want false")
	}

	body, err := base64.StdEncoding.DecodeString(payload.BodyB64)
	if err != nil {
		t.Fatalf("decode bodyB64: %v", err)
	}
	if string(body) != responseBody {
		t.Errorf("body = %q, want %q", string(body), responseBody)
	}

	if vals := payload.Headers["X-Test"]; len(vals) == 0 || vals[0] != "yes" {
		t.Errorf("X-Test response header = %v, want [yes]", vals)
	}

	if gotHeader != "probe-value" {
		t.Errorf("forwarded request header X-Forwarded-Probe = %q, want %q", gotHeader, "probe-value")
	}
}

// TestHandleHttpRequest covers the full-handler guard paths and an end-to-end
// happy path. The blocked/empty-allowlist subtests run everywhere; the
// end-to-end subtest needs a non-loopback interface (127/8 is block-listed) and
// skips gracefully where none exists — the fetch→encode path is covered
// deterministically by TestFetchAndEncodeHttp regardless.
func TestHandleHttpRequest(t *testing.T) {
	t.Run("blocked target is rejected", func(t *testing.T) {
		// 127.0.0.1 is on the hardcoded block list for non-VNC connections.
		result := handleHttpRequest(&Heartbeat{}, Command{
			Payload: map[string]any{
				"targetHost":     "127.0.0.1",
				"targetPort":     float64(8080),
				"scheme":         "http",
				"method":         "GET",
				"path":           "/",
				"allowlistRules": []any{"127.0.0.1/32:8080"},
			},
		})

		if result.Status != "failed" {
			t.Fatalf("status = %q, want failed", result.Status)
		}
		if !strings.Contains(result.Error, "blocked") {
			t.Fatalf("error = %q, want 'blocked' mention", result.Error)
		}
	})

	t.Run("empty allowlist is rejected", func(t *testing.T) {
		// A public-routable IP that is not on the block list but has no allowlist rules.
		result := handleHttpRequest(&Heartbeat{}, Command{
			Payload: map[string]any{
				"targetHost": "203.0.113.1", // TEST-NET-3, not in blockedNetworks
				"targetPort": float64(80),
				"scheme":     "http",
				"method":     "GET",
				"path":       "/",
				// allowlistRules absent → empty slice → deny
			},
		})

		if result.Status != "failed" {
			t.Fatalf("status = %q, want failed", result.Status)
		}
		if !strings.Contains(result.Error, "not permitted") {
			t.Fatalf("error = %q, want 'not permitted' mention", result.Error)
		}
	})

	t.Run("unsupported scheme is rejected", func(t *testing.T) {
		result := handleHttpRequest(&Heartbeat{}, Command{
			Payload: map[string]any{
				"targetHost":     "203.0.113.5",
				"targetPort":     float64(80),
				"scheme":         "file",
				"method":         "GET",
				"path":           "/etc/passwd",
				"allowlistRules": []any{"203.0.113.5/32:80"},
			},
		})

		if result.Status != "failed" {
			t.Fatalf("status = %q, want failed", result.Status)
		}
		if !strings.Contains(result.Error, "unsupported scheme") {
			t.Fatalf("error = %q, want 'unsupported scheme' mention", result.Error)
		}
	})

	t.Run("host-injection path is rejected", func(t *testing.T) {
		// A path of "@evil.example/x" would, under naive string concat, re-parse
		// so the host becomes evil.example — bypassing the allowlist. The handler
		// must reject it before any fetch.
		result := handleHttpRequest(&Heartbeat{}, Command{
			Payload: map[string]any{
				"targetHost":     "203.0.113.5",
				"targetPort":     float64(80),
				"scheme":         "http",
				"method":         "GET",
				"path":           "@evil.example/x",
				"allowlistRules": []any{"203.0.113.5/32:80"},
			},
		})

		if result.Status != "failed" {
			t.Fatalf("status = %q, want failed", result.Status)
		}
		if !strings.Contains(result.Error, "path must start with /") {
			t.Fatalf("error = %q, want 'path must start with /' mention", result.Error)
		}
	})

	t.Run("skipTlsVerify=true threads through handler and accepts self-signed HTTPS cert (Leg A)", func(t *testing.T) {
		// Leg A: proves skipTlsVerify flows from cmd.Payload through handleHttpRequest
		// into tunnel.FetchRequest.SkipTLSVerify. The self-signed cert used by
		// httptest.StartTLS() would be rejected by default TLS verification; if the
		// flag did NOT thread through, this subtest would get "failed"/"tls_cert_untrusted"
		// instead of "completed". Non-vacuity: flip skipTlsVerify to false (or remove
		// it) and the test fails — the completed result is only achievable because the
		// flag disabled cert verification all the way down.
		host := nonLoopbackIPv4(t)
		if host == "" {
			t.Skip("no non-loopback IPv4 address available; skipping TLS threading test")
		}

		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		ln, err := net.Listen("tcp", "0.0.0.0:0")
		if err != nil {
			t.Skipf("cannot bind TLS test server: %v", err)
		}
		srv.Listener = ln
		srv.StartTLS()
		defer srv.Close()

		port := srv.Listener.Addr().(*net.TCPAddr).Port
		allowlistRule := host + "/32:" + strconv.Itoa(port)

		result := handleHttpRequest(&Heartbeat{}, Command{
			Payload: map[string]any{
				"targetHost":     host,
				"targetPort":     float64(port),
				"scheme":         "https",
				"skipTlsVerify":  true,
				"method":         "GET",
				"path":           "/",
				"allowlistRules": []any{allowlistRule},
			},
		})

		if result.Status != "completed" {
			t.Fatalf("Leg A: status = %q, error = %q; want completed (skipTlsVerify must reach Fetch to accept the self-signed cert)", result.Status, result.Error)
		}
	})

	t.Run("skipTlsVerify=false (default) rejects self-signed HTTPS cert with stable token (Leg B)", func(t *testing.T) {
		// Leg B: proves the verify-on path through handleHttpRequest yields the stable
		// "tls_cert_untrusted" error token. Mirrors Leg A's setup but omits
		// skipTlsVerify so it defaults to false, which should trigger cert rejection.
		host := nonLoopbackIPv4(t)
		if host == "" {
			t.Skip("no non-loopback IPv4 address available; skipping TLS threading test")
		}

		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		ln, err := net.Listen("tcp", "0.0.0.0:0")
		if err != nil {
			t.Skipf("cannot bind TLS test server: %v", err)
		}
		srv.Listener = ln
		srv.StartTLS()
		defer srv.Close()

		port := srv.Listener.Addr().(*net.TCPAddr).Port
		allowlistRule := host + "/32:" + strconv.Itoa(port)

		result := handleHttpRequest(&Heartbeat{}, Command{
			Payload: map[string]any{
				"targetHost": host,
				"targetPort": float64(port),
				"scheme":     "https",
				// skipTlsVerify omitted → defaults to false → cert verification ON
				"method":         "GET",
				"path":           "/",
				"allowlistRules": []any{allowlistRule},
			},
		})

		if result.Status != "failed" {
			t.Fatalf("Leg B: status = %q, want failed (self-signed cert must be rejected when skipTlsVerify=false)", result.Status)
		}
		if result.Error != "tls_cert_untrusted" {
			t.Fatalf("Leg B: error = %q, want tls_cert_untrusted (stable API token must be returned)", result.Error)
		}
	})

	t.Run("allowed target returns completed result with decoded body", func(t *testing.T) {
		const responseBody = "hello from proxy"

		// 127.0.0.1 is block-listed, so we bind the test server to all
		// interfaces and connect via the machine's non-loopback IPv4 address so
		// IsBlocked passes. If no such address exists (e.g. loopback-only CI),
		// skip — the fetch→encode path is covered by TestFetchAndEncodeHttp.
		srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-Test", "yes")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(responseBody))
		}))

		ln, err := net.Listen("tcp", "0.0.0.0:0")
		if err != nil {
			t.Skipf("cannot bind test server: %v", err)
		}
		srv.Listener = ln
		srv.Start()
		defer srv.Close()

		port := srv.Listener.Addr().(*net.TCPAddr).Port

		host := nonLoopbackIPv4(t)
		if host == "" {
			t.Skip("no non-loopback IPv4 address available; skipping network proxy test")
		}

		allowlistRule := host + "/32:" + strconv.Itoa(port)

		result := handleHttpRequest(&Heartbeat{}, Command{
			Payload: map[string]any{
				"targetHost":     host,
				"targetPort":     float64(port),
				"scheme":         "http",
				"method":         "GET",
				"path":           "/",
				"allowlistRules": []any{allowlistRule},
			},
		})

		if result.Status != "completed" {
			t.Fatalf("status = %q, error = %q, want completed", result.Status, result.Error)
		}

		var payload struct {
			Status    int                 `json:"status"`
			Headers   map[string][]string `json:"headers"`
			BodyB64   string              `json:"bodyB64"`
			Truncated bool                `json:"truncated"`
		}
		if err := json.Unmarshal([]byte(result.Stdout), &payload); err != nil {
			t.Fatalf("unmarshal stdout: %v\nstdout=%s", err, result.Stdout)
		}

		if payload.Status != http.StatusOK {
			t.Errorf("payload.status = %d, want 200", payload.Status)
		}
		if payload.Truncated {
			t.Errorf("payload.truncated = true, want false")
		}

		body, err := base64.StdEncoding.DecodeString(payload.BodyB64)
		if err != nil {
			t.Fatalf("decode bodyB64: %v", err)
		}
		if string(body) != responseBody {
			t.Errorf("body = %q, want %q", string(body), responseBody)
		}

		if vals := payload.Headers["X-Test"]; len(vals) == 0 || vals[0] != "yes" {
			t.Errorf("X-Test header = %v, want [yes]", vals)
		}
	})
}

func TestFetchAndEncodeHttp_TLSCertUntrusted(t *testing.T) {
	// Self-signed TLS server; SkipTLSVerify=false must yield the typed token.
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
	}))
	defer srv.Close()

	host, portStr, _ := net.SplitHostPort(strings.TrimPrefix(srv.URL, "https://"))
	port, _ := strconv.Atoi(portStr)

	res := fetchAndEncodeHttp(context.Background(), tunnel.FetchRequest{
		Scheme: "https", Host: host, Port: port, Method: "GET", Path: "/",
		SkipTLSVerify: false,
	}, time.Now())

	if res.Status != "failed" {
		t.Fatalf("want failed, got %q", res.Status)
	}
	if res.Error != "tls_cert_untrusted" {
		t.Fatalf("want error token tls_cert_untrusted, got %q", res.Error)
	}
}

// nonLoopbackIPv4 returns the first non-loopback IPv4 address on the machine,
// or "" if none is found.
func nonLoopbackIPv4(t *testing.T) string {
	t.Helper()
	ifaces, err := net.Interfaces()
	if err != nil {
		return ""
	}
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil || ip.IsLoopback() {
				continue
			}
			if v4 := ip.To4(); v4 != nil {
				return v4.String()
			}
		}
	}
	return ""
}
