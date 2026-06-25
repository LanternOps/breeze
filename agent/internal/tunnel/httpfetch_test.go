package tunnel

import (
	"context"
	"crypto/tls"
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
		if r.URL.Path == "/echo" && r.Method == http.MethodPost {
			b, _ := io.ReadAll(r.Body)
			w.Header().Set("X-Seen", "yes")
			w.WriteHeader(201)
			w.Write([]byte("got:" + string(b)))
			return
		}
		w.Write([]byte("hello-plain"))
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
		resp, err := Fetch(context.Background(), FetchRequest{Scheme: "http", Host: h, Port: p, Method: "POST", Path: "/echo", Body: []byte("ping")}, 5*time.Second, 1<<20)
		if err != nil {
			t.Fatal(err)
		}
		if resp.Status != 201 || string(resp.Body) != "got:ping" || resp.Headers["X-Seen"][0] != "yes" {
			t.Fatalf("got %d %q %v", resp.Status, resp.Body, resp.Headers)
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
		_ = tls.VersionTLS12
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
