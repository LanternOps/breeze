package tunnel

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestFetchDialsCheckedAddressAndKeepsRequestHost(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, r.Host+"|"+r.TLS.ServerName)
	}))
	defer server.Close()
	_, portText, err := net.SplitHostPort(strings.TrimPrefix(server.URL, "https://"))
	if err != nil {
		t.Fatal(err)
	}
	port, _ := strconv.Atoi(portText)

	// service.invalid never resolves, so the request only succeeds when Fetch
	// dials the supplied address instead of resolving the name again.
	response, err := Fetch(context.Background(), FetchRequest{
		Scheme: "https", Host: "service.invalid", DialIP: "127.0.0.1", Port: port,
		Method: "GET", Path: "/", SkipTLSVerify: true,
	}, 5*time.Second, 1024)
	if err != nil {
		t.Fatal(err)
	}
	want := net.JoinHostPort("service.invalid", portText) + "|service.invalid"
	if string(response.Body) != want {
		t.Fatalf("body = %q, want %q", response.Body, want)
	}
}

func TestFetchRejectsNonNumericDialAddress(t *testing.T) {
	if _, err := Fetch(context.Background(), FetchRequest{
		Scheme: "http", Host: "service.invalid", DialIP: "other.invalid", Port: 80, Method: "GET", Path: "/",
	}, time.Second, 1024); err == nil {
		t.Fatal("non-numeric dial address accepted")
	}
}
