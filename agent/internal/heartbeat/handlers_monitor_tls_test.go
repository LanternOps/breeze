package heartbeat

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/remote/tools"
)

// runHttpCheck drives handleNetworkHttpCheck the way the command router does and
// decodes the JSON result map the API stores verbatim into
// network_monitor_results.details.
func runHttpCheck(t *testing.T, payload map[string]any) map[string]any {
	t.Helper()
	res := handleNetworkHttpCheck(nil, Command{
		ID:      "cmd-1",
		Type:    string(tools.CmdNetworkHttpCheck),
		Payload: payload,
	})
	if res.Status != "completed" {
		t.Fatalf("expected completed result, got status=%q error=%q", res.Status, res.Error)
	}
	var out map[string]any
	if err := json.Unmarshal([]byte(res.Stdout), &out); err != nil {
		t.Fatalf("result stdout is not JSON: %v (%s)", err, res.Stdout)
	}
	return out
}

func hostOf(t *testing.T, raw string) string {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse %q: %v", raw, err)
	}
	return u.Host
}

// The expiring_certs sweep kind (#4230) reads typed TLS columns that are fed
// exclusively by these keys. The observed host is mandatory because redirects
// are followed by default, so the certificate can belong to a different
// endpoint than the monitor's target — a finding that omits it names the wrong
// host. sslState is emitted rather than derived because a handshake failure
// returns before certificate extraction, and the server cannot otherwise tell
// "plain HTTP" from "handshake failed" from "never ran".
func TestHandleNetworkHttpCheck_TLSObservation(t *testing.T) {
	t.Run("https observes the certificate, issuer and host", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		out := runHttpCheck(t, map[string]any{
			"monitorId": "m1",
			"url":       srv.URL,
			"verifySsl": false,
		})

		if got := out["sslState"]; got != "observed" {
			t.Errorf("sslState = %v, want observed", got)
		}
		if got, _ := out["sslIssuer"].(string); got == "" {
			t.Errorf("sslIssuer is empty, want the certificate issuer DN")
		}
		if got := out["sslObservedHost"]; got != hostOf(t, srv.URL) {
			t.Errorf("sslObservedHost = %v, want %s", got, hostOf(t, srv.URL))
		}
		expiry, _ := out["sslExpiry"].(string)
		if _, err := time.Parse(time.RFC3339, expiry); err != nil {
			t.Errorf("sslExpiry %q does not parse as RFC3339: %v", expiry, err)
		}
	})

	t.Run("plain http reports not_tls with no certificate fields", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		out := runHttpCheck(t, map[string]any{"monitorId": "m2", "url": srv.URL})

		if got := out["sslState"]; got != "not_tls" {
			t.Errorf("sslState = %v, want not_tls", got)
		}
		if _, ok := out["sslExpiry"]; ok {
			t.Errorf("sslExpiry present on a plain-HTTP check: %v", out["sslExpiry"])
		}
		if _, ok := out["sslIssuer"]; ok {
			t.Errorf("sslIssuer present on a plain-HTTP check: %v", out["sslIssuer"])
		}
		if got := out["sslObservedHost"]; got != hostOf(t, srv.URL) {
			t.Errorf("sslObservedHost = %v, want %s", got, hostOf(t, srv.URL))
		}
	})

	t.Run("failed handshake reports handshake_failed, never a silent null expiry", func(t *testing.T) {
		srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer srv.Close()

		// verifySsl=true against httptest's self-signed certificate fails the
		// handshake inside client.Do, before any certificate is available.
		out := runHttpCheck(t, map[string]any{
			"monitorId": "m3",
			"url":       srv.URL,
			"verifySsl": true,
		})

		if got := out["status"]; got != "offline" {
			t.Errorf("status = %v, want offline", got)
		}
		if got := out["sslState"]; got != "handshake_failed" {
			t.Errorf("sslState = %v, want handshake_failed", got)
		}
		if _, ok := out["sslExpiry"]; ok {
			t.Errorf("sslExpiry present on a failed handshake: %v", out["sslExpiry"])
		}
		if _, ok := out["sslIssuer"]; ok {
			t.Errorf("sslIssuer present on a failed handshake: %v", out["sslIssuer"])
		}
	})

	t.Run("a transport failure against an http target is not a handshake failure", func(t *testing.T) {
		// Port 0 never accepts, so client.Do fails at the TCP layer.
		out := runHttpCheck(t, map[string]any{"monitorId": "m4", "url": "http://127.0.0.1:0/"})

		if got := out["status"]; got != "offline" {
			t.Errorf("status = %v, want offline", got)
		}
		if got, ok := out["sslState"]; ok {
			t.Errorf("sslState = %v on a plain-HTTP transport failure, want absent", got)
		}
	})

	// The masking case. `http.Client.Do` follows redirects by building a NEW
	// request per hop and never mutates the caller's, so keying the
	// handshake_failed emission off the ORIGINAL request's scheme reports
	// nothing when an http:// monitor redirects to a broken https endpoint.
	// The API then sees no sslState, leaves the stored observation untouched,
	// and a stale `observed` row keeps reading as "fine" while the endpoint is
	// failing TLS right now — exactly what tls_state exists to prevent.
	t.Run("a handshake failure reached VIA a redirect from http is still handshake_failed", func(t *testing.T) {
		broken := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer broken.Close()

		plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, broken.URL, http.StatusFound)
		}))
		defer plain.Close()

		out := runHttpCheck(t, map[string]any{
			"monitorId":       "m6",
			"url":             plain.URL, // http://
			"verifySsl":       true,      // the self-signed cert fails on the SECOND hop
			"followRedirects": true,
		})

		if got := out["status"]; got != "offline" {
			t.Errorf("status = %v, want offline", got)
		}
		if got := out["sslState"]; got != "handshake_failed" {
			t.Errorf("sslState = %v, want handshake_failed (the failing hop was https)", got)
		}
		// Naming the original http host would point an operator at the wrong
		// endpoint; the broken one is the one that needs fixing.
		if got := out["sslObservedHost"]; got != hostOf(t, broken.URL) {
			t.Errorf("sslObservedHost = %v, want the failing hop %s", got, hostOf(t, broken.URL))
		}
	})

	t.Run("after a redirect the observed host is the FINAL hop", func(t *testing.T) {
		final := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusOK)
		}))
		defer final.Close()

		first := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, final.URL, http.StatusFound)
		}))
		defer first.Close()

		out := runHttpCheck(t, map[string]any{
			"monitorId":       "m5",
			"url":             first.URL,
			"verifySsl":       false,
			"followRedirects": true,
		})

		if got := out["sslState"]; got != "observed" {
			t.Errorf("sslState = %v, want observed", got)
		}
		if got := out["sslObservedHost"]; got != hostOf(t, final.URL) {
			t.Errorf("sslObservedHost = %v, want the FINAL hop %s (not %s)",
				got, hostOf(t, final.URL), hostOf(t, first.URL))
		}
	})
}

// Installing ANY CheckRedirect replaces net/http's default, which is what
// caps a chain at 10 hops. Restoring the cap explicitly is the only thing
// standing between a redirect LOOP and a check that runs hops for the whole
// timeout window, every polling interval, from agent-shipped code.
func TestHandleNetworkHttpCheck_RedirectLoopIsCapped(t *testing.T) {
	var a, b *httptest.Server
	a = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, b.URL, http.StatusFound)
	}))
	defer a.Close()
	b = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, a.URL, http.StatusFound)
	}))
	defer b.Close()

	out := runHttpCheck(t, map[string]any{
		"monitorId":       "loop",
		"url":             a.URL,
		"followRedirects": true,
		"timeout":         30, // long enough that only the hop cap can stop this
	})

	if got := out["status"]; got != "offline" {
		t.Errorf("status = %v, want offline", got)
	}
	errText, _ := out["error"].(string)
	if !strings.Contains(errText, "redirect") {
		t.Errorf("error = %q, want it to name the redirect cap", errText)
	}
}

// varchar(255) columns must never reject a writeback, so the agent truncates.
func TestTruncateObservation(t *testing.T) {
	long := strings.Repeat("a", 400)
	if got := truncateObservation(long); len(got) != maxTlsObservationLen {
		t.Errorf("truncateObservation kept %d bytes, want %d", len(got), maxTlsObservationLen)
	}
	if got := truncateObservation("short"); got != "short" {
		t.Errorf("truncateObservation(%q) = %q, want unchanged", "short", got)
	}
	// Must not split a multi-byte rune into an invalid UTF-8 sequence.
	multi := strings.Repeat("é", 200) // 400 bytes
	got := truncateObservation(multi)
	if len(got) > maxTlsObservationLen {
		t.Errorf("truncateObservation returned %d bytes, want <= %d", len(got), maxTlsObservationLen)
	}
	for i, r := range got {
		if r == '�' {
			t.Errorf("truncation produced an invalid rune at byte %d", i)
		}
	}
}
