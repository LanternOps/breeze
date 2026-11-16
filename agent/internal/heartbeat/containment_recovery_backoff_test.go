package heartbeat

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/updater"
)

// A failing recovery download (asset not synced, artifact host down) must not
// hit the server on every readiness probe across the fleet: failures back off
// per version and kind, and success clears the backoff.
func TestRecoveryDistributionBacksOffFailedFetches(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	sentinel := errors.New("version not found")
	downloads, envelopes := 0, 0
	f := &countingDownloader{fakeRecoveryDownloader: fakeRecoveryDownloader{t: t, downloadErr: sentinel, envErr: sentinel}, downloads: &downloads, envelopes: &envelopes}
	_, src := recoveryDistributionWithClock(func() recoveryDownloader { return f }, true, func() time.Time { return now })
	var buf bytes.Buffer
	for n := 0; n < 3; n++ {
		if err := src.Fetch(context.Background(), "1.2.3", &buf); !errors.Is(err, sentinel) {
			t.Fatalf("attempt %d: want the original failure, got %v", n, err)
		}
		if _, err := src.FetchEnvelope(context.Background(), "1.2.3"); !errors.Is(err, sentinel) {
			t.Fatalf("envelope attempt %d: want the original failure, got %v", n, err)
		}
	}
	if downloads != 1 || envelopes != 1 {
		t.Fatalf("within the backoff window: downloads=%d envelopes=%d, want 1 each", downloads, envelopes)
	}
	// Another version is not held back by this one.
	_ = src.Fetch(context.Background(), "1.2.4", &buf)
	if downloads != 2 {
		t.Fatalf("other version blocked by backoff: downloads=%d", downloads)
	}
	// After the window the next probe retries, and success clears the backoff.
	now = now.Add(recoveryFetchBackoff + time.Second)
	f.downloadErr, f.body = nil, []byte("ok")
	if err := src.Fetch(context.Background(), "1.2.3", &buf); err != nil || downloads != 3 {
		t.Fatalf("retry after window: err=%v downloads=%d", err, downloads)
	}
	f.downloadErr = sentinel
	_ = src.Fetch(context.Background(), "1.2.3", &buf)
	if downloads != 4 {
		t.Fatalf("success did not clear the backoff: downloads=%d", downloads)
	}
}

type countingDownloader struct {
	fakeRecoveryDownloader
	downloads, envelopes *int
}

func (c *countingDownloader) DownloadBinary(version string) (string, error) {
	*c.downloads++
	return c.fakeRecoveryDownloader.DownloadBinary(version)
}

func (c *countingDownloader) VerifiedDownloadEnvelope(version string) (updater.ReleaseEnvelope, error) {
	*c.envelopes++
	return c.fakeRecoveryDownloader.VerifiedDownloadEnvelope(version)
}
