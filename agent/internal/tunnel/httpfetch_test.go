package tunnel

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestFetch(t *testing.T) {
	plain := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/echo" && r.Method == http.MethodPost:
			b, _ := io.ReadAll(r.Body)
			w.Header().Set("X-Seen", "yes")
			// Echo back a request header so the test can assert forwarding.
			w.Header().Set("X-Echoed-Forward", r.Header.Get("X-Forward-Me"))
			w.WriteHeader(201)
			w.Write([]byte("got:" + string(b)))
		case r.URL.Path == "/hop":
			// Report whether the target saw the hop-by-hop request header.
			w.Header().Set("X-Saw-TE", r.Header.Get("Transfer-Encoding"))
			w.Header().Set("X-Saw-Connection", r.Header.Get("Connection"))
			// And emit a hop-by-hop response header that must be stripped.
			w.Header().Set("Connection", "keep-alive")
			w.Write([]byte("hop-ok"))
		case r.URL.Path == "/redirect":
			w.Header().Set("Location", "/other")
			w.WriteHeader(http.StatusMovedPermanently)
		case strings.HasPrefix(r.URL.EscapedPath(), "/foo"):
			// Report the escaped path so the test can assert %2F survived.
			w.Header().Set("X-Escaped-Path", r.URL.EscapedPath())
			w.Header().Set("X-Request-URI", r.RequestURI)
			w.Write([]byte("escaped-ok"))
		default:
			w.Write([]byte("hello-plain"))
		}
	}))
	defer plain.Close()

	tlsSrv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("hello-tls"))
	}))
	defer tlsSrv.Close()

	hostPort := func(u string) (string, int) {
		u = strings.TrimPrefix(strings.TrimPrefix(u, "http://"), "https://")
		parts := strings.SplitN(u, ":", 2)
		p, _ := strconv.Atoi(parts[1])
		return parts[0], p
	}

	t.Run("plain GET", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "http", Host: h, Port: p, Method: "GET", Path: "/"}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != 200 || string(resp.Body) != "hello-plain" {
			t.Fatalf("got %d %q", resp.Status, resp.Body)
		}
	})

	t.Run("POST body + headers", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{
			Scheme:  "http",
			Host:    h,
			Port:    p,
			Method:  "POST",
			Path:    "/echo",
			Headers: map[string][]string{"X-Forward-Me": {"myval"}},
			Body:    []byte("ping"),
		}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != 201 || string(resp.Body) != "got:ping" || resp.Headers["X-Seen"][0] != "yes" {
			t.Fatalf("got %d %q %v", resp.Status, resp.Body, resp.Headers)
		}
		// The forwarded request header must have reached the target.
		if got := resp.Headers["X-Echoed-Forward"]; len(got) == 0 || got[0] != "myval" {
			t.Fatalf("expected forwarded header X-Forward-Me=myval, target saw %v", got)
		}
	})

	t.Run("hop-by-hop headers stripped both directions", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{
			Scheme: "http",
			Host:   h,
			Port:   p,
			Method: "GET",
			Path:   "/hop",
			Headers: map[string][]string{
				"Transfer-Encoding": {"identity"},
				"Connection":        {"keep-alive"},
			},
		}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		// (a) Target must NOT have seen our forwarded hop-by-hop request headers.
		// Note: the transport sets its own "Connection: close" because
		// DisableKeepAlives is true, so we assert our forwarded "keep-alive"
		// value specifically did not pass through (not that it is empty).
		if got := resp.Headers["X-Saw-Te"]; len(got) > 0 && got[0] != "" {
			t.Fatalf("target saw forwarded Transfer-Encoding request header: %v", got)
		}
		if got := resp.Headers["X-Saw-Connection"]; len(got) > 0 && got[0] == "keep-alive" {
			t.Fatalf("target saw forwarded Connection: keep-alive request header: %v", got)
		}
		// (b) Hop-by-hop response header must be stripped from the result.
		if _, ok := resp.Headers["Connection"]; ok {
			t.Fatalf("Connection response header should have been stripped, got %v", resp.Headers["Connection"])
		}
	})

	t.Run("redirects are not followed", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "http", Host: h, Port: p, Method: "GET", Path: "/redirect"}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != http.StatusMovedPermanently {
			t.Fatalf("expected 301 (no redirect follow), got %d", resp.Status)
		}
		if got := resp.Headers["Location"]; len(got) == 0 || got[0] != "/other" {
			t.Fatalf("expected Location: /other preserved, got %v", got)
		}
	})

	t.Run("self-signed TLS accepted", func(t *testing.T) {
		h, p := hostPort(tlsSrv.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "https", Host: h, Port: p, Method: "GET", Path: "/"}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if string(resp.Body) != "hello-tls" {
			t.Fatalf("got %q", resp.Body)
		}
	})

	t.Run("body cap truncates", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "http", Host: h, Port: p, Method: "GET", Path: "/"}, 5*time.Second, 4)
		if err != nil {
			t.Fatal(err)
		}
		if !resp.Truncated || len(resp.Body) != 4 {
			t.Fatalf("expected truncated 4 bytes, got %d trunc=%v", len(resp.Body), resp.Truncated)
		}
	})

	// SECURITY: a malicious path must never subvert the pinned host. Each of
	// these would, under naive string concatenation, re-parse so the host
	// becomes evil.example (host-injection SSRF / allowlist bypass). Fetch must
	// reject them with an error and perform NO request against the real target.
	t.Run("malicious paths are rejected without a request", func(t *testing.T) {
		var hits int32
		guard := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			atomic.AddInt32(&hits, 1)
			w.Write([]byte("should-not-be-reached"))
		}))
		defer guard.Close()
		h, p := hostPort(guard.URL)

		for _, badPath := range []string{
			"@evil.example/x",       // userinfo injection → host becomes evil.example
			"http://evil.example/x", // absolute URL
			"//evil.example/x",      // scheme-relative URL → host becomes evil.example
			"x/y",                   // no leading slash
		} {
			resp, err := Fetch(context.Background(), FetchRequest{
				Scheme: "http", Host: h, Port: p, Method: "GET", Path: badPath,
			}, 5*time.Second, 1<<20)
			if err == nil {
				t.Fatalf("path %q: expected error, got nil (resp=%+v)", badPath, resp)
			}
			if resp != nil {
				t.Fatalf("path %q: expected nil response on rejection, got %+v", badPath, resp)
			}
		}

		if n := atomic.LoadInt32(&hits); n != 0 {
			t.Fatalf("expected 0 requests to the target for malicious paths, got %d", n)
		}
	})

	t.Run("normal path with query still works", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{
			Scheme: "http", Host: h, Port: p, Method: "GET", Path: "/?q=1",
		}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != 200 || string(resp.Body) != "hello-plain" {
			t.Fatalf("got %d %q", resp.Status, resp.Body)
		}
	})

	// Device APIs may distinguish an encoded slash (%2F) from a real one, so the
	// proxy must preserve the encoded form rather than normalizing it away.
	t.Run("encoded path preserves %2F", func(t *testing.T) {
		h, p := hostPort(plain.URL)
		resp, err := Fetch(context.Background(), FetchRequest{
			Scheme: "http", Host: h, Port: p, Method: "GET", Path: "/foo%2Fbar",
		}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != 200 || string(resp.Body) != "escaped-ok" {
			t.Fatalf("got %d %q", resp.Status, resp.Body)
		}
		if got := resp.Headers["X-Escaped-Path"]; len(got) == 0 || !strings.Contains(got[0], "%2F") {
			t.Fatalf("target saw escaped path %v, want one containing %%2F", got)
		}
		if got := resp.Headers["X-Request-Uri"]; len(got) == 0 || !strings.Contains(got[0], "%2F") {
			t.Fatalf("target saw request URI %v, want one containing %%2F", got)
		}
	})
}
