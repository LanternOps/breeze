package backup

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// chunkedStallProvider writes chunks into the destination on a schedule and
// then either completes or stalls until its context ends. It records when
// the last byte landed so a test can time stall detection from it.
type chunkedStallProvider struct {
	chunks   int
	interval time.Duration
	growFile bool // write chunks into localPath (what io.Copy does)
	// callbackChunks is how many leading chunks are reported to the
	// WithDownloadProgress callback; later chunks land without a report.
	callbackChunks int
	// staleModTime resets the file's modification time to the distant past
	// after every write, as a provider or filesystem that preserves or never
	// refreshes it would.
	staleModTime bool
	stallAtEnd   bool
	lastByteAt   atomic.Int64
}

func (p *chunkedStallProvider) Upload(string, string) error   { return nil }
func (p *chunkedStallProvider) List(string) ([]string, error) { return nil, nil }
func (p *chunkedStallProvider) Delete(string) error           { return nil }
func (p *chunkedStallProvider) Download(string, string) error {
	panic("the stall path must use DownloadContext")
}

func (p *chunkedStallProvider) DownloadContext(ctx context.Context, _, localPath string) error {
	f, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	chunk := []byte("manifest-chunk-")
	past := time.Unix(1_000_000_000, 0)
	for i := 0; i < p.chunks; i++ {
		if i > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(p.interval):
			}
		}
		sink := io.Discard
		if p.growFile {
			sink = f
		}
		w := sink
		if i < p.callbackChunks {
			w = providers.DownloadProgressWriter(ctx, sink)
		}
		if _, err := w.Write(chunk); err != nil {
			return err
		}
		if p.staleModTime {
			if err := os.Chtimes(localPath, past, past); err != nil {
				return err
			}
		}
		p.lastByteAt.Store(time.Now().UnixNano())
	}
	if !p.stallAtEnd {
		return nil
	}
	<-ctx.Done()
	return ctx.Err()
}

// A stall must be detected about ONE no-progress window after the last byte
// when the provider reports progress through the callback, as every
// production provider does. Re-crediting that same data when the file growth
// was sampled detected it after about two windows (#6952). A provider seen
// only through file growth keeps the documented two-window bound.
func TestDownloadWithStallTimeout_DetectionTimeAfterLastByte(t *testing.T) {
	const window = 300 * time.Millisecond
	for _, tc := range []struct {
		name           string
		growFile       bool
		callbackChunks int
		max            time.Duration
	}{
		{"callback and file growth", true, 1, window + window/2},
		{"callback only", false, 1, window + window/2},
		{"file growth only", true, 0, 2*window + window/2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer setDownloadTimeoutFloorForTest(window)()
			p := &chunkedStallProvider{chunks: 1, growFile: tc.growFile, callbackChunks: tc.callbackChunks, stallAtEnd: true}
			dest := filepath.Join(t.TempDir(), "manifest.json")

			var err error
			runWithWatchdog(t, 10*time.Second, func() {
				err = downloadWithStallTimeout(context.Background(), p, "remote/manifest.json", dest)
			})
			since := time.Since(time.Unix(0, p.lastByteAt.Load()))

			var stall *downloadStallError
			if !errors.As(err, &stall) {
				t.Fatalf("err = %v, want a *downloadStallError", err)
			}
			if since < window-20*time.Millisecond {
				t.Fatalf("stall declared %v after the last byte, before the %v window", since, window)
			}
			if since > tc.max {
				t.Fatalf("stall declared %v after the last byte, want at most %v", since, tc.max)
			}
		})
	}
}

// A transfer that is still delivering must never be cut off, whatever its
// file timestamps say and even when the callback reports only some writes.
func TestDownloadWithStallTimeout_ActiveTransferIsNotCutOff(t *testing.T) {
	const window = 300 * time.Millisecond
	for _, tc := range []struct {
		name           string
		callbackChunks int
		staleModTime   bool
	}{
		{"file growth only, stale modification time", 0, true},
		{"callback reports only the first chunk", 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer setDownloadTimeoutFloorForTest(window)()
			p := &chunkedStallProvider{
				chunks:         6,
				interval:       window * 8 / 10, // ~1.2 s in total, four windows
				growFile:       true,
				callbackChunks: tc.callbackChunks,
				staleModTime:   tc.staleModTime,
			}
			dest := filepath.Join(t.TempDir(), "manifest.json")

			var err error
			runWithWatchdog(t, 10*time.Second, func() {
				err = downloadWithStallTimeout(context.Background(), p, "remote/manifest.json", dest)
			})
			if err != nil {
				t.Fatalf("an actively delivering transfer failed: %v", err)
			}
		})
	}
}
