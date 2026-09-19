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
