package backup

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sync"
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
	// WithDownloadProgress callback.
	callbackChunks int
	// sparseFirst writes the first chunk at a high offset, as a ranged
	// parallel writer (Azure's SDK) can: the destination's size then runs
	// far ahead of the bytes that have actually arrived.
	sparseFirst bool
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
		if p.sparseFirst && i == 0 {
			if _, err := f.WriteAt(chunk, 1<<20); err != nil {
				return err
			}
			if i < p.callbackChunks {
				if _, err := providers.DownloadProgressWriter(ctx, io.Discard).Write(chunk); err != nil {
					return err
				}
			}
		} else {
			w := sink
			if i < p.callbackChunks {
				w = providers.DownloadProgressWriter(ctx, sink)
			}
			if _, err := w.Write(chunk); err != nil {
				return err
			}
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
		sparseFirst    bool
		max            time.Duration
	}{
		{"callback and file growth", true, 1, false, window + window/2},
		{"callback and a ranged write past what arrived", true, 1, true, window + window/2},
		{"callback only", false, 1, false, window + window/2},
		{"file growth only", true, 0, false, 2*window + window/2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			defer setDownloadTimeoutFloorForTest(window)()
			p := &chunkedStallProvider{chunks: 1, growFile: tc.growFile, callbackChunks: tc.callbackChunks, sparseFirst: tc.sparseFirst, stallAtEnd: true}
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

// A transfer that is still delivering must never be cut off: a growth-only
// provider whatever its file timestamps say, and a reporting provider that
// trickles chunks more than a window apart in total.
func TestDownloadWithStallTimeout_ActiveTransferIsNotCutOff(t *testing.T) {
	const window = 300 * time.Millisecond
	for _, tc := range []struct {
		name           string
		callbackChunks int
		staleModTime   bool
	}{
		{"file growth only, stale modification time", 0, true},
		{"callback on every chunk", 6, false},
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

// advanceProgress must never move the timestamp backward, however the
// callback goroutines and the sampler interleave.
func TestAdvanceProgress_NeverMovesBackward(t *testing.T) {
	var last atomic.Int64
	var observedBackward atomic.Bool
	done := make(chan struct{})
	go func() {
		prev := last.Load()
		for {
			select {
			case <-done:
				return
			default:
			}
			cur := last.Load()
			if cur < prev {
				observedBackward.Store(true)
			}
			prev = cur
		}
	}()
	var wg sync.WaitGroup
	const writers, perWriter = 8, 5000
	for w := 0; w < writers; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			for i := int64(0); i < perWriter; i++ {
				// Interleave high and low values so a plain Store would regress.
				advanceProgress(&last, (i*7919+seed*104729)%100000)
			}
		}(int64(w))
	}
	wg.Wait()
	close(done)
	var want int64
	for w := int64(0); w < writers; w++ {
		for i := int64(0); i < perWriter; i++ {
			want = max(want, (i*7919+w*104729)%100000)
		}
	}
	if got := last.Load(); got != want {
		t.Fatalf("final = %d, want the maximum written, %d", got, want)
	}
	if observedBackward.Load() {
		t.Fatal("the timestamp moved backward")
	}
}
