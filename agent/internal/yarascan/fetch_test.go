package yarascan

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

const goldenSetID = "00000000-0000-4000-8000-000000000001"

func goldenRef(sum string) RuleSetRef {
	return RuleSetRef{ID: goldenSetID, Version: 3, SHA256: sum, URL: "/api/v1/agents/a/yara/rule-sets/" + goldenSetID + "/3"}
}

func serve(t *testing.T, status int, body []byte, wantAuth string, gotPath *atomic.Value) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if gotPath != nil {
			gotPath.Store(r.URL.Path)
		}
		if r.Header.Get("Authorization") != wantAuth {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", BundleContentType)
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func fetcher(srv *httptest.Server) *HTTPFetcher {
	return &HTTPFetcher{BaseURL: srv.URL, Client: srv.Client(), AuthHeader: func() string { return "Bearer tok" }}
}

func TestFetchGolden(t *testing.T) {
	body, sum := golden(t)
	var path atomic.Value
	srv := serve(t, 200, body, "Bearer tok", &path)
	b, rerr := fetcher(srv).Fetch(context.Background(), goldenRef(sum))
	if rerr != nil || b == nil || b.Version != 3 {
		t.Fatalf("fetch failed: %+v %+v", b, rerr)
	}
	if got := path.Load(); got != goldenRef(sum).URL {
		t.Fatalf("requested path %v, want %s", got, goldenRef(sum).URL)
	}
}

func TestFetchPreservesBaseURLPathPrefix(t *testing.T) {
	body, sum := golden(t)
	var path atomic.Value
	srv := serve(t, 200, body, "Bearer tok", &path)
	f := fetcher(srv)
	f.BaseURL = srv.URL + "/breeze/"
	if _, rerr := f.Fetch(context.Background(), goldenRef(sum)); rerr != nil {
		t.Fatalf("fetch failed: %+v", rerr)
	}
	if got := path.Load(); got != "/breeze"+goldenRef(sum).URL {
		t.Fatalf("requested path %v, want the base path prefix kept", got)
	}
}

func TestFetchSendsAgentToken(t *testing.T) {
	body, sum := golden(t)
	srv := serve(t, 200, body, "Bearer tok", nil)
	f := fetcher(srv)
	f.AuthHeader = func() string { return "Bearer wrong" }
	if _, rerr := f.Fetch(context.Background(), goldenRef(sum)); rerr == nil || rerr.Code != CodeFetch || !strings.Contains(rerr.Detail, "401") {
		t.Fatalf("want an HTTP 401 fetch error, got %+v", rerr)
	}
}

func TestFetchMapsStatusCodes(t *testing.T) {
	for status, code := range map[int]string{404: CodeHTTP404, 409: CodeHTTP409, 500: CodeFetch, 503: CodeFetch, 304: CodeFetch} {
		srv := serve(t, status, nil, "Bearer tok", nil)
		_, rerr := fetcher(srv).Fetch(context.Background(), goldenRef(strings.Repeat("a", 64)))
		if rerr == nil || rerr.Code != code || rerr.ID != goldenSetID || rerr.Version != 3 {
			t.Errorf("status %d: want %s, got %+v", status, code, rerr)
		}
	}
}

func TestFetchRefusesRedirects(t *testing.T) {
	var otherHits atomic.Int64
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { otherHits.Add(1); w.WriteHeader(200) }))
	defer other.Close()
	for name, to := range map[string]string{"cross-host": other.URL + "/x", "same-host": "/api/v1/agents/a/elsewhere"} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/api/v1/agents/a/elsewhere" {
				w.WriteHeader(200)
				return
			}
			http.Redirect(w, r, to, http.StatusFound)
		}))
		_, rerr := fetcher(srv).Fetch(context.Background(), goldenRef(strings.Repeat("a", 64)))
		srv.Close()
		if rerr == nil || rerr.Code != CodeFetch || !strings.Contains(rerr.Detail, "redirect") {
			t.Errorf("%s redirect followed: %+v", name, rerr)
		}
	}
	if otherHits.Load() != 0 {
		t.Fatal("the redirect target was contacted")
	}
}

func TestFetchCapsBody(t *testing.T) {
	big := []byte(strings.Repeat("x", MaxBundleBytes+1))
	srv := serve(t, 200, big, "Bearer tok", nil)
	_, rerr := fetcher(srv).Fetch(context.Background(), goldenRef(sha256Hex(big)))
	if rerr == nil || rerr.Code != CodeBundleInvalid {
		t.Fatalf("oversized body accepted: %+v", rerr)
	}
}

func TestFetchSHA256Mismatch(t *testing.T) {
	body, _ := golden(t)
	srv := serve(t, 200, body, "Bearer tok", nil)
	_, rerr := fetcher(srv).Fetch(context.Background(), goldenRef(strings.Repeat("b", 64)))
	if rerr == nil || rerr.Code != CodeSHA256Mismatch {
		t.Fatalf("want sha256_mismatch, got %+v", rerr)
	}
}

func TestFetchRejectsBundleForOtherSetOrVersion(t *testing.T) {
	body, sum := golden(t)
	srv := serve(t, 200, body, "Bearer tok", nil)
	for _, ref := range []RuleSetRef{
		{ID: "00000000-0000-4000-8000-000000000009", Version: 3, SHA256: sum, URL: goldenRef(sum).URL},
		{ID: goldenSetID, Version: 4, SHA256: sum, URL: goldenRef(sum).URL},
	} {
		if _, rerr := fetcher(srv).Fetch(context.Background(), ref); rerr == nil || rerr.Code != CodeBundleInvalid {
			t.Errorf("ref %+v: want bundle_invalid, got %+v", ref, rerr)
		}
	}
}

func TestFetchRejectsUnvalidatedURL(t *testing.T) {
	var hits atomic.Int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { hits.Add(1) }))
	defer srv.Close()
	ref := goldenRef(strings.Repeat("a", 64))
	ref.URL = "https://evil.example/api/v1/agents/a"
	if _, rerr := fetcher(srv).Fetch(context.Background(), ref); rerr == nil || rerr.Code != CodeFetch {
		t.Fatalf("absolute url accepted: %+v", rerr)
	}
	if hits.Load() != 0 {
		t.Fatal("request sent for an invalid url")
	}
}

func TestFetchHonoursContext(t *testing.T) {
	srv := serve(t, 200, nil, "Bearer tok", nil)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, rerr := fetcher(srv).Fetch(ctx, goldenRef(strings.Repeat("a", 64))); rerr == nil || rerr.Code != CodeFetch {
		t.Fatalf("cancelled context: want fetch error, got %+v", rerr)
	}
}
