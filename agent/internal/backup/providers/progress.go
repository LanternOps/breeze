package providers

import (
	"context"
	"io"
)

// downloadProgressKey carries a download-progress callback on the context
// passed to ContextDownloader.DownloadContext.
type downloadProgressKey struct{}

// WithDownloadProgress returns a context that makes DownloadContext call fn
// with the number of bytes each time a chunk of the object body lands. The
// caller uses it to tell a slow but progressing transfer from a stalled one
// when the object's size, and so a sensible total deadline, is not known in
// advance (the snapshot manifest, #6929). fn may be called from a goroutine
// other than the caller's and, for providers that download ranges in
// parallel (Azure), from several at once, so it must be safe for concurrent
// use.
func WithDownloadProgress(ctx context.Context, fn func(n int64)) context.Context {
	if fn == nil {
		return ctx
	}
	return context.WithValue(ctx, downloadProgressKey{}, fn)
}

func downloadProgressFunc(ctx context.Context) func(n int64) {
	if ctx == nil {
		return nil
	}
	fn, _ := ctx.Value(downloadProgressKey{}).(func(n int64))
	return fn
}

// DownloadProgressWriter wraps w so every successful write is reported to the
// progress callback on ctx (see WithDownloadProgress). Without a callback it
// returns w itself, so downloads that nobody watches keep io.Copy's
// ReaderFrom fast path.
func DownloadProgressWriter(ctx context.Context, w io.Writer) io.Writer {
	fn := downloadProgressFunc(ctx)
	if fn == nil {
		return w
	}
	return &progressWriter{w: w, fn: fn}
}

type progressWriter struct {
	w  io.Writer
	fn func(n int64)
}

func (p *progressWriter) Write(b []byte) (int, error) {
	n, err := p.w.Write(b)
	if n > 0 {
		p.fn(int64(n))
	}
	return n, err
}
