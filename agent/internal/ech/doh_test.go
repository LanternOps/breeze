package ech

import (
	"context"
	"encoding/base64"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

const okBody = `{"Status":0,"Answer":[{"type":65,"TTL":300,"data":"1 . ech=AEX+DQBB"}]}`

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestParseECHParam_Extracts(t *testing.T) {
	got, err := parseECHParam("1 . alpn=h3,h2 ipv4hint=1.2.3.4 ech=AEX+DQBB ipv6hint=::1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if string(got) != string(mustB64(t, "AEX+DQBB")) {
		t.Fatalf("got %x", got)
	}

	got, err = parseECHParam(`1 . ech="AEX+DQBB"`)
	if err != nil || string(got) != string(mustB64(t, "AEX+DQBB")) {
		t.Fatalf("quoted: %x %v", got, err)
	}

	if _, err := parseECHParam("1 . alpn=h2"); !errors.Is(err, ErrNoECHConfig) {
		t.Fatalf("want ErrNoECHConfig, got %v", err)
	}

	_, err = parseECHParam("1 . ech=!!!notbase64")
	if err == nil || errors.Is(err, ErrNoECHConfig) {
		t.Fatalf("want decode error, got %v", err)
	}
}

func TestResolver_UsesAcceptHeaderAndFirstEndpoint(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Accept") != "application/dns-json" {
			t.Errorf("Accept = %q", r.Header.Get("Accept"))
		}
		if r.URL.Query().Get("type") != "HTTPS" {
			t.Errorf("type = %q", r.URL.Query().Get("type"))
		}
		if r.URL.Query().Get("name") != "example.test" {
			t.Errorf("name = %q", r.URL.Query().Get("name"))
		}
		_, _ = w.Write([]byte(okBody))
	}))
	defer srv.Close()

	cfg, err := NewResolver(srv.Client(), srv.URL).Lookup(context.Background(), "example.test")
	if err != nil {
		t.Fatal(err)
	}
	if string(cfg.ConfigList) != string(mustB64(t, "AEX+DQBB")) {
		t.Fatalf("ConfigList = %x", cfg.ConfigList)
	}
	if cfg.TTL != 300*time.Second {
		t.Fatalf("TTL = %v", cfg.TTL)
	}
}

func TestResolver_FallsBackToSecondEndpoint(t *testing.T) {
	var firstHits int32
	first := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&firstHits, 1)
		http.Error(w, "boom", http.StatusInternalServerError)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(okBody))
	}))
	defer second.Close()

	cfg, err := NewResolver(nil, first.URL, second.URL).Lookup(context.Background(), "example.test")
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.ConfigList) == 0 {
		t.Fatal("empty config")
	}
	if n := atomic.LoadInt32(&firstHits); n != 1 {
		t.Fatalf("first endpoint hit %d times", n)
	}
}

func TestResolver_NoAnswerIsErrNoECHConfig(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`{"Status":0,"Answer":[{"type":65,"TTL":60,"data":"1 . alpn=h2"}]}`))
	}))
	defer srv.Close()

	_, err := NewResolver(srv.Client(), srv.URL).Lookup(context.Background(), "example.test")
	if !errors.Is(err, ErrNoECHConfig) {
		t.Fatalf("want ErrNoECHConfig, got %v", err)
	}
}

func TestResolver_TTLClamped(t *testing.T) {
	for _, tc := range []struct {
		ttl  string
		want time.Duration
	}{{"10", 5 * time.Minute}, {"100000", 24 * time.Hour}} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(`{"Status":0,"Answer":[{"type":65,"TTL":` + tc.ttl + `,"data":"1 . ech=AEX+DQBB"}]}`))
		}))
		cfg, err := NewResolver(srv.Client(), srv.URL).Lookup(context.Background(), "example.test")
		srv.Close()
		if err != nil {
			t.Fatal(err)
		}
		if cfg.TTL != tc.want {
			t.Fatalf("ttl %s: got %v want %v", tc.ttl, cfg.TTL, tc.want)
		}
	}
}

func TestResolver_RespectsContextDeadline(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-time.After(2 * time.Second):
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	start := time.Now()
	_, err := NewResolver(srv.Client(), srv.URL).Lookup(ctx, "example.test")
	if err == nil {
		t.Fatal("expected error")
	}
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Fatalf("took %v", d)
	}
}
