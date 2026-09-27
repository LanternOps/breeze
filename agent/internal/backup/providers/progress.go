package providers

import (
	"context"
	"io"
	"os"
	"sync"
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

// uploadProgressKey carries an upload-progress callback on the context passed
// to UploadContext.
type uploadProgressKey struct{}

// WithUploadProgress returns a context that makes UploadContext call fn as the
// source file is read, so a caller can show progress WITHIN one large file
// instead of only when it completes (#5417).
//
// fn receives an absolute offset into the source file — how far the upload
// has read — not a byte delta. SDKs rewind and re-read (the S3 client hashes
// the payload, then seeks back and sends it; a retried request starts over),
// and the S3 multipart uploader reads parts concurrently through ReaderAt, so
// the values are NOT monotonic: callers should keep the maximum seen. Bytes
// read are bytes handed to the SDK, which may run ahead of bytes on the wire
// by the SDK's buffering (one multipart part per worker, blazer's ~10 MB
// chunk); that is fine for a progress bar. fn may be called from several
// goroutines at once and must be safe for concurrent use.
func WithUploadProgress(ctx context.Context, fn func(offset int64)) context.Context {
	if fn == nil {
		return ctx
	}
	return context.WithValue(ctx, uploadProgressKey{}, fn)
}

// UploadProgressFunc returns the upload-progress callback on ctx, or nil.
// Providers that stream from something other than an *os.File (and tests)
// report through it directly.
func UploadProgressFunc(ctx context.Context) func(offset int64) {
	if ctx == nil {
		return nil
	}
	fn, _ := ctx.Value(uploadProgressKey{}).(func(offset int64))
	return fn
}

// uploadSource is what the providers hand their SDKs: *os.File satisfies it,
// and so does the progress wrapper, which keeps the S3 SDK's seekable-body
// and ReaderAt (concurrent multipart) paths available when wrapped.
type uploadSource interface {
	io.Reader
	io.Seeker
	io.ReaderAt
}

// uploadProgressSource wraps f so reads report their offset to the upload
// progress callback on ctx (see WithUploadProgress). Without a callback it
// returns f itself, so uploads nobody watches are byte-for-byte unchanged.
func uploadProgressSource(ctx context.Context, f *os.File) uploadSource {
	fn := UploadProgressFunc(ctx)
	if fn == nil {
		return f
	}
	return &progressSource{f: f, fn: fn}
}

type progressSource struct {
	f  *os.File
	fn func(offset int64)

	mu  sync.Mutex
	pos int64 // offset of the next sequential Read, tracked across Seek
}

func (p *progressSource) Read(b []byte) (int, error) {
	n, err := p.f.Read(b)
	if n > 0 {
		p.mu.Lock()
		p.pos += int64(n)
		off := p.pos
		p.mu.Unlock()
		p.fn(off)
	}
	return n, err
}

func (p *progressSource) Seek(offset int64, whence int) (int64, error) {
	pos, err := p.f.Seek(offset, whence)
	if err == nil {
		p.mu.Lock()
		p.pos = pos
		p.mu.Unlock()
	}
	return pos, err
}

func (p *progressSource) ReadAt(b []byte, off int64) (int, error) {
	n, err := p.f.ReadAt(b, off)
	if n > 0 {
		p.fn(off + int64(n))
	}
	return n, err
}
