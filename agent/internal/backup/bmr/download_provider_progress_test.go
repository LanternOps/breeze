package bmr

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// #6664: the bare_metal_rebuild helper's stall watchdog treats body bytes
// landing as progress, so a single large file that takes longer than the
// stall window to download is not mistaken for a hung helper. That only
// works if the recovery download provider reports every chunk to the
// providers.WithDownloadProgress callback carried on its context.
func TestRecoveryDownloadProviderReportsBodyBytesToContextProgress(t *testing.T) {
	body := bytes.Repeat([]byte("x"), 256<<10)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(body)
	}))
	defer server.Close()

	var reported atomic.Int64
	ctx := providers.WithDownloadProgress(context.Background(), func(n int64) { reported.Add(n) })
	provider := newRecoveryDownloadProvider(ctx, server.URL, "brz_rec_test", &AuthenticatedDownloadDescriptor{
		Type:              "breeze_proxy",
		Method:            "GET",
		URL:               server.URL + "/download",
		TokenHeaderName:   "authorization",
		TokenHeaderFormat: "Bearer <recovery-token>",
		PathQueryParam:    "path",
		PathPrefix:        "snapshots/snap-1",
	})

	if err := provider.Download("snapshots/snap-1/files/big.gz", filepath.Join(t.TempDir(), "big.gz")); err != nil {
		t.Fatalf("Download: %v", err)
	}
	if got := reported.Load(); got != int64(len(body)) {
		t.Fatalf("progress callback saw %d bytes, want %d (every body byte)", got, len(body))
	}
}
