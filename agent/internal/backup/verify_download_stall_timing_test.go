package backup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// oneChunkThenStallProvider writes one chunk into the destination and then
// delivers nothing until its context ends: a mid-body stall. It records when
// the last byte landed so a test can time the stall detection from it.
type oneChunkThenStallProvider struct {
	growFile   bool // write the chunk into localPath (what io.Copy does)
	callback   bool // report the chunk to the WithDownloadProgress callback
	lastByteAt atomic.Int64
}

func (p *oneChunkThenStallProvider) Upload(string, string) error   { return nil }
func (p *oneChunkThenStallProvider) List(string) ([]string, error) { return nil, nil }
func (p *oneChunkThenStallProvider) Delete(string) error           { return nil }
func (p *oneChunkThenStallProvider) Download(string, string) error {
	panic("the stall path must use DownloadContext")
}

func (p *oneChunkThenStallProvider) DownloadContext(ctx context.Context, _, localPath string) error {
	f, err := os.Create(localPath)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	chunk := []byte("manifest-chunk")
	if p.growFile {
		var w = providers.DownloadProgressWriter(ctx, f)
		if !p.callback {
			w = f
		}
		if _, err := w.Write(chunk); err != nil {
			return err
		}
	} else if p.callback {
		// Buffered in memory: the callback is the only progress signal.
		if _, err := providers.DownloadProgressWriter(ctx, discardWriter{}).Write(chunk); err != nil {
			return err
		}
	}
	p.lastByteAt.Store(time.Now().UnixNano())
	<-ctx.Done()
	return ctx.Err()
}

type discardWriter struct{}

func (discardWriter) Write(b []byte) (int, error) { return len(b), nil }

// A stall must be detected about ONE no-progress window after the last byte,
// whichever progress signals the provider gives. Crediting file growth at the
// time it was sampled detected it after about two windows (#6952).
func TestDownloadWithStallTimeout_DetectsStallOneWindowAfterLastByte(t *testing.T) {
	const window = 300 * time.Millisecond
	for _, tc := range []struct {
		name     string
		growFile bool
		callback bool
	}{
		{"callback and file growth", true, true},
		{"file growth only", true, false},
		{"callback only", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer setDownloadTimeoutFloorForTest(window)()
			p := &oneChunkThenStallProvider{growFile: tc.growFile, callback: tc.callback}
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
			if since > window+window/2 {
				t.Fatalf("stall declared %v after the last byte, want about one %v window (not two)", since, window)
			}
		})
	}
}
