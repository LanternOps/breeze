package workloads

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type countingRoundTripper struct{ calls atomic.Int32 }

func (c *countingRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	c.calls.Add(1)
	return &http.Response{StatusCode: 200, Body: http.NoBody}, nil
}

func TestReadOnlyTransportRefusesBeforeAnyIO(t *testing.T) {
	cases := []struct{ method, url string }{
		{"POST", "http://engine/containers/create"},
		{"POST", "http://engine/containers/abc/start"},
		{"POST", "http://engine/containers/abc/stop"},
		{"DELETE", "http://engine/containers/abc"},
		{"PUT", "http://engine/containers/abc/archive"},
		{"PATCH", "http://engine/containers/json"},
		{"POST", "http://engine/containers/json?all=1"},
		{"POST", "http://engine/images/create?fromImage=nginx"},
		{"GET", "http://engine/containers/abc/json"},
		{"GET", "http://engine/containers/abc/logs"},
		{"GET", "http://engine/containers/json?all=1&filters=%7B%7D"},
		{"GET", "http://engine/containers/json?all=0"},
		{"GET", "http://engine/containers/json"},
		{"GET", "http://engine/images/json?all=1"},
		{"GET", "http://engine/images/json?manifests=1"},
		{"GET", "http://engine/images/json?identity=1"},
		{"GET", "http://engine/images/json?identity=1&manifests=1"},
		{"GET", "http://engine/images/json?manifests=1&identity=1&all=1"},
		{"GET", "http://engine/v1.43/containers/json?all=1"},
		{"GET", "http://engine/system/df"},
	}
	for _, tc := range cases {
		t.Run(tc.method+" "+tc.url, func(t *testing.T) {
			inner := &countingRoundTripper{}
			var body io.Reader
			if tc.method != "GET" {
				body = strings.NewReader("{}")
			}
			req, err := http.NewRequest(tc.method, tc.url, body)
			if err != nil {
				t.Fatal(err)
			}
			resp, err := ReadOnlyTransport{Inner: inner}.RoundTrip(req)
			if !errors.Is(err, ErrReadOnly) {
				t.Fatalf("err = %v, want ErrReadOnly", err)
			}
			if resp != nil {
				t.Fatal("refused request produced a response")
			}
			if inner.calls.Load() != 0 {
				t.Fatal("inner transport was reached")
			}
		})
	}
}

func TestReadOnlyTransportAllowsTheAllowlist(t *testing.T) {
	for _, u := range []string{
		"http://engine/_ping",
		"http://engine/version",
		"http://engine/containers/json?all=1",
		"http://engine/images/json",
		"http://engine/images/json?manifests=1&identity=1",
	} {
		inner := &countingRoundTripper{}
		req, _ := http.NewRequest("GET", u, nil)
		if _, err := (ReadOnlyTransport{Inner: inner}).RoundTrip(req); err != nil {
			t.Fatalf("%s refused: %v", u, err)
		}
		if inner.calls.Load() != 1 {
			t.Fatalf("%s did not reach inner", u)
		}
	}
}

// A refused request must not even open the socket: the dialer is never called.
func TestReadOnlyClientNeverDialsForRefusedRequests(t *testing.T) {
	var dials atomic.Int32
	client := newReadOnlyClient(func(context.Context) (net.Conn, error) {
		dials.Add(1)
		return nil, errors.New("must not dial")
	}, time.Second)
	for _, method := range []string{"POST", "DELETE", "PUT"} {
		req, _ := http.NewRequest(method, "http://engine/containers/abc/start", strings.NewReader("{}"))
		if _, err := client.Do(req); !errors.Is(err, ErrReadOnly) {
			t.Fatalf("%s: err = %v, want ErrReadOnly", method, err)
		}
	}
	if dials.Load() != 0 {
		t.Fatalf("dialer called %d times for refused requests", dials.Load())
	}
}

func TestReadOnlyClientGetOverCustomDialer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/_ping" {
			_, _ = w.Write([]byte("OK"))
			return
		}
		http.NotFound(w, r)
	}))
	defer srv.Close()
	var dials atomic.Int32
	client := newReadOnlyClient(func(ctx context.Context) (net.Conn, error) {
		dials.Add(1)
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}, 2*time.Second)
	resp, err := client.Get("http://engine/_ping")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(resp.Body)
	if string(body) != "OK" || dials.Load() != 1 {
		t.Fatalf("body=%q dials=%d", body, dials.Load())
	}
}
