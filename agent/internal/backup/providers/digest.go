package providers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash"
	"io"
	"sync"
)

// UploadDigest describes the logical content an upload stored: the
// lowercase-hex SHA-256 and length of the bytes read from localPath and sent,
// which is exactly what a later Download of the same key returns (the local
// provider's gzip compression is transparent to both).
type UploadDigest struct {
	SHA256 string
	Size   int64
}

// DigestUploader is implemented by providers that can report the digest of
// the exact byte stream an upload read and stored, and forwarded by every
// provider wrapper. A snapshot records these digests instead of a separate
// read of the source, which may have changed between the two reads.
//
// UploadWithDigest returns an error wrapping ErrDigestUnavailable when the
// provider cannot vouch for the digest of this particular upload (a wrapper
// whose wrapped provider has no digest support, or an SDK read pattern the
// provider could not follow). Callers then fall back to uploading an
// immutable staged copy whose digest they compute themselves; the object may
// or may not have been written by the refused attempt.
type DigestUploader interface {
	UploadWithDigest(ctx context.Context, localPath, remotePath string) (UploadDigest, error)
}

// ErrDigestUnavailable reports that an upload's digest cannot be vouched for.
var ErrDigestUnavailable = errors.New("backup provider: upload digest unavailable")

// rewindableDigestSource is a Read+Seek body that hashes the bytes of the
// most recent complete pass from offset 0. SDKs rewind a body before a retry
// (and, for a signed plain-HTTP payload, after hashing it once for the
// signature), so every seek back to 0 starts a new pass. A read that does not
// continue the current pass from where it left off (after a seek elsewhere)
// makes the digest unavailable rather than guessed. It deliberately does not
// expose ReadAt, so nothing can read around the hash.
type rewindableDigestSource struct {
	src interface {
		io.Reader
		io.Seeker
	}

	mu     sync.Mutex
	h      hash.Hash
	pos    int64 // offset of the next Read
	hashed int64 // bytes hashed in the current pass
	broken bool  // the current pass read away from its hashed frontier
	end    int64 // last offset a SeekEnd reported, or -1
}

func newRewindableDigestSource(src interface {
	io.Reader
	io.Seeker
}) *rewindableDigestSource {
	return &rewindableDigestSource{src: src, h: sha256.New(), end: -1}
}

func (d *rewindableDigestSource) Read(b []byte) (int, error) {
	n, err := d.src.Read(b)
	if n > 0 {
		d.mu.Lock()
		if d.pos == d.hashed && !d.broken {
			_, _ = d.h.Write(b[:n])
			d.hashed += int64(n)
		} else {
			d.broken = true
		}
		d.pos += int64(n)
		d.mu.Unlock()
	}
	return n, err
}

func (d *rewindableDigestSource) Seek(offset int64, whence int) (int64, error) {
	p, err := d.src.Seek(offset, whence)
	if err != nil {
		return p, err
	}
	d.mu.Lock()
	d.pos = p
	if whence == io.SeekEnd {
		d.end = p
	}
	if p == 0 {
		d.h.Reset()
		d.hashed = 0
		d.broken = false
	}
	d.mu.Unlock()
	return p, nil
}

// digest returns the current pass's digest, and false when this source cannot
// vouch for it: the pass read out of order, or it stopped short of the length
// the SDK measured for the request.
func (d *rewindableDigestSource) digest() (UploadDigest, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.broken || (d.end >= 0 && d.hashed != d.end) {
		return UploadDigest{}, false
	}
	return UploadDigest{SHA256: hex.EncodeToString(d.h.Sum(nil)), Size: d.hashed}, true
}

// sequentialDigestReader exposes only io.Reader, so an SDK consuming it must
// read it once, front to back — the S3 multipart uploader then buffers each
// part itself (retries resend the buffer) instead of reading parts
// concurrently through ReadAt. Every byte read is hashed.
type sequentialDigestReader struct {
	r io.Reader
	h hash.Hash
	n int64
}

func newSequentialDigestReader(r io.Reader) *sequentialDigestReader {
	return &sequentialDigestReader{r: r, h: sha256.New()}
}

func (s *sequentialDigestReader) Read(b []byte) (int, error) {
	n, err := s.r.Read(b)
	if n > 0 {
		_, _ = s.h.Write(b[:n])
		s.n += int64(n)
	}
	return n, err
}

func (s *sequentialDigestReader) digest() UploadDigest {
	return UploadDigest{SHA256: hex.EncodeToString(s.h.Sum(nil)), Size: s.n}
}

// countingHash hashes and counts everything written to it.
type countingHash struct {
	h hash.Hash
	n int64
}

func newCountingHash() *countingHash { return &countingHash{h: sha256.New()} }

func (c *countingHash) Write(b []byte) (int, error) {
	n, err := c.h.Write(b)
	c.n += int64(n)
	return n, err
}

func (c *countingHash) digest() UploadDigest {
	return UploadDigest{SHA256: hex.EncodeToString(c.h.Sum(nil)), Size: c.n}
}
