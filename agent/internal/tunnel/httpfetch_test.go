package tunnel

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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
}
