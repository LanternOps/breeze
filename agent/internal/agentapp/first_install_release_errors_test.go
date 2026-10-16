package agentapp

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/breeze-rmm/agent/internal/updater"
	"github.com/breeze-rmm/agent/internal/watchdoginstall"
)

// First-install failures must classify through watchdoginstall.Classify (typed
// checks only) instead of falling through to reason=unknown. The error text is
// part of the operator-facing stderr warning and must not change.

func TestFirstInstallAssetName_UnsupportedPlatformIsTyped(t *testing.T) {
	tests := []struct{ goos, goarch, wantText string }{
		{"freebsd", "amd64", `unsupported first-install OS "freebsd"`},
		{"linux", "386", `unsupported first-install architecture "386"`},
	}
	for _, tc := range tests {
		t.Run(tc.goos+"/"+tc.goarch, func(t *testing.T) {
			_, err := firstInstallAssetName("watchdog", tc.goos, tc.goarch)
			if err == nil {
				t.Fatal("expected an error")
			}
			if err.Error() != tc.wantText {
				t.Fatalf("text %q want %q", err.Error(), tc.wantText)
			}
			if !errors.Is(err, watchdoginstall.ErrUnsupportedOS) {
				t.Fatalf("%v must match watchdoginstall.ErrUnsupportedOS", err)
			}
			if class, _ := watchdoginstall.Classify(err); class != watchdoginstall.ClassUnsupportedOS {
				t.Fatalf("class %q want unsupported_os", class)
			}
		})
	}
}

func statusServer(t *testing.T, code int) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(code)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFirstInstallFetch_NonOKStatusIsTyped(t *testing.T) {
	tests := []struct {
		code      int
		wantClass watchdoginstall.ErrorClass
	}{
		{http.StatusServiceUnavailable, watchdoginstall.ClassServer},
		{http.StatusTooManyRequests, watchdoginstall.ClassServer},
		{http.StatusNotFound, watchdoginstall.ClassUnknown}, // Classify's own policy for 4xx
	}
	for _, tc := range tests {
		t.Run(strconv.Itoa(tc.code), func(t *testing.T) {
			srv := statusServer(t, tc.code)
			check := func(t *testing.T, err error, wantText string) {
				t.Helper()
				if err == nil {
					t.Fatal("expected an error")
				}
				if err.Error() != wantText {
					t.Fatalf("text %q want %q", err.Error(), wantText)
				}
				var se *updater.HTTPStatusError
				if !errors.As(err, &se) || se.Code != tc.code {
					t.Fatalf("%v must be an *updater.HTTPStatusError with code %d", err, tc.code)
				}
				if class, _ := watchdoginstall.Classify(err); class != tc.wantClass {
					t.Fatalf("class %q want %q", class, tc.wantClass)
				}
			}

			_, err := fetchFirstInstallBytes(srv.Client(), srv.URL+"/m.json", "release manifest", 1024)
			check(t, err, "fetch release manifest: status "+strconv.Itoa(tc.code))

			err = downloadVerifiedFirstInstallFile(srv.Client(), srv.URL+"/a", filepath.Join(t.TempDir(), "a"), firstInstallManifestAsset{})
			check(t, err, "fetch release artifact: status "+strconv.Itoa(tc.code))
		})
	}
}
