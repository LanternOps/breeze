package bmr

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestRecoveryDownloadProviderUsesAdvertisedAuthHeader(t *testing.T) {
	var sawAuth string
	var sawQueryToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/download" {
			http.NotFound(w, r)
			return
		}
		sawAuth = r.Header.Get("Authorization")
		sawQueryToken = r.URL.Query().Get("token")
		if got := r.URL.Query().Get("path"); got != "snapshots/provider-snapshot-1/manifest.json" {
			http.Error(w, "unexpected path", http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		Type:              "breeze_proxy",
		Method:            "GET",
		URL:               server.URL + "/download",
		TokenHeaderName:   "authorization",
		TokenHeaderFormat: "Bearer <recovery-token>",
		PathQueryParam:    "path",
		PathPrefix:        "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if sawAuth != "Bearer brz_rec_test" {
		t.Fatalf("Authorization header = %q, want bearer token", sawAuth)
	}
	if sawQueryToken != "" {
		t.Fatalf("query token = %q, want empty", sawQueryToken)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != `{"ok":true}` {
		t.Fatalf("downloaded data = %q", string(data))
	}
}

func TestRecoveryDownloadProviderFallsBackToLegacyQueryToken(t *testing.T) {
	var sawQueryToken string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawQueryToken = r.URL.Query().Get("legacy_token")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_legacy", &AuthenticatedDownloadDescriptor{
		Type:            "breeze_proxy",
		Method:          "GET",
		URL:             server.URL + "/download",
		TokenQueryParam: "legacy_token",
		PathQueryParam:  "path",
		PathPrefix:      "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if sawQueryToken != "brz_rec_legacy" {
		t.Fatalf("legacy query token = %q, want token", sawQueryToken)
	}
}

// closedOrigin starts a throwaway httptest server, captures its URL, then
// closes it immediately so nothing is listening there. Connecting to it
// fails fast and deterministically (connection refused) regardless of the
// host environment — standing in for D10's "descriptor points at a public
// URL unreachable from the operator's vantage point" scenario without
// depending on any real network resource.
func closedOrigin(t *testing.T) string {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("request must not reach the descriptor's original (unreachable) origin")
	}))
	origin := srv.URL
	srv.Close()
	return origin
}

func TestRecoveryDownloadProviderRewritesDescriptorOriginToServer(t *testing.T) {
	var sawPath, sawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawQuery = r.URL.Query().Get("path")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	descriptorOrigin := closedOrigin(t)

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		Type:           "breeze_proxy",
		Method:         "GET",
		URL:            descriptorOrigin + "/api/v1/backup/bmr/recover/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v (descriptor origin was not rewritten to --server)", err)
	}
	if sawPath != "/api/v1/backup/bmr/recover/download" {
		t.Fatalf("request path = %q, want rewritten descriptor path", sawPath)
	}
	if sawQuery != "snapshots/provider-snapshot-1/manifest.json" {
		t.Fatalf("request path query = %q", sawQuery)
	}
}

func TestRewriteDescriptorOriginLeavesSameOriginUnchanged(t *testing.T) {
	descriptor := &AuthenticatedDownloadDescriptor{
		URL:        "http://10.0.2.2:33933/api/v1/backup/bmr/recover/download",
		PathPrefix: "snapshots/x",
	}
	got := rewriteDescriptorOrigin("http://10.0.2.2:33933", descriptor)
	if got != descriptor {
		t.Fatalf("expected the same descriptor when origin already matches --server, got a rewritten copy: %+v", got)
	}
}

func TestRecoveryDownloadProviderResolvesRelativeDescriptorAgainstServer(t *testing.T) {
	var sawPath, sawQuery string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		sawQuery = r.URL.Query().Get("path")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            "/api/v1/backup/bmr/recover/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v (relative descriptor was not resolved against --server)", err)
	}
	if sawPath != "/api/v1/backup/bmr/recover/download" {
		t.Fatalf("request path = %q, want resolved relative descriptor path", sawPath)
	}
	if sawQuery != "snapshots/provider-snapshot-1/manifest.json" {
		t.Fatalf("request path query = %q", sawQuery)
	}
}

func TestRecoveryDownloadProviderRewritesHTTPSDescriptorToHTTPServerAndWarns(t *testing.T) {
	var sawPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawPath = r.URL.Path
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer server.Close()

	descriptorHost := strings.TrimPrefix(closedOrigin(t), "http://")

	var logBuf bytes.Buffer
	origLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	defer slog.SetDefault(origLogger)

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            "https://" + descriptorHost + "/api/v1/backup/bmr/recover/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "manifest.json")
	if err := provider.Download("snapshots/provider-snapshot-1/manifest.json", dest); err != nil {
		t.Fatalf("Download: %v (https descriptor was not rewritten to the http --server)", err)
	}
	if sawPath != "/api/v1/backup/bmr/recover/download" {
		t.Fatalf("request path = %q, want rewritten descriptor path", sawPath)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected a WARN log for the https->http downgrade, got: %s", logged)
	}
	if !strings.Contains(logged, "downgraded") {
		t.Fatalf("expected the warning to mention the https->http downgrade, got: %s", logged)
	}
}

// withFakeRetrySleep overrides the package-level retrySleep seam to record
// the durations the retry loop would have slept, without actually blocking,
// so these tests exercise the real retry/backoff accounting in milliseconds
// instead of real wall-clock minutes. Restored via t.Cleanup.
func withFakeRetrySleep(t *testing.T) *[]time.Duration {
	t.Helper()
	var recorded []time.Duration
	orig := retrySleep
	retrySleep = func(d time.Duration) { recorded = append(recorded, d) }
	t.Cleanup(func() { retrySleep = orig })
	return &recorded
}

// TestRecoveryDownloadProviderRetriesOn429AndHonorsRetryAfter is D13's core
// proof: the download route's per-token rate limiter answers 429 once ~100
// requests land in a 60s window (BMR_DOWNLOAD_TOKEN_LIMIT in bmr.ts), and a
// live 10,047-file recovery hit that wall after ~134 files, at which point
// every remaining file was treated as a PERMANENT failure. Download must
// instead retry with backoff, honoring Retry-After when the server sends
// one.
//
// The two 429s are deliberately shaped to discriminate a real fix from a
// coincidence: attempt 1 carries no Retry-After, so it falls back to the 1s
// initial exponential delay; that delay is then doubled to 2s for the next
// attempt. Attempt 2 carries "Retry-After: 1" — if the header is actually
// honored, the recorded wait is 1s (overriding the by-then-doubled 2s
// exponential value); if the header were ignored, the test would see 2s
// instead. A naive test with the header only on attempt 1 could pass by
// accident (1s is also the default initial delay).
func TestRecoveryDownloadProviderRetriesOn429AndHonorsRetryAfter(t *testing.T) {
	recorded := withFakeRetrySleep(t)

	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch atomic.AddInt32(&attempts, 1) {
		case 1:
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":"Rate limit exceeded. Please wait before retrying."}`)
		case 2:
			w.Header().Set("Retry-After", "1")
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = io.WriteString(w, `{"error":"Rate limit exceeded. Please wait before retrying."}`)
		default:
			_, _ = io.WriteString(w, `{"ok":true}`)
		}
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	if err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Fatalf("attempts = %d, want 3 (fail, fail, succeed)", got)
	}
	if len(*recorded) != 2 {
		t.Fatalf("recorded sleeps = %v, want 2 entries", *recorded)
	}
	if (*recorded)[0] != 1*time.Second {
		t.Fatalf("first retry wait = %v, want the 1s initial exponential delay", (*recorded)[0])
	}
	if (*recorded)[1] != 1*time.Second {
		t.Fatalf("second retry wait = %v, want the server's Retry-After (1s) honored over the doubled 2s exponential delay", (*recorded)[1])
	}
}

// TestRecoveryDownloadProviderDoesNotRetryPermanent4xx proves a non-429 4xx
// (e.g. a genuinely missing object) fails immediately with no retry — only
// 429/502/503/504 are transient.
func TestRecoveryDownloadProviderDoesNotRetryPermanent4xx(t *testing.T) {
	recorded := withFakeRetrySleep(t)

	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"not found"}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest)
	if err == nil {
		t.Fatal("expected an error for a 404 response")
	}
	if !strings.Contains(err.Error(), "status 404") {
		t.Fatalf("error = %v, want it to mention status 404", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("attempts = %d, want 1 (no retry on a permanent 404)", got)
	}
	if len(*recorded) != 0 {
		t.Fatalf("recorded sleeps = %v, want none", *recorded)
	}
}

// TestRecoveryDownloadProviderGivesUpAfterFiveMinuteRetryBudget proves the
// retry loop is bounded: a download stuck behind a persistently unavailable
// dependency must eventually give up rather than retry forever, but only
// after waiting at least 5 minutes total, and each individual backoff step
// stays capped at 30s even deep into that budget.
func TestRecoveryDownloadProviderGivesUpAfterFiveMinuteRetryBudget(t *testing.T) {
	recorded := withFakeRetrySleep(t)

	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":"service unavailable"}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest)
	if err == nil {
		t.Fatal("expected an error once the retry budget is exhausted")
	}

	var total time.Duration
	for _, d := range *recorded {
		total += d
	}
	if total < 5*time.Minute {
		t.Fatalf("total retry wait = %v, want at least 5 minutes before giving up", total)
	}
	if got := atomic.LoadInt32(&attempts); got < 6 {
		t.Fatalf("attempts = %d, want several retries before giving up", got)
	}
	for i, d := range *recorded {
		if d > 30*time.Second {
			t.Fatalf("recorded sleep [%d] = %v, want capped at 30s", i, d)
		}
	}
}
