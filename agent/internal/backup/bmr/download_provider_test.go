package bmr

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
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

// TestRewriteDescriptorOriginLogsAndLeavesUnchangedOnServerParseError proves
// the silent-failure review's item 3 fix: a serverURL that fails to parse
// must not silently pass the descriptor through unchanged with no trace —
// it must log a slog.Warn carrying the raw serverURL and the parse error,
// so a misconfigured --server value is diagnosable instead of surfacing
// only as a mysterious later download failure.
func TestRewriteDescriptorOriginLogsAndLeavesUnchangedOnServerParseError(t *testing.T) {
	descriptor := &AuthenticatedDownloadDescriptor{
		URL:        "https://example.com/api/v1/backup/bmr/recover/download",
		PathPrefix: "snapshots/x",
	}

	var logBuf bytes.Buffer
	origLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	defer slog.SetDefault(origLogger)

	got := rewriteDescriptorOrigin(":", descriptor)
	if got != descriptor {
		t.Fatalf("expected the descriptor unchanged when serverURL fails to parse, got a rewritten copy: %+v", got)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected a WARN log for the unparseable serverURL, got: %s", logged)
	}
	if !strings.Contains(logged, "missing protocol scheme") {
		t.Fatalf("expected the warning to carry the parse error, got: %s", logged)
	}
}

// TestRewriteDescriptorOriginLogsAndLeavesUnchangedOnNoHostServerURL covers
// the sibling silent branch: serverURL parses without error but yields no
// Host (e.g. a scheme-less value), which is just as unusable for rewriting
// the descriptor's origin.
func TestRewriteDescriptorOriginLogsAndLeavesUnchangedOnNoHostServerURL(t *testing.T) {
	descriptor := &AuthenticatedDownloadDescriptor{
		URL:        "https://example.com/api/v1/backup/bmr/recover/download",
		PathPrefix: "snapshots/x",
	}

	var logBuf bytes.Buffer
	origLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	defer slog.SetDefault(origLogger)

	got := rewriteDescriptorOrigin("not-a-url", descriptor)
	if got != descriptor {
		t.Fatalf("expected the descriptor unchanged when serverURL has no host, got a rewritten copy: %+v", got)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected a WARN log for the host-less serverURL, got: %s", logged)
	}
	if !strings.Contains(logged, "not-a-url") {
		t.Fatalf("expected the warning to carry the raw serverURL, got: %s", logged)
	}
}

// TestRewriteDescriptorOriginLogsAndLeavesUnchangedOnDescriptorParseError
// covers the third silent branch: the descriptor's own URL (as sent by the
// server) failing to parse.
func TestRewriteDescriptorOriginLogsAndLeavesUnchangedOnDescriptorParseError(t *testing.T) {
	descriptor := &AuthenticatedDownloadDescriptor{
		URL:        "http://[::1]:bad",
		PathPrefix: "snapshots/x",
	}

	var logBuf bytes.Buffer
	origLogger := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logBuf, nil)))
	defer slog.SetDefault(origLogger)

	got := rewriteDescriptorOrigin("http://10.0.2.2:8080", descriptor)
	if got != descriptor {
		t.Fatalf("expected the descriptor unchanged when its own URL fails to parse, got a rewritten copy: %+v", got)
	}
	logged := logBuf.String()
	if !strings.Contains(logged, "level=WARN") {
		t.Fatalf("expected a WARN log for the unparseable descriptor URL, got: %s", logged)
	}
	if !strings.Contains(logged, "[::1]:bad") {
		t.Fatalf("expected the warning to carry the raw descriptor URL, got: %s", logged)
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
	retrySleep = func(ctx context.Context, d time.Duration) error {
		recorded = append(recorded, d)
		return nil
	}
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

// TestRecoveryDownloadProviderNotFoundSatisfiesErrObjectNotFound proves a
// 404 from the recovery download endpoint is recognizable via
// errors.Is(err, providers.ErrObjectNotFound) — the exact check
// DownloadSystemState (download_system_state.go) uses to decide "this
// snapshot never captured system state" (ErrNoSystemState, a soft skip)
// versus "some other download failure" (hard error). Before
// downloadStatusError.Is existed, this provider's 404 satisfied neither
// LocalProvider's nor S3Provider's own ErrObjectNotFound wrapping (both
// wrap it themselves; this provider never did), so a token/HTTP-driven
// recovery of a snapshot with no system state always failed preflight hard
// instead of taking the intended soft-skip path — found by the W04b QEMU
// end-to-end proof, which is the only test exercising a real snapshot with
// no system state through this exact provider.
func TestRecoveryDownloadProviderNotFoundSatisfiesErrObjectNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, `{"error":"object_not_found"}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	err := provider.Download("snapshots/provider-snapshot-1/system-state/manifest.json", dest)
	if err == nil {
		t.Fatal("expected an error for a 404 response")
	}
	if !errors.Is(err, providers.ErrObjectNotFound) {
		t.Fatalf("errors.Is(err, providers.ErrObjectNotFound) = false, want true (err = %v)", err)
	}
}

// TestRecoveryDownloadProviderOtherFailuresDoNotSatisfyErrObjectNotFound is
// the negative control: a 401/403/5xx/network failure must NOT satisfy
// ErrObjectNotFound — those are exactly the "not confirmed absent" cases
// its own doc comment says must never match (a fail-open bug otherwise:
// preflight would silently skip system-state verification after a mere
// auth or transport failure instead of refusing).
func TestRecoveryDownloadProviderOtherFailuresDoNotSatisfyErrObjectNotFound(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":"forbidden"}`)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	err := provider.Download("snapshots/provider-snapshot-1/system-state/manifest.json", dest)
	if err == nil {
		t.Fatal("expected an error for a 403 response")
	}
	if errors.Is(err, providers.ErrObjectNotFound) {
		t.Fatalf("errors.Is(err, providers.ErrObjectNotFound) = true, want false for a 403 (err = %v)", err)
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

// TestRecoveryDownloadProviderRetriesTransportFailure is D-W09-3's core
// proof (#6491 KIT lab): a 4 h 01 m, 107,636-file rebuild died on ONE file
// whose presigned GET failed with `context deadline exceeded` — a
// transport-class error with no HTTP status, which the retry loop treated
// as permanent because it only retried a downloadStatusError of 429/502/
// 503/504. A transport failure (reset, EOF, per-request timeout) must be
// retried on the same backoff schedule. The fault here is a connection
// closed mid-body: the response is 200 with Content-Length announced, then
// the server hijacks and drops the socket, so the client sees io.Copy fail
// with an unexpected EOF — no status to branch on, exactly the class the
// old loop discarded. Attempt 1 fails at the transport, attempt 2 must
// succeed and the destination must hold the full body.
func TestRecoveryDownloadProviderRetriesTransportFailure(t *testing.T) {
	recorded := withFakeRetrySleep(t)

	const body = "the-whole-object-body"
	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt32(&attempts, 1) == 1 {
			// Announce a full body, send half, then drop the connection.
			w.Header().Set("Content-Length", strconv.Itoa(len(body)))
			w.WriteHeader(http.StatusOK)
			_, _ = io.WriteString(w, body[:5])
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("test server does not support hijacking")
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Fatalf("hijack: %v", err)
			}
			_ = conn.Close()
			return
		}
		_, _ = io.WriteString(w, body)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	if err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest); err != nil {
		t.Fatalf("Download: %v (a transport failure must be retried, not treated as permanent)", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 2 {
		t.Fatalf("attempts = %d, want 2 (transport failure, then success)", got)
	}
	if len(*recorded) != 1 || (*recorded)[0] != downloadRetryInitialDelay {
		t.Fatalf("recorded sleeps = %v, want exactly one %v backoff step", *recorded, downloadRetryInitialDelay)
	}
	got, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(got) != body {
		t.Fatalf("dest = %q, want the full body %q from the retried attempt", got, body)
	}
}

// TestRecoveryDownloadProviderRetriesTransportFailureOnRedirectHop covers the
// third transport site — the redirect hop in followDownloadRedirects, which
// is the one a production BMR actually exercises (the API answers 302 with
// a presigned storage URL; the KIT failure was on exactly that presigned
// GET). The API stub redirects to a storage stub whose FIRST request is
// dropped before any response; the second must succeed and the redirect
// must be followed again with no auth header.
func TestRecoveryDownloadProviderRetriesTransportFailureOnRedirectHop(t *testing.T) {
	recorded := withFakeRetrySleep(t)

	const body = "presigned-object-body"
	var storageAttempts int32
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Errorf("recovery token forwarded to the storage redirect target")
		}
		if atomic.AddInt32(&storageAttempts, 1) == 1 {
			hj, ok := w.(http.Hijacker)
			if !ok {
				t.Fatal("test server does not support hijacking")
			}
			conn, _, err := hj.Hijack()
			if err != nil {
				t.Fatalf("hijack: %v", err)
			}
			_ = conn.Close()
			return
		}
		_, _ = io.WriteString(w, body)
	}))
	defer storage.Close()

	var apiAttempts int32
	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&apiAttempts, 1)
		http.Redirect(w, r, storage.URL+"/obj?X-Amz-Signature=sig", http.StatusFound)
	}))
	defer api.Close()

	provider := newRecoveryDownloadProvider(context.Background(), api.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:               api.URL + "/download",
		TokenHeaderName:   "authorization",
		TokenHeaderFormat: "Bearer <recovery-token>",
		PathQueryParam:    "path",
		PathPrefix:        "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	if err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest); err != nil {
		t.Fatalf("Download: %v (a transport failure on the redirect hop must be retried)", err)
	}
	if got := atomic.LoadInt32(&apiAttempts); got != 2 {
		t.Fatalf("api attempts = %d, want 2 (the whole download, redirect included, is retried)", got)
	}
	if got := atomic.LoadInt32(&storageAttempts); got != 2 {
		t.Fatalf("storage attempts = %d, want 2 (dropped, then served)", got)
	}
	if len(*recorded) != 1 {
		t.Fatalf("recorded sleeps = %v, want exactly one backoff step", *recorded)
	}
	got, err := os.ReadFile(dest)
	if err != nil || string(got) != body {
		t.Fatalf("dest = %q err %v, want the full presigned body", got, err)
	}
}

// TestRecoveryDownloadProviderTransportFailureRemovesPartialFile pins the
// cleanup: a final transport failure must not leave a half-written object
// at the restore target for the caller to count as present.
func TestRecoveryDownloadProviderTransportFailureRemovesPartialFile(t *testing.T) {
	withFakeRetrySleep(t)

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Length", "100")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "partial")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		hj, _ := w.(http.Hijacker)
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		_ = conn.Close()
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	if err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest); err == nil {
		t.Fatal("expected the download to fail after transport retries are exhausted")
	}
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial destination file still exists after a final transport failure (stat err = %v)", err)
	}
}

// TestRecoveryDownloadProviderTransportRetriesAreBounded proves a
// persistently unreachable object does not turn every file into a
// 5-minute stall: transport failures get downloadTransportMaxAttempts
// attempts total, then the error surfaces (still wrapping the transport
// cause) so restore's per-file failure accounting and consecutive-failure
// breaker (bmr.go) see it.
func TestRecoveryDownloadProviderTransportRetriesAreBounded(t *testing.T) {
	recorded := withFakeRetrySleep(t)

	var attempts int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("test server does not support hijacking")
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Fatalf("hijack: %v", err)
		}
		_ = conn.Close() // no response at all: the client sees EOF
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
		t.Fatal("expected an error once transport retries are exhausted")
	}
	var transportErr *downloadTransportError
	if !errors.As(err, &transportErr) {
		t.Fatalf("error = %v, want it to wrap *downloadTransportError so callers can tell transport from status failures", err)
	}
	if got := atomic.LoadInt32(&attempts); got != downloadTransportMaxAttempts {
		t.Fatalf("attempts = %d, want exactly downloadTransportMaxAttempts (%d)", got, downloadTransportMaxAttempts)
	}
	if len(*recorded) != downloadTransportMaxAttempts-1 {
		t.Fatalf("recorded sleeps = %v, want %d backoff steps between %d attempts", *recorded, downloadTransportMaxAttempts-1, downloadTransportMaxAttempts)
	}
}

// TestRecoveryDownloadProviderDoesNotRetryTransportFailureAfterParentCancel
// pins the boundary D-W09-3 must not cross: a transport error that is
// really the PARENT recovery context being cancelled (the operator aborted,
// the run-level deadline fired) must stop immediately — never a backoff,
// never a second request — because every subsequent attempt would fail the
// same way and the caller is trying to stop. The server blocks until the
// test cancels the context mid-request, so the transport error IS the
// cancellation.
func TestRecoveryDownloadProviderDoesNotRetryTransportFailureAfterParentCancel(t *testing.T) {
	recorded := withFakeRetrySleep(t)

	ctx, cancel := context.WithCancel(context.Background())
	var attempts int32
	started := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&attempts, 1)
		started <- struct{}{}
		<-r.Context().Done() // hold the request open until the client goes away
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(ctx, server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	go func() {
		<-started
		cancel()
	}()

	dest := filepath.Join(t.TempDir(), "f.bin")
	err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest)
	if err == nil {
		t.Fatal("expected an error when the parent context is cancelled mid-request")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want it to wrap context.Canceled", err)
	}
	if got := atomic.LoadInt32(&attempts); got != 1 {
		t.Fatalf("attempts = %d, want exactly 1 — a cancelled parent context must never be retried", got)
	}
	if len(*recorded) != 0 {
		t.Fatalf("recorded sleeps = %v, want none — no backoff after a parent cancel", *recorded)
	}
}

// TestRecoveryDownloadProviderRetryBackoffIsContextAware proves item 4's
// fix: retrySleep must respect ctx cancellation instead of blocking out the
// full backoff — the retry loop can wait up to downloadRetryMaxTotalWait (5
// minutes) across a recovery, and before this fix a cancelled recovery
// waited out whatever backoff step was in flight (up to 30s) rather than
// stopping immediately. Uses the real (non-faked) retrySleep deliberately,
// so this exercises the actual select-on-ctx behavior, not a test double.
func TestRecoveryDownloadProviderRetryBackoffIsContextAware(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = io.WriteString(w, `{"error":"service unavailable"}`)
	}))
	defer server.Close()

	ctx, cancel := context.WithCancel(context.Background())
	provider := newRecoveryDownloadProvider(ctx, server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/provider-snapshot-1",
	})

	go func() {
		time.Sleep(50 * time.Millisecond)
		cancel()
	}()

	dest := filepath.Join(t.TempDir(), "f.bin")
	start := time.Now()
	err := provider.Download("snapshots/provider-snapshot-1/f.bin", dest)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected an error when the context is cancelled mid-backoff")
	}
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want it to wrap context.Canceled", err)
	}
	// The first backoff step is the 1s initial delay; cancellation fires at
	// 50ms, so a context-aware sleep returns in well under that 1s, and
	// nowhere near the 5-minute retry budget a non-context-aware sleep could
	// eventually run out via repeated real waits.
	if elapsed > 500*time.Millisecond {
		t.Fatalf("Download took %v after cancellation, want it to return promptly (well under the 1s backoff step)", elapsed)
	}
}

// TestRecoveryDownloadProviderDoesNotForwardAuthOnRedirect is D21's core
// proof. net/http's default redirect policy forwards sensitive headers
// (Authorization included) to a redirect target whenever the target's
// *host* matches the original request's host, ignoring port — so a 302 from
// the API to a presigned S3/MinIO URL on the same host but a different port
// (the exact self-hosted shape: API and object storage on one box) leaks
// the recovery token into the presigned request, which S3/MinIO then reject
// with 400 ("Only one auth mechanism allowed"). Both httptest servers below
// bind to 127.0.0.1 by default, reproducing "same host, different port"
// without any custom listener config. Before the fix: Download fails with
// status 400. After the fix: the redirect is followed with no Authorization
// header, and the object bytes come back.
func TestRecoveryDownloadProviderDoesNotForwardAuthOnRedirect(t *testing.T) {
	var sawAuthOnStorage bool
	var storageAuthValue string
	storage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); auth != "" {
			sawAuthOnStorage = true
			storageAuthValue = auth
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, `{"error":"InvalidArgument: Only one auth mechanism allowed"}`)
			return
		}
		_, _ = io.WriteString(w, "object-bytes")
	}))
	defer storage.Close()

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if got := r.Header.Get("Authorization"); got != "Bearer tok" {
			http.Error(w, "missing auth", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, storage.URL+"/presigned?X-Amz-Signature=deadbeef", http.StatusFound)
	}))
	defer api.Close()

	provider := newRecoveryDownloadProvider(context.Background(), api.URL, "tok", &AuthenticatedDownloadDescriptor{
		URL:               api.URL + "/download",
		TokenHeaderName:   "authorization",
		TokenHeaderFormat: "Bearer <recovery-token>",
		PathQueryParam:    "path",
		PathPrefix:        "snapshots/x",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	if err := provider.Download("snapshots/x/f.bin", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if sawAuthOnStorage {
		t.Fatalf("Authorization header leaked to redirect target: %q", storageAuthValue)
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "object-bytes" {
		t.Fatalf("downloaded data = %q", string(data))
	}
}

// TestRecoveryDownloadProviderFollowsChainedRedirectWithoutAuth proves a
// second redirect hop (API -> intermediate -> final storage) is followed
// correctly, with no Authorization header reaching the ultimate target. The
// intermediate hop redirects unconditionally regardless of any headers it
// receives, isolating "does the chain-following logic work" from "is auth
// stripped" (already covered by the sibling test above) — the final server
// is still the one asserting no Authorization arrived.
func TestRecoveryDownloadProviderFollowsChainedRedirectWithoutAuth(t *testing.T) {
	var finalSawAuth bool
	final := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			finalSawAuth = true
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		_, _ = io.WriteString(w, "chained-bytes")
	}))
	defer final.Close()

	intermediate := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, final.URL+"/object", http.StatusFound)
	}))
	defer intermediate.Close()

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			http.Error(w, "missing auth", http.StatusUnauthorized)
			return
		}
		http.Redirect(w, r, intermediate.URL+"/step2", http.StatusFound)
	}))
	defer api.Close()

	provider := newRecoveryDownloadProvider(context.Background(), api.URL, "tok", &AuthenticatedDownloadDescriptor{
		URL:               api.URL + "/download",
		TokenHeaderName:   "authorization",
		TokenHeaderFormat: "Bearer <recovery-token>",
		PathQueryParam:    "path",
		PathPrefix:        "snapshots/x",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	if err := provider.Download("snapshots/x/f.bin", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if finalSawAuth {
		t.Fatal("Authorization header leaked to second-hop redirect target")
	}
	data, err := os.ReadFile(dest)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	if string(data) != "chained-bytes" {
		t.Fatalf("downloaded data = %q", string(data))
	}
}

// TestRecoveryDownloadProviderFailsOnRedirectLoopBeyondCap proves the
// redirect-following loop is bounded: a server that redirects forever must
// eventually produce a permanent error mentioning redirects, rather than
// hanging or looping indefinitely.
func TestRecoveryDownloadProviderFailsOnRedirectLoopBeyondCap(t *testing.T) {
	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, server.URL+"/download", http.StatusFound)
	}))
	defer server.Close()

	provider := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		URL:            server.URL + "/download",
		PathQueryParam: "path",
		PathPrefix:     "snapshots/x",
	})

	dest := filepath.Join(t.TempDir(), "f.bin")
	err := provider.Download("snapshots/x/f.bin", dest)
	if err == nil {
		t.Fatal("expected an error for a redirect loop")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "redirect") {
		t.Fatalf("error = %v, want it to mention redirects", err)
	}
}

// TestRecoveryDownloadProvider_OwnPrefixAlwaysAllowed proves that a key
// under the token's own snapshot prefix is always downloadable, whether or
// not the descriptor negotiated snapshot-file-membership-v1 (Task 9).
func TestRecoveryDownloadProvider_OwnPrefixAlwaysAllowed(t *testing.T) {
	var requested int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requested, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data"))
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
	})
	dest := filepath.Join(t.TempDir(), "out")
	if err := p.Download("snapshots/gen-2/files/a.gz", dest); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if got := atomic.LoadInt32(&requested); got != 1 {
		t.Fatalf("requested = %d, want 1", got)
	}
}

// TestRecoveryDownloadProvider_ExternalKeyRefusedWithoutAdmission proves an
// external key is refused before any HTTP request when it has never been
// added to the admissible set (Task 9).
func TestRecoveryDownloadProvider_ExternalKeyRefusedWithoutAdmission(t *testing.T) {
	var requested int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requested, 1)
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
	})
	err := p.Download("snapshots/gen-1/files/a.gz", filepath.Join(t.TempDir(), "out"))
	if err == nil {
		t.Fatal("expected an error for an external key never admitted")
	}
	if got := atomic.LoadInt32(&requested); got != 0 {
		t.Fatalf("requested = %d, want 0 (no HTTP request for a key outside the admissible set)", got)
	}
}

// TestRecoveryDownloadProvider_ExternalKeyAllowedOnceAdmittedWithMembership
// proves an external key becomes downloadable once ExtendAdmissible has
// widened the set AND the descriptor granted the membership capability
// (Task 9).
func TestRecoveryDownloadProvider_ExternalKeyAllowedOnceAdmittedWithMembership(t *testing.T) {
	var requested int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requested, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data"))
	}))
	defer server.Close()

	p := newRecoveryDownloadProvider(context.Background(), server.URL, "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: server.URL + "/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
		Capabilities: []string{CapabilitySnapshotFileMembershipV1},
	})
	if !p.MembershipNegotiated() {
		t.Fatal("MembershipNegotiated() = false, want true")
	}
	p.ExtendAdmissible([]string{"snapshots/gen-1/files/a.gz"})
	if !p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatal("Admits() = false for a key just widened into scope")
	}
	if err := p.Download("snapshots/gen-1/files/a.gz", filepath.Join(t.TempDir(), "out")); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if got := atomic.LoadInt32(&requested); got != 1 {
		t.Fatalf("requested = %d, want 1", got)
	}
}

// TestRecoveryDownloadProvider_ExternalKeyRefusedWithoutMembershipEvenIfListed
// is the belt-and-braces case: a key must never be admitted from
// ExtendAdmissible alone if the descriptor never granted the capability —
// this defends against a future caller widening the set without checking
// MembershipNegotiated() first (Task 9).
func TestRecoveryDownloadProvider_ExternalKeyRefusedWithoutMembershipEvenIfListed(t *testing.T) {
	p := newRecoveryDownloadProvider(context.Background(), "http://example.invalid", "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: "http://example.invalid/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
	})
	p.ExtendAdmissible([]string{"snapshots/gen-1/files/a.gz"})
	if p.MembershipNegotiated() {
		t.Fatal("MembershipNegotiated() = true, want false (descriptor never granted the capability)")
	}
	if p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatal("Admits() = true, want false: ExtendAdmissible alone must never grant access without membership")
	}
}

// TestRecoveryDownloadProvider_AdmitsOwnPrefixKey proves Admits() alone
// (the predicate the rebuild engine's preflight ObjectAdmission sweep uses,
// preflight.go ~:153) admits a key under the descriptor's own PathPrefix
// even when membership was never negotiated and the admissible set is
// empty — i.e. an entirely self-contained, own-prefix-only manifest must
// never be refused at preflight. Before the fix, Admits() only consulted
// the external admissible map and unconditionally returned false without
// membership, so every own-prefix file failed preflight's sweep (review
// finding #1).
func TestRecoveryDownloadProvider_AdmitsOwnPrefixKey(t *testing.T) {
	p := newRecoveryDownloadProvider(context.Background(), "http://example.invalid", "tok", &AuthenticatedDownloadDescriptor{
		Type: "breeze_proxy", Method: http.MethodGet, URL: "http://example.invalid/download",
		PathQueryParam: "path", PathPrefix: "snapshots/gen-2",
		// No Capabilities — this token never negotiated membership, as is
		// normal for a self-contained snapshot (R1).
	})
	if p.MembershipNegotiated() {
		t.Fatal("MembershipNegotiated() = true, want false (no capability granted)")
	}
	if !p.Admits("snapshots/gen-2/files/a.gz") {
		t.Fatal("Admits() = false for a key under the descriptor's own PathPrefix, want true")
	}
	if !p.Admits("snapshots/gen-2") {
		t.Fatal("Admits() = false for the bare own-prefix key itself, want true")
	}
	// A key under a DIFFERENT prefix, with no membership negotiated, must
	// still be refused.
	if p.Admits("snapshots/gen-1/files/a.gz") {
		t.Fatal("Admits() = true for an external key with no membership negotiated, want false")
	}
}

func TestPathClean(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
		// skipBackslashCountCheck is set for cases where an entire
		// backslash-containing segment is legitimately removed by a `..`
		// resolution (path.Clean's normal segment-cancellation behavior),
		// so the input/output backslash counts are expected to differ.
		skipBackslashCountCheck bool
	}{
		{
			name: "ordinary object key round-trips",
			in:   "snapshots/a/files/path_0/x.gz",
			want: "snapshots/a/files/path_0/x.gz",
		},
		{
			name: "double slash and dot segment collapse",
			in:   "snapshots/a//files/./x.gz",
			want: "snapshots/a/files/x.gz",
		},
		{
			name: "dot-dot segment resolves within the key",
			in:   "snapshots/a/files/../b/x.gz",
			want: "snapshots/a/b/x.gz",
		},
		{
			name: "empty and dot-only input clean to empty",
			in:   ".",
			want: "",
		},
		{
			name: "trailing slash is dropped like path.Clean",
			in:   "snapshots/a/files/",
			want: "snapshots/a/files",
		},
		{
			// The #6631 case: a `\` inside an object key is a literal byte,
			// not a separator. The old filepath.Clean+ToSlash rewrote it to
			// `/` on a Windows host (red on the Windows CI job, which runs
			// ./internal/backup/bmr from W06b on); path.Clean never does.
			name: "backslash inside a key is preserved",
			in:   `snapshots/a/files/path_0/C:\Users\x.gz`,
			want: `snapshots/a/files/path_0/C:\Users\x.gz`,
		},
		{
			// A backslash-containing key is ONE segment under path.Clean
			// semantics (POSIX-only separator is `/`): the `..` here
			// resolves against the whole `a\b` segment, not against `b`
			// alone. filepath.Clean on Windows would instead treat `\` as
			// a separator and produce `a/c`.
			name:                    "backslash makes the segment atomic for dot-dot resolution",
			in:                      `a\b/../c`,
			want:                    `c`,
			skipBackslashCountCheck: true,
		},
		{
			name: "backslash preserved verbatim alongside forward slashes",
			in:   `snapshots\x/y`,
			want: `snapshots\x/y`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := pathClean(tt.in)
			if got != tt.want {
				t.Errorf("pathClean(%q) = %q, want %q", tt.in, got, tt.want)
			}
			if !tt.skipBackslashCountCheck && strings.Count(got, `\`) != strings.Count(tt.in, `\`) {
				t.Errorf("pathClean(%q) = %q changed the key's backslashes; they are literal key bytes on every GOOS", tt.in, got)
			}
		})
	}
}
