package storagesession

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
)

// Batched URL resolution for brokered writes.
//
// Every control-plane call counts against limits the device shares with its
// agent, so URLs are resolved in batches of up to the session's maxBatch:
// the next planned small files (PrepareUploads), the next parts of a
// multipart upload, the next planned downloads (PrepareDownloads). A batch
// holds only what the link is expected to use before the URLs expire — its
// bytes stay within what the measured throughput carries in batchWindow — so
// few URLs lapse unused; a lapsed or stale one is simply resolved again.

const (
	// batchWindow is how much of a URL's lifetime a batch plans to use.
	batchWindow = maxURLLifetime - urlRefreshMargin - 30*time.Second
	// initialThroughput is assumed until an upload has been measured;
	// minThroughput floors the estimate.
	initialThroughput = 1 << 20
	minThroughput     = 256 << 10
)

type urlCacheKey struct {
	method, key, uploadID string
	partNumber            int
	size                  int64
}

func cacheKeyOf(r writeRequest) urlCacheKey {
	k := urlCacheKey{method: r.Method, key: r.Key, uploadID: r.UploadID, partNumber: r.PartNumber, size: -1}
	if r.Size != nil {
		k.size = *r.Size
	}
	return k
}

// batchState is guarded by WriteProvider.mu.
type batchState struct {
	cache      map[urlCacheKey]*resolvedWrite
	uploads    []providers.PlannedUpload
	uploadIdx  map[string]int
	downloads  []string
	downloadIx map[string]int
	throughput float64 // bytes per second, smoothed
}

// PrepareUploads implements providers.UploadPlanner: the uploads the caller
// is about to make, in order, so each PUT resolve also resolves the next
// small files' URLs.
func (p *WriteProvider) PrepareUploads(entries []providers.PlannedUpload) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.batch.uploads = append([]providers.PlannedUpload(nil), entries...)
	p.batch.uploadIdx = make(map[string]int, len(entries))
	for i, e := range entries {
		if _, seen := p.batch.uploadIdx[e.Key]; !seen {
			p.batch.uploadIdx[e.Key] = i
		}
	}
}

// PrepareDownloads implements providers.DownloadPlanner for reads through
// the write session (base manifest, stored-object checks).
func (p *WriteProvider) PrepareDownloads(keys []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.batch.downloads = append([]string(nil), keys...)
	p.batch.downloadIx = make(map[string]int, len(keys))
	for i, k := range keys {
		if _, seen := p.batch.downloadIx[k]; !seen {
			p.batch.downloadIx[k] = i
		}
	}
}

// recordThroughput folds one transfer into the throughput estimate.
func (p *WriteProvider) recordThroughput(bytes int64, elapsed time.Duration) {
	if bytes < 1<<20 || elapsed <= 0 {
		return // too small to measure the link
	}
	rate := float64(bytes) / elapsed.Seconds()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.batch.throughput == 0 {
		p.batch.throughput = rate
	} else {
		p.batch.throughput = 0.7*p.batch.throughput + 0.3*rate
	}
}

func (p *WriteProvider) throughputLocked() float64 {
	t := p.batch.throughput
	if t == 0 {
		t = initialThroughput
	}
	return max(t, minThroughput)
}

// windowBytes is how many bytes a batch may plan for.
func (p *WriteProvider) windowBytes() int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return int64(p.throughputLocked() * batchWindow.Seconds())
}

// usableLocked reports whether a cached URL can still carry size bytes
// before it expires.
func (p *WriteProvider) usableLocked(obj *resolvedWrite, size int64) bool {
	need := urlRefreshMargin
	if size > 0 {
		need += time.Duration(float64(size) / p.throughputLocked() * float64(time.Second))
	}
	return time.Until(obj.expiresAt) > need
}

// takeCached removes and returns a usable cached URL for req.
func (p *WriteProvider) takeCached(req writeRequest) *resolvedWrite {
	k := cacheKeyOf(req)
	p.mu.Lock()
	defer p.mu.Unlock()
	obj := p.batch.cache[k]
	if obj == nil {
		return nil
	}
	delete(p.batch.cache, k)
	if !p.usableLocked(obj, max(k.size, 0)) {
		return nil
	}
	return obj
}

// resolveWithLookahead returns a URL for req: a cached one, or one from a
// new batch of req plus extra (and, for a PUT or GET, the next planned
// uploads or downloads).
func (p *WriteProvider) resolveWithLookahead(ctx context.Context, req writeRequest, extra []writeRequest) (*resolvedWrite, error) {
	if req.Method != http.MethodGet {
		p.markWrote()
	}
	if obj := p.takeCached(req); obj != nil {
		return obj, nil
	}
	batch := []writeRequest{req}
	switch req.Method {
	case http.MethodPut:
		extra = append(extra, p.plannedUploadsAfter(req.Key)...)
	case http.MethodGet:
		extra = append(extra, p.plannedDownloadsAfter(req.Key)...)
	}
	seen := map[urlCacheKey]bool{cacheKeyOf(req): true}
	p.mu.Lock()
	for _, r := range extra {
		if len(batch) >= p.desc.MaxBatch {
			break
		}
		k := cacheKeyOf(r)
		if seen[k] {
			continue
		}
		if obj := p.batch.cache[k]; obj != nil && p.usableLocked(obj, max(k.size, 0)) {
			continue
		}
		seen[k] = true
		batch = append(batch, r)
	}
	p.mu.Unlock()

	resolved, denied, err := p.resolveBatch(ctx, batch)
	if err != nil {
		return nil, err
	}
	self := cacheKeyOf(req)
	p.mu.Lock()
	if p.batch.cache == nil {
		p.batch.cache = map[urlCacheKey]*resolvedWrite{}
	}
	for k, obj := range resolved {
		if k != self {
			p.batch.cache[k] = obj
		}
	}
	p.mu.Unlock()
	if code, ok := denied[self]; ok {
		return nil, &controlError{op: "objects:resolve", status: http.StatusForbidden, code: code}
	}
	return resolved[self], nil
}

// plannedUploadsAfter builds PUT requests for the planned small files after
// key, within the batch window.
func (p *WriteProvider) plannedUploadsAfter(key string) []writeRequest {
	p.mu.Lock()
	idx, ok := p.batch.uploadIdx[key]
	var next []providers.PlannedUpload
	if ok {
		end := min(len(p.batch.uploads), idx+1+p.desc.MaxBatch)
		next = append(next, p.batch.uploads[idx+1:end]...)
	}
	p.mu.Unlock()
	if len(next) == 0 {
		return nil
	}
	budget := p.windowBytes()
	var out []writeRequest
	var planned int64
	for _, e := range next {
		if !p.ownsKey(e.Key) {
			continue
		}
		info, err := os.Stat(e.LocalPath)
		if err != nil || !info.Mode().IsRegular() || info.Size() > p.singlePutMax {
			continue
		}
		size := info.Size()
		if planned+size > budget {
			break
		}
		planned += size
		out = append(out, writeRequest{Method: http.MethodPut, Key: e.Key, Size: &size})
	}
	return out
}

func (p *WriteProvider) plannedDownloadsAfter(key string) []writeRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	idx, ok := p.batch.downloadIx[key]
	if !ok {
		return nil
	}
	end := min(len(p.batch.downloads), idx+1+p.desc.MaxBatch)
	var out []writeRequest
	for _, k := range p.batch.downloads[idx+1 : end] {
		out = append(out, writeRequest{Method: http.MethodGet, Key: k})
	}
	return out
}

// resolveBatch exchanges requests for presigned URLs in one call. Every
// request must be answered exactly once, granted or denied; anything else
// rejects the whole answer.
func (p *WriteProvider) resolveBatch(ctx context.Context, reqs []writeRequest) (map[urlCacheKey]*resolvedWrite, map[urlCacheKey]string, error) {
	var wire struct {
		Objects []struct {
			Key        string            `json:"key"`
			Method     string            `json:"method"`
			URL        string            `json:"url"`
			Headers    map[string]string `json:"headers"`
			ExpiresAt  string            `json:"expiresAt"`
			ExpiresIn  *int64            `json:"expiresIn"`
			UploadID   string            `json:"uploadId"`
			PartNumber int               `json:"partNumber"`
		} `json:"objects"`
		Denied []struct {
			Key        string `json:"key"`
			Method     string `json:"method"`
			PartNumber int    `json:"partNumber"`
			Code       string `json:"code"`
		} `json:"denied"`
	}
	var hdr http.Header
	if err := p.callWithHeader(ctx, "objects:resolve", map[string]any{"requests": reqs}, &wire, &hdr); err != nil {
		return nil, nil, err
	}
	received := time.Now()
	type ident struct {
		method, key string
		part        int
	}
	want := make(map[ident]writeRequest, len(reqs))
	for _, r := range reqs {
		want[ident{r.Method, r.Key, r.PartNumber}] = r
	}
	answered := map[ident]bool{}
	resolved := make(map[urlCacheKey]*resolvedWrite, len(wire.Objects))
	denied := map[urlCacheKey]string{}
	for _, o := range wire.Objects {
		id := ident{o.Method, o.Key, 0}
		if o.Method == "UPLOAD_PART" {
			id.part = o.PartNumber
		}
		req, ok := want[id]
		if !ok || answered[id] {
			return nil, nil, sessionErr("resolve answered an object that was not requested, or twice")
		}
		answered[id] = true
		if req.Method == "UPLOAD_PART" && o.UploadID != req.UploadID {
			return nil, nil, sessionErr("resolve answered a different multipart upload")
		}
		u, err := url.Parse(o.URL)
		if err != nil || u.Host == "" || u.User != nil || !schemeAllowed(u) {
			return nil, nil, sessionErr("resolve returned an unacceptable storage URL")
		}
		headers := http.Header{}
		for name, value := range o.Headers {
			canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
			if canonical == "" {
				return nil, nil, sessionErr("resolve returned an empty header name")
			}
			if canonical == "Content-Length" && req.Size != nil {
				if value != strconv.FormatInt(*req.Size, 10) {
					return nil, nil, sessionErr("resolve signed a content length of %q for a %d-byte object", value, *req.Size)
				}
				continue
			}
			if _, bad := forbiddenObjectHeaders[canonical]; bad {
				return nil, nil, sessionErr("resolve returned forbidden header %q", canonical)
			}
			headers.Set(canonical, value)
		}
		expiresAt, err := time.Parse(time.RFC3339, o.ExpiresAt)
		if err != nil {
			return nil, nil, sessionErr("resolve returned an object without a valid expiry")
		}
		resolved[cacheKeyOf(req)] = &resolvedWrite{url: u, headers: headers, expiresAt: localURLExpiry(received, o.ExpiresIn, hdr.Get("Date"), expiresAt)}
	}
	for _, d := range wire.Denied {
		id := ident{d.Method, d.Key, 0}
		if d.Method == "UPLOAD_PART" {
			id.part = d.PartNumber
		}
		req, ok := want[id]
		if !ok || answered[id] {
			return nil, nil, sessionErr("resolve denied an object that was not requested, or also granted it")
		}
		answered[id] = true
		denied[cacheKeyOf(req)] = d.Code
	}
	if len(answered) != len(want) {
		return nil, nil, sessionErr("resolve left a requested object unanswered")
	}
	return resolved, denied, nil
}
