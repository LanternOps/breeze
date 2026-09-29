package storagesession

import (
	"context"
	"crypto/sha256"
	"encoding"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"hash"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/httputil"
)

const (
	// defaultSinglePutMax is the largest object sent as one PUT; anything
	// larger is a multipart upload (the same threshold as the S3 provider).
	defaultSinglePutMax = 100 << 20
	// maxMultipartParts is the S3 part-count limit.
	maxMultipartParts = 10_000

	// previousWriterMaxWait bounds how long one call waits for an earlier
	// writer of the same snapshot to be fenced (every upload URL it was
	// issued lasts at most five minutes, plus clock skew).
	previousWriterMaxWait = 7 * time.Minute
	// previousWriterDefaultWait is the wait between attempts when the
	// control plane names no Retry-After.
	previousWriterDefaultWait = 30 * time.Second

	maxListPages = 100_000
	abortTimeout = 30 * time.Second

	// maxExpiryRetries bounds how often one object or part is sent again
	// after an attempt outlasted its URL.
	maxExpiryRetries = 4
)

// urlTransferGrace is how long an upload attempt may run past its URL's
// expiry before it is abandoned and sent again on a fresh URL. The control
// plane waits out every issued URL (plus its own transfer margin, which must
// be at least this) before it treats an earlier writer as fenced, so no
// attempt may still be writing after that. A variable so tests can shorten
// it.
var urlTransferGrace = 30 * time.Second

// errURLExpired is the cancellation cause of an attempt that outlasted its
// URL (see urlTransferGrace).
var errURLExpired = errors.New("upload URL expired during the transfer")

// urlExpiredError reports an attempt abandoned because it outlasted its URL.
type urlExpiredError struct{}

func (e *urlExpiredError) Error() string {
	return "storage session: upload outlasted its URL and was abandoned"
}

// WriteProvider is a providers.BackupProvider backed by a write-scoped
// storage session: it writes only under snapshots/<SnapshotID()>/, through
// short-lived presigned PUT / UploadPart URLs, and asks the control plane to
// create, complete and abort multipart uploads, list and delete. It never
// holds a storage credential. Safe for concurrent use.
type WriteProvider struct {
	*sessionControl

	storage     *http.Client
	idleTimeout time.Duration
	identity    string

	// singlePutMax and partSize are fields so tests can reach the multipart
	// path with small files.
	singlePutMax int64
	partSize     int64
	// minPartSize is the smallest part a multipart upload shrinks to when
	// parts outlast their URLs (the S3 minimum for every part but the last).
	minPartSize int64

	mu           sync.Mutex
	snapshotID   string
	readOnly     bool
	resumeCalled bool
	wrote        bool
	sseAlgorithm string
	sseKMSKeyID  string
}

var (
	_ providers.BackupProvider       = (*WriteProvider)(nil)
	_ providers.ContextDownloader    = (*WriteProvider)(nil)
	_ providers.DigestUploader       = (*WriteProvider)(nil)
	_ providers.SnapshotIDIssuer     = (*WriteProvider)(nil)
	_ providers.StoredObjectDigester = (*WriteProvider)(nil)
	_ providers.JournalIdentity      = (*WriteProvider)(nil)
)

// NewWriteProvider builds a write provider for a validated write-scope
// descriptor (from ParsePayload). ctx bounds every operation; Close releases
// the background renewer.
func NewWriteProvider(ctx context.Context, d *Descriptor, creds Credentials, opts Options) (*WriteProvider, error) {
	ctl, err := newSessionControl(ctx, d, CommandClassWrite, creds, opts)
	if err != nil {
		return nil, err
	}
	p := &WriteProvider{
		sessionControl: ctl,
		storage:        storageClient(opts.StorageClient),
		identity:       "s3-session",
		singlePutMax:   defaultSinglePutMax,
		partSize:       ctl.desc.PartSizeBytes,
		minPartSize:    minPartSizeBytes,
		snapshotID:     ctl.desc.SnapshotID,
	}
	if hint := strings.TrimSpace(opts.IdentityHint); hint != "" {
		p.identity += "|" + hint
	}
	p.idleTimeout = opts.StorageIdleTimeout
	if p.idleTimeout <= 0 {
		p.idleTimeout = defaultStorageIdleTimeout
	}
	return p, nil
}

// Close stops the background renewer and cancels in-flight operations.
func (p *WriteProvider) Close() { p.close() }

// BackupIdentity implements providers.JournalIdentity. The helper does not
// know the destination behind a write session, so the identity names the
// session kind plus the caller's hint (the backup configuration).
func (p *WriteProvider) BackupIdentity() string { return p.identity }

// SnapshotID is the snapshot id this writer currently owns.
func (p *WriteProvider) SnapshotID() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.snapshotID
}

// SetServerSideEncryption records the encryption every PUT must carry; a
// resolved PUT whose signed headers do not name it is refused before any
// byte is sent.
func (p *WriteProvider) SetServerSideEncryption(algorithm, kmsKeyID string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sseAlgorithm = algorithm
	p.sseKMSKeyID = kmsKeyID
}

// --- control-plane calls ---

// controlError is a refusal the control plane answered with a code.
type controlError struct {
	op     string
	status int
	code   string
}

func (e *controlError) Error() string {
	if e.code == "" {
		return fmt.Sprintf("storage session: %s refused with status %d", e.op, e.status)
	}
	return fmt.Sprintf("storage session: %s refused with status %d (%s)", e.op, e.status, e.code)
}

func isControlError(err error, status int, code string) bool {
	var ce *controlError
	return errors.As(err, &ce) && ce.status == status && (code == "" || ce.code == code)
}

func errorCode(resp *http.Response) string {
	var wire struct {
		Code  string `json:"code"`
		Error string `json:"error"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&wire)
	code := wire.Code
	if code == "" {
		code = wire.Error
	}
	if len(code) > 64 {
		code = code[:64]
	}
	return code
}

// call performs one write-session control call and decodes a 200 answer into
// out (nil = ignore the body). Rate limiting and transient failures back
// off within bounds; "previous_writer_active" is waited out for at most
// previousWriterMaxWait; a rejected or ended session ends the provider.
func (p *WriteProvider) call(ctx context.Context, op string, body any, out any) error {
	if err := p.ensureLease(ctx); err != nil {
		return err
	}
	delay := retryInitialDelay
	var rateWaited, writerWaited time.Duration
	transient := 0
	for {
		if err := p.checkDeadline(); err != nil {
			return err
		}
		resp, err := p.controlRequest(ctx, op, body)
		var wait time.Duration
		if err != nil {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return fmt.Errorf("storage session: %s cancelled: %w", op, ctxErr)
			}
			transient++
			if transient >= transientMaxAttempts {
				return fmt.Errorf("storage session: %s failed after %d attempts: %w", op, transient, err)
			}
			wait = delay
		} else {
			status := resp.StatusCode
			switch {
			case status == http.StatusOK:
				var decodeErr error
				if out != nil {
					decodeErr = json.NewDecoder(io.LimitReader(resp.Body, maxControlResponseBytes)).Decode(out)
				}
				drain(resp)
				if decodeErr != nil {
					return sessionErr("invalid %s answer: %v", op, decodeErr)
				}
				return nil
			case status == http.StatusTooManyRequests:
				wait = httputil.ParseRetryAfter(resp.Header, time.Now())
				if wait <= 0 {
					wait = delay
				}
				drain(resp)
				if rateWaited >= rateLimitMaxTotalWait {
					return sessionErr("%s still rate limited after %s", op, rateWaited.Round(time.Second))
				}
				rateWaited += wait
			case status == http.StatusConflict:
				retryAfter := httputil.ParseRetryAfter(resp.Header, time.Now())
				code := errorCode(resp)
				drain(resp)
				if code != "previous_writer_active" {
					return &controlError{op: op, status: status, code: code}
				}
				wait = retryAfter
				if wait <= 0 {
					wait = previousWriterDefaultWait
				}
				if writerWaited+wait > previousWriterMaxWait {
					return fmt.Errorf("%w (%s: waited %s)", providers.ErrPreviousWriterActive, op, writerWaited.Round(time.Second))
				}
				writerWaited += wait
			case isRetryableStatus(status):
				drain(resp)
				transient++
				if transient >= transientMaxAttempts {
					return sessionErr("%s failed with status %d after %d attempts", op, status, transient)
				}
				wait = httputil.ParseRetryAfter(resp.Header, time.Now())
				if wait <= 0 {
					wait = delay
				}
			case status == http.StatusUnauthorized, status == http.StatusNotFound, status == http.StatusGone:
				drain(resp)
				return p.markLost(fmt.Errorf("%s rejected with status %d", op, status))
			case status >= 300 && status < 400:
				drain(resp)
				return p.markLost(fmt.Errorf("control plane answered %s with a redirect (status %d); redirects are not followed", op, status))
			default:
				code := errorCode(resp)
				drain(resp)
				return &controlError{op: op, status: status, code: code}
			}
		}
		if sleepErr := retrySleep(ctx, wait); sleepErr != nil {
			return fmt.Errorf("storage session: %s cancelled during backoff: %w", op, sleepErr)
		}
		delay *= 2
		if delay > retryMaxDelay {
			delay = retryMaxDelay
		}
	}
}

// --- keys ---

func (p *WriteProvider) ownsKey(key string) bool {
	parsed, ok := bmr.ParseObjectKey(key)
	return ok && parsed.SnapshotID == p.SnapshotID()
}

func (p *WriteProvider) checkWritable(key string) error {
	if !p.ownsKey(key) {
		return sessionErr("object %q is outside the snapshot this session writes", key)
	}
	p.mu.Lock()
	readOnly := p.readOnly
	p.mu.Unlock()
	if readOnly {
		return sessionErr("the snapshot this session resumed is already published; it cannot be changed")
	}
	return nil
}

func (p *WriteProvider) markWrote() {
	p.mu.Lock()
	p.wrote = true
	p.mu.Unlock()
}

// --- resume ---

// ResumeSnapshot asks the control plane to let this session continue
// journalID instead of the id it was issued. Allowed once, before any
// upload. See providers.SnapshotIDIssuer.
func (p *WriteProvider) ResumeSnapshot(ctx context.Context, journalID string) (providers.ResumeMode, error) {
	if !validSnapshotID(journalID) {
		return 0, fmt.Errorf("%w: journaled snapshot id is malformed", providers.ErrSnapshotNotResumable)
	}
	p.mu.Lock()
	if journalID == p.snapshotID {
		readOnly := p.readOnly
		p.mu.Unlock()
		if readOnly {
			return providers.ResumeReadOnlyCompletion, nil
		}
		return providers.ResumeWrite, nil
	}
	if p.resumeCalled || p.wrote {
		p.mu.Unlock()
		return 0, fmt.Errorf("%w: a resume must come before any upload and happens at most once", providers.ErrSnapshotNotResumable)
	}
	p.resumeCalled = true
	p.mu.Unlock()

	ctx, stop := p.merge(ctx)
	defer stop()
	var out struct {
		SnapshotID string `json:"snapshotId"`
		Mode       string `json:"mode"`
	}
	err := p.call(ctx, "snapshot:resume", map[string]any{"snapshotId": journalID}, &out)
	switch {
	case err == nil:
	case isControlError(err, http.StatusConflict, "not_resumable"), isControlError(err, http.StatusBadRequest, ""):
		return 0, fmt.Errorf("%w: %v", providers.ErrSnapshotNotResumable, err)
	default:
		return 0, err
	}
	if out.SnapshotID != journalID {
		return 0, sessionErr("resume answered snapshot %q, asked for %q", out.SnapshotID, journalID)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	switch out.Mode {
	case "write":
		p.snapshotID = journalID
		return providers.ResumeWrite, nil
	case "read_only_completion":
		p.snapshotID = journalID
		p.readOnly = true
		return providers.ResumeReadOnlyCompletion, nil
	default:
		return 0, sessionErr("resume answered unknown mode %q", out.Mode)
	}
}

// --- resolve ---

type writeRequest struct {
	Method     string `json:"method"`
	Key        string `json:"key"`
	Size       *int64 `json:"size,omitempty"`
	UploadID   string `json:"uploadId,omitempty"`
	PartNumber int    `json:"partNumber,omitempty"`
}

type resolvedWrite struct {
	url       *url.URL
	headers   http.Header
	expiresAt time.Time
}

// resolveOne exchanges one write request for a presigned URL.
func (p *WriteProvider) resolveOne(ctx context.Context, req writeRequest) (*resolvedWrite, error) {
	if req.Method != http.MethodGet {
		p.markWrote()
	}
	var wire struct {
		Objects []struct {
			Key        string            `json:"key"`
			Method     string            `json:"method"`
			URL        string            `json:"url"`
			Headers    map[string]string `json:"headers"`
			ExpiresAt  string            `json:"expiresAt"`
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
	if err := p.call(ctx, "objects:resolve", map[string]any{"requests": []writeRequest{req}}, &wire); err != nil {
		return nil, err
	}
	if len(wire.Objects)+len(wire.Denied) != 1 {
		return nil, sessionErr("resolve answered %d objects for one request", len(wire.Objects)+len(wire.Denied))
	}
	if len(wire.Denied) == 1 {
		d := wire.Denied[0]
		if d.Key != req.Key || d.Method != req.Method {
			return nil, sessionErr("resolve denied an object that was not requested")
		}
		return nil, &controlError{op: "objects:resolve", status: http.StatusForbidden, code: d.Code}
	}
	o := wire.Objects[0]
	if o.Key != req.Key || o.Method != req.Method {
		return nil, sessionErr("resolve answered an object that was not requested")
	}
	if req.Method == "UPLOAD_PART" && (o.UploadID != req.UploadID || o.PartNumber != req.PartNumber) {
		return nil, sessionErr("resolve answered a different multipart part")
	}
	u, err := url.Parse(o.URL)
	if err != nil || u.Host == "" || u.User != nil || !schemeAllowed(u) {
		return nil, sessionErr("resolve returned an unacceptable storage URL")
	}
	headers := http.Header{}
	for name, value := range o.Headers {
		canonical := http.CanonicalHeaderKey(strings.TrimSpace(name))
		if canonical == "" {
			return nil, sessionErr("resolve returned an empty header name")
		}
		if canonical == "Content-Length" && req.Size != nil {
			if value != strconv.FormatInt(*req.Size, 10) {
				return nil, sessionErr("resolve signed a content length of %q for a %d-byte object", value, *req.Size)
			}
			continue
		}
		if _, bad := forbiddenObjectHeaders[canonical]; bad {
			return nil, sessionErr("resolve returned forbidden header %q", canonical)
		}
		headers.Set(canonical, value)
	}
	expiresAt, err := time.Parse(time.RFC3339, o.ExpiresAt)
	if err != nil {
		return nil, sessionErr("resolve returned an object without a valid expiry")
	}
	if limit := p.now().Add(maxURLLifetime); expiresAt.After(limit) {
		expiresAt = limit
	}
	return &resolvedWrite{url: u, headers: headers, expiresAt: expiresAt}, nil
}

func (p *WriteProvider) checkEncryption(h http.Header) error {
	p.mu.Lock()
	alg, kms := p.sseAlgorithm, p.sseKMSKeyID
	p.mu.Unlock()
	if alg == "" {
		return nil
	}
	if got := h.Get("X-Amz-Server-Side-Encryption"); got != alg {
		return sessionErr("the upload URL does not carry the planned server-side encryption (%s)", alg)
	}
	if alg == "aws:kms" && kms != "" && h.Get("X-Amz-Server-Side-Encryption-Aws-Kms-Key-Id") != kms {
		return sessionErr("the upload URL names a different server-side encryption key")
	}
	return nil
}

// --- storage requests ---

// hashingReader hashes and counts every byte read through it and reports
// progress; it is the only reader of an upload body.
type hashingReader struct {
	r      io.Reader
	h      hash.Hash
	n      int64
	onRead func(n int64)
}

func (r *hashingReader) Read(b []byte) (int, error) {
	n, err := r.r.Read(b)
	if n > 0 {
		_, _ = r.h.Write(b[:n])
		r.n += int64(n)
		if r.onRead != nil {
			r.onRead(r.n)
		}
	}
	return n, err
}

func (r *hashingReader) digest() providers.UploadDigest {
	return providers.UploadDigest{SHA256: hex.EncodeToString(r.h.Sum(nil)), Size: r.n}
}

// idleContext returns a context cancelled with errStorageStalled when touch
// is not called for p.idleTimeout and, when urlExpiresAt is set, with
// errURLExpired once urlExpiresAt plus urlTransferGrace has passed; and a
// mapper turning those cancellations into a storageStallError or a
// urlExpiredError.
func (p *WriteProvider) idleContext(parent context.Context, urlExpiresAt time.Time) (context.Context, func(), func(error) error, func()) {
	ctx, cancel := context.WithCancelCause(parent)
	timer := time.AfterFunc(p.idleTimeout, func() { cancel(errStorageStalled) })
	touch := func() { timer.Reset(p.idleTimeout) }
	var expiry *time.Timer
	if !urlExpiresAt.IsZero() {
		expiry = time.AfterFunc(time.Until(urlExpiresAt.Add(urlTransferGrace)), func() { cancel(errURLExpired) })
	}
	mapErr := func(err error) error {
		if err == nil || parent.Err() != nil {
			return err
		}
		switch cause := context.Cause(ctx); {
		case errors.Is(cause, errStorageStalled):
			return &storageStallError{idle: p.idleTimeout}
		case errors.Is(cause, errURLExpired):
			return &urlExpiredError{}
		}
		return err
	}
	return ctx, touch, mapErr, func() {
		timer.Stop()
		if expiry != nil {
			expiry.Stop()
		}
		cancel(nil)
	}
}

// sendPut PUTs size bytes from body to a resolved URL with exactly its signed
// headers plus Content-Length — never a credential — and follows no
// redirect. It returns the response's ETag.
func (p *WriteProvider) sendPut(ctx context.Context, obj *resolvedWrite, body io.Reader, size int64, touch func()) (string, error) {
	var reqBody io.Reader = http.NoBody
	if size > 0 {
		reqBody = &progressReader{r: body, onRead: touch}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, obj.url.String(), reqBody)
	if err != nil {
		return "", fmt.Errorf("storage session: build storage request: %w", err)
	}
	req.ContentLength = size
	for name, values := range obj.headers {
		for _, v := range values {
			req.Header.Add(name, v)
		}
	}
	resp, err := p.storage.Do(req)
	if err != nil {
		return "", newStorageTransportError("upload", err)
	}
	touch()
	defer drain(resp)
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return resp.Header.Get("ETag"), nil
	case isRedirect(resp.StatusCode):
		return "", sessionErr("storage answered an upload with a redirect (status %d); redirects are not followed", resp.StatusCode)
	default:
		return "", &storageStatusError{status: resp.StatusCode, retryAfter: httputil.ParseRetryAfter(resp.Header, time.Now())}
	}
}

// retryState bounds the retries of one object operation.
type retryState struct {
	attempts, reResolves, stalls, expiries int
	delay                                  time.Duration
}

// next decides whether err is worth another attempt, sleeping as needed.
func (s *retryState) next(ctx context.Context, err error) (bool, error) {
	if s.delay == 0 {
		s.delay = retryInitialDelay
	}
	var statusErr *storageStatusError
	var transportErr *storageTransportError
	var stallErr *storageStallError
	var expiredErr *urlExpiredError
	var wait time.Duration
	switch {
	case errors.As(err, &expiredErr):
		if s.expiries >= maxExpiryRetries {
			return false, err
		}
		s.expiries++
		return true, nil
	case errors.As(err, &stallErr):
		if s.stalls >= maxStallRetries {
			return false, err
		}
		s.stalls++
		return true, nil
	case errors.As(err, &statusErr) && statusErr.status == http.StatusForbidden:
		if s.reResolves >= maxReResolves {
			return false, err
		}
		s.reResolves++
		return true, nil
	case errors.As(err, &statusErr) && isRetryableStatus(statusErr.status):
		wait = statusErr.retryAfter
	case errors.As(err, &transportErr):
		if ctx.Err() != nil {
			return false, fmt.Errorf("storage session: transfer cancelled: %w (%w)", ctx.Err(), err)
		}
	default:
		return false, err
	}
	s.attempts++
	if s.attempts >= transientMaxAttempts {
		return false, err
	}
	if wait <= 0 {
		wait = s.delay
	}
	if sleepErr := retrySleep(ctx, wait); sleepErr != nil {
		return false, fmt.Errorf("storage session: transfer cancelled: %w", sleepErr)
	}
	s.delay *= 2
	if s.delay > retryMaxDelay {
		s.delay = retryMaxDelay
	}
	return true, nil
}

// --- uploads ---

// Upload implements providers.BackupProvider.
func (p *WriteProvider) Upload(localPath, remotePath string) error {
	_, err := p.UploadWithDigest(p.base, localPath, remotePath)
	return err
}

// UploadContext uploads localPath to remotePath.
func (p *WriteProvider) UploadContext(ctx context.Context, localPath, remotePath string) error {
	_, err := p.UploadWithDigest(ctx, localPath, remotePath)
	return err
}

// UploadWithDigest implements providers.DigestUploader: the digest is of the
// bytes read once from localPath and sent, which is what the stored object
// holds. It never answers providers.ErrDigestUnavailable.
func (p *WriteProvider) UploadWithDigest(ctx context.Context, localPath, remotePath string) (providers.UploadDigest, error) {
	if err := p.checkWritable(remotePath); err != nil {
		return providers.UploadDigest{}, err
	}
	if strings.TrimSpace(localPath) == "" {
		return providers.UploadDigest{}, sessionErr("local source path is required")
	}
	ctx, stop := p.merge(ctx)
	defer stop()
	info, err := os.Stat(localPath)
	if err != nil {
		return providers.UploadDigest{}, fmt.Errorf("failed to open source file: %w", err)
	}
	if info.Size() > p.singlePutMax {
		return p.multipartUpload(ctx, localPath, remotePath, 0)
	}
	return p.putUpload(ctx, localPath, remotePath)
}

func (p *WriteProvider) putUpload(ctx context.Context, localPath, key string) (providers.UploadDigest, error) {
	var retry retryState
	existingChecked := false
	for {
		d, err := p.putAttempt(ctx, localPath, key)
		if err == nil {
			return d, nil
		}
		var statusErr *storageStatusError
		if errors.As(err, &statusErr) && statusErr.status == http.StatusPreconditionFailed {
			// A create-only PUT found the key taken. Under this session's
			// own unpublished snapshot that is an earlier attempt's object:
			// keep it when it already holds these bytes, otherwise remove it
			// and upload again (once).
			if existingChecked {
				return providers.UploadDigest{}, sessionErr("object %s already exists", key)
			}
			existingChecked = true
			stored, same, checkErr := p.existingMatchesSource(ctx, localPath, key)
			if checkErr != nil {
				return providers.UploadDigest{}, checkErr
			}
			if same {
				return stored, nil
			}
			if delErr := p.deleteContext(ctx, key); delErr != nil {
				return providers.UploadDigest{}, fmt.Errorf("storage session: replace earlier object %s: %w", key, delErr)
			}
			continue
		}
		var expiredErr *urlExpiredError
		if errors.As(err, &expiredErr) {
			// The link cannot carry the whole object within a URL's life:
			// send it in parts small enough to finish in time instead.
			if info, statErr := os.Stat(localPath); statErr == nil && info.Size() > p.minPartSize {
				return p.multipartUpload(ctx, localPath, key, max(p.minPartSize, info.Size()/4))
			}
		}
		again, finalErr := retry.next(ctx, err)
		if !again {
			return providers.UploadDigest{}, finalErr
		}
	}
}

// putAttempt resolves a PUT URL for the file's current size and sends
// exactly that many bytes, hashing them as they are read.
func (p *WriteProvider) putAttempt(ctx context.Context, localPath, key string) (providers.UploadDigest, error) {
	file, err := os.Open(localPath)
	if err != nil {
		return providers.UploadDigest{}, fmt.Errorf("failed to open source file: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return providers.UploadDigest{}, fmt.Errorf("failed to stat source file: %w", err)
	}
	size := info.Size()
	obj, err := p.resolveOne(ctx, writeRequest{Method: http.MethodPut, Key: key, Size: &size})
	if err != nil {
		return providers.UploadDigest{}, err
	}
	if err := p.checkEncryption(obj.headers); err != nil {
		return providers.UploadDigest{}, err
	}
	progress := providers.UploadProgressFunc(ctx)
	body := &hashingReader{r: io.LimitReader(file, size), h: sha256.New(), onRead: progress}
	attemptCtx, touch, mapErr, done := p.idleContext(ctx, obj.expiresAt)
	defer done()
	if _, err := p.sendPut(attemptCtx, obj, body, size, touch); err != nil {
		return providers.UploadDigest{}, mapErr(err)
	}
	if body.n != size {
		return providers.UploadDigest{}, sessionErr("source file %s changed size while it was uploaded", filepath.Base(localPath))
	}
	return body.digest(), nil
}

// existingMatchesSource compares the stored object with the source file as
// it is now. When they are the same bytes the stored object's digest is
// returned with true.
func (p *WriteProvider) existingMatchesSource(ctx context.Context, localPath, key string) (providers.UploadDigest, bool, error) {
	stored, err := p.StoredObjectDigest(ctx, key)
	if err != nil {
		if errors.Is(err, providers.ErrObjectNotFound) {
			return providers.UploadDigest{}, false, nil
		}
		return providers.UploadDigest{}, false, err
	}
	local, err := fileDigest(ctx, localPath)
	if err != nil {
		return providers.UploadDigest{}, false, err
	}
	return stored, local == stored, nil
}

func fileDigest(ctx context.Context, localPath string) (providers.UploadDigest, error) {
	f, err := os.Open(localPath)
	if err != nil {
		return providers.UploadDigest{}, fmt.Errorf("failed to open source file: %w", err)
	}
	defer func() { _ = f.Close() }()
	r := &hashingReader{r: &ctxReader{ctx: ctx, r: f}, h: sha256.New()}
	if _, err := io.Copy(io.Discard, r); err != nil {
		return providers.UploadDigest{}, fmt.Errorf("failed to read source file: %w", err)
	}
	return r.digest(), nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(b []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(b)
}

// multipartPlan returns the initial part size for a size-byte object: want
// (0 = the session's part size), raised so the object fits the part limit.
func (p *WriteProvider) multipartPlan(size, want int64) (int64, error) {
	partSize := p.partSize
	if want > 0 {
		partSize = want
	}
	if need := minPartFor(size, maxMultipartParts); partSize < need {
		partSize = need
	}
	if partSize > maxPartSizeBytes {
		return 0, sessionErr("object of %d bytes is too large for a multipart upload", size)
	}
	return partSize, nil
}

// minPartFor is the smallest part size that sends remaining bytes in at most
// parts parts.
func minPartFor(remaining int64, parts int) int64 {
	if parts < 1 {
		return remaining
	}
	return (remaining + int64(parts) - 1) / int64(parts)
}

type completedPart struct {
	PartNumber int    `json:"partNumber"`
	ETag       string `json:"etag"`
}

// appliedEncryption is the server-side encryption the control plane applied
// when it created a multipart upload.
type appliedEncryption struct {
	Algorithm string `json:"algorithm"`
	KMSKeyID  string `json:"kmsKeyId"`
}

// checkAppliedEncryption compares the encryption a multipart upload was
// created with against the planned one. An answer that names none (an older
// control plane) is accepted only when no encryption is planned.
func (p *WriteProvider) checkAppliedEncryption(applied *appliedEncryption) error {
	p.mu.Lock()
	alg, kms := p.sseAlgorithm, p.sseKMSKeyID
	p.mu.Unlock()
	if applied == nil {
		if alg != "" {
			return sessionErr("the multipart upload does not report the planned server-side encryption (%s)", alg)
		}
		return nil
	}
	if alg == "" {
		return nil
	}
	if applied.Algorithm != alg {
		return sessionErr("the multipart upload was created without the planned server-side encryption (%s)", alg)
	}
	if alg == "aws:kms" && kms != "" && applied.KMSKeyID != kms {
		return sessionErr("the multipart upload was created with a different server-side encryption key")
	}
	return nil
}

// multipartUpload streams the file to a multipart upload, one part at a
// time, straight from the file (nothing is buffered). The digest is of the
// bytes sent, in order: every part attempt restarts the running SHA-256 from
// its state before that part, so a retried part — which re-reads the file —
// contributes exactly the bytes its successful attempt sent. A part that
// outlasts its URL is sent again as a smaller part. The control plane
// creates and completes the upload; any failure aborts it (best effort — the
// control plane's cleanup makes the abort durable). initialPart (0 = the
// session's part size) sets the first part size.
func (p *WriteProvider) multipartUpload(ctx context.Context, localPath, key string, initialPart int64) (providers.UploadDigest, error) {
	file, err := os.Open(localPath)
	if err != nil {
		return providers.UploadDigest{}, fmt.Errorf("failed to open source file: %w", err)
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return providers.UploadDigest{}, fmt.Errorf("failed to stat source file: %w", err)
	}
	size := info.Size()
	partSize, err := p.multipartPlan(size, initialPart)
	if err != nil {
		return providers.UploadDigest{}, err
	}

	p.markWrote()
	var created struct {
		UploadID          string             `json:"uploadId"`
		AppliedEncryption *appliedEncryption `json:"appliedEncryption"`
	}
	if err := p.call(ctx, "multipart:create", map[string]any{"key": key}, &created); err != nil {
		return providers.UploadDigest{}, err
	}
	if created.UploadID == "" || len(created.UploadID) > 1024 {
		return providers.UploadDigest{}, sessionErr("multipart:create returned no usable upload id")
	}
	uploadID := created.UploadID
	abort := func() {
		abortCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), abortTimeout)
		defer cancel()
		if err := p.call(abortCtx, "multipart:abort", map[string]any{"key": key, "uploadId": uploadID}, nil); err != nil {
			slog.Warn("storage session: multipart abort failed; the control plane cleans it up", "error", err.Error())
		}
	}
	if err := p.checkAppliedEncryption(created.AppliedEncryption); err != nil {
		abort()
		return providers.UploadDigest{}, err
	}

	h := sha256.New()
	progress := providers.UploadProgressFunc(ctx)
	var sent int64
	var parts []completedPart
	for number := 1; sent < size; number++ {
		if number > maxMultipartParts {
			abort()
			return providers.UploadDigest{}, sessionErr("object %s needs more than %d parts", key, maxMultipartParts)
		}
		etag, n, err := p.streamPart(ctx, file, key, uploadID, number, sent, size, partSize, h, progress)
		if err != nil {
			abort()
			if ctx.Err() != nil {
				return providers.UploadDigest{}, fmt.Errorf("storage session: upload cancelled: %w", ctx.Err())
			}
			return providers.UploadDigest{}, err
		}
		if n < partSize {
			partSize = n // a part that had to shrink keeps later parts small too
		}
		sent += n
		parts = append(parts, completedPart{PartNumber: number, ETag: etag})
	}
	digest := providers.UploadDigest{SHA256: hex.EncodeToString(h.Sum(nil)), Size: sent}

	if err := p.completeMultipart(ctx, key, uploadID, parts, digest); err != nil {
		abort()
		return providers.UploadDigest{}, err
	}
	return digest, nil
}

// streamPart sends part number, starting at offset, of at most partSize
// bytes, retrying within bounds; a part that outlasts its URL is retried
// smaller (never below minPartSize, nor below what keeps the rest within the
// part limit). h is advanced by exactly the bytes of the successful attempt.
// It returns the part's ETag and length.
func (p *WriteProvider) streamPart(ctx context.Context, file *os.File, key, uploadID string, number int, offset, size, partSize int64, h hash.Hash, progress func(int64)) (string, int64, error) {
	marshaler, ok := h.(encoding.BinaryMarshaler)
	if !ok {
		return "", 0, sessionErr("digest state cannot be saved")
	}
	before, err := marshaler.MarshalBinary()
	if err != nil {
		return "", 0, fmt.Errorf("storage session: save digest state: %w", err)
	}
	remaining := size - offset
	floor := max(minPartFor(remaining, maxMultipartParts-number+1), min(p.minPartSize, remaining))
	n := min(max(partSize, floor), remaining)
	var retry retryState
	for {
		if err := h.(encoding.BinaryUnmarshaler).UnmarshalBinary(before); err != nil {
			return "", 0, fmt.Errorf("storage session: restore digest state: %w", err)
		}
		etag, err := p.partAttempt(ctx, file, key, uploadID, number, offset, n, h, progress)
		if err == nil {
			return etag, n, nil
		}
		var expiredErr *urlExpiredError
		if errors.As(err, &expiredErr) && n > floor {
			n = max(n/2, floor)
			continue
		}
		again, finalErr := retry.next(ctx, err)
		if !again {
			return "", 0, finalErr
		}
	}
}

// partAttempt resolves an UploadPart URL for n bytes at offset and sends
// them from the file, hashing them into h as they are read.
func (p *WriteProvider) partAttempt(ctx context.Context, file *os.File, key, uploadID string, number int, offset, n int64, h hash.Hash, progress func(int64)) (string, error) {
	obj, err := p.resolveOne(ctx, writeRequest{Method: "UPLOAD_PART", Key: key, Size: &n, UploadID: uploadID, PartNumber: number})
	if err != nil {
		return "", err
	}
	var onRead func(int64)
	if progress != nil {
		onRead = func(read int64) { progress(offset + read) }
	}
	body := &hashingReader{r: io.NewSectionReader(file, offset, n), h: h, onRead: onRead}
	attemptCtx, touch, mapErr, done := p.idleContext(ctx, obj.expiresAt)
	defer done()
	etag, err := p.sendPut(attemptCtx, obj, body, n, touch)
	if err != nil {
		return "", mapErr(err)
	}
	if body.n != n {
		return "", sessionErr("source file changed size while it was uploaded")
	}
	if strings.TrimSpace(etag) == "" {
		return "", sessionErr("storage returned no ETag for part %d", number)
	}
	return etag, nil
}

// completeMultipart asks the control plane to complete the upload. A
// create-only completion that finds the key taken keeps an object holding
// exactly these bytes, otherwise removes it and completes again (once). A
// completion the control plane no longer knows may have succeeded on an
// earlier, unanswered attempt: it counts when the stored object holds these
// bytes.
func (p *WriteProvider) completeMultipart(ctx context.Context, key, uploadID string, parts []completedPart, digest providers.UploadDigest) error {
	body := map[string]any{"key": key, "uploadId": uploadID, "parts": parts}
	replaced := false
	for {
		err := p.call(ctx, "multipart:complete", body, nil)
		if err == nil {
			return nil
		}
		existing := isControlError(err, http.StatusPreconditionFailed, "")
		if !existing && !isControlError(err, http.StatusForbidden, "unknown_upload") {
			return err
		}
		stored, storedErr := p.StoredObjectDigest(ctx, key)
		if storedErr == nil && stored == digest {
			return nil
		}
		if !existing || replaced {
			return err
		}
		replaced = true
		if delErr := p.deleteContext(ctx, key); delErr != nil {
			return fmt.Errorf("storage session: replace earlier object %s: %w", key, delErr)
		}
	}
}

// --- reads ---

// Download implements providers.BackupProvider.
func (p *WriteProvider) Download(remotePath, localPath string) error {
	return p.DownloadContext(p.base, remotePath, localPath)
}

// DownloadContext fetches remotePath (a key under this session's snapshot,
// or the server-selected base manifest) into localPath.
func (p *WriteProvider) DownloadContext(ctx context.Context, remotePath, localPath string) error {
	if remotePath == "" {
		return sessionErr("object key is required")
	}
	if strings.TrimSpace(localPath) == "" {
		return sessionErr("local destination path is required")
	}
	if err := os.MkdirAll(filepath.Dir(localPath), 0o755); err != nil {
		return fmt.Errorf("storage session: create destination directory: %w", err)
	}
	return p.getObject(ctx, remotePath, func(body io.Reader) error {
		file, err := os.Create(localPath)
		if err != nil {
			return fmt.Errorf("storage session: create local destination file: %w", err)
		}
		_, copyErr := io.Copy(providers.DownloadProgressWriter(ctx, file), body)
		closeErr := file.Close()
		if copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			_ = os.Remove(localPath)
		}
		return copyErr
	})
}

// StoredObjectDigest implements providers.StoredObjectDigester by reading the
// object back through a GET URL.
func (p *WriteProvider) StoredObjectDigest(ctx context.Context, remotePath string) (providers.UploadDigest, error) {
	var d providers.UploadDigest
	err := p.getObject(ctx, remotePath, func(body io.Reader) error {
		r := &hashingReader{r: body, h: sha256.New()}
		if _, err := io.Copy(io.Discard, r); err != nil {
			return err
		}
		d = r.digest()
		return nil
	})
	return d, err
}

// getObject resolves a GET URL for key and hands the body to sink, retrying
// stalls, refused URLs and transient failures within bounds. Redirects are
// not followed.
func (p *WriteProvider) getObject(ctx context.Context, key string, sink func(io.Reader) error) error {
	ctx, stop := p.merge(ctx)
	defer stop()
	var retry retryState
	for {
		err := p.getAttempt(ctx, key, sink)
		if err == nil {
			return nil
		}
		again, finalErr := retry.next(ctx, err)
		if !again {
			return finalErr
		}
	}
}

func (p *WriteProvider) getAttempt(ctx context.Context, key string, sink func(io.Reader) error) error {
	obj, err := p.resolveOne(ctx, writeRequest{Method: http.MethodGet, Key: key})
	if err != nil {
		return err
	}
	attemptCtx, touch, mapErr, done := p.idleContext(ctx, time.Time{})
	defer done()
	req, err := http.NewRequestWithContext(attemptCtx, http.MethodGet, obj.url.String(), nil)
	if err != nil {
		return fmt.Errorf("storage session: build storage request: %w", err)
	}
	for name, values := range obj.headers {
		for _, v := range values {
			req.Header.Add(name, v)
		}
	}
	resp, err := p.storage.Do(req)
	if err != nil {
		return mapErr(newStorageTransportError("request", err))
	}
	touch()
	defer func() { _ = resp.Body.Close() }()
	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
	case isRedirect(resp.StatusCode):
		return sessionErr("storage answered a download with a redirect (status %d); redirects are not followed", resp.StatusCode)
	default:
		statusErr := &storageStatusError{status: resp.StatusCode, retryAfter: httputil.ParseRetryAfter(resp.Header, time.Now())}
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
		return statusErr
	}
	if err := sink(&progressReader{r: resp.Body, onRead: touch}); err != nil {
		if ctx.Err() != nil {
			return fmt.Errorf("storage session: download cancelled: %w", ctx.Err())
		}
		if mapped := mapErr(err); mapped != err {
			return mapped
		}
		return newStorageTransportError("body read", err)
	}
	return nil
}

// --- list / delete ---

// List returns every key under prefix, which must be this session's
// snapshot prefix or a sub-prefix of it (a missing trailing "/" is added).
func (p *WriteProvider) List(prefix string) ([]string, error) {
	root := "snapshots/" + p.SnapshotID() + "/"
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if !strings.HasPrefix(prefix, root) {
		return nil, sessionErr("listing %q is outside the snapshot this session writes", prefix)
	}
	for _, seg := range strings.Split(strings.TrimSuffix(prefix, "/"), "/") {
		if seg == "" || seg == "." || seg == ".." {
			return nil, sessionErr("listing prefix %q is malformed", prefix)
		}
	}
	ctx, stop := p.merge(p.base)
	defer stop()
	var keys []string
	var token *string
	for page := 0; ; page++ {
		if page >= maxListPages {
			return nil, sessionErr("listing %q did not end", prefix)
		}
		body := map[string]any{"prefix": prefix}
		if token != nil {
			body["continuationToken"] = *token
		}
		var out struct {
			Keys      []string `json:"keys"`
			NextToken *string  `json:"nextToken"`
		}
		if err := p.call(ctx, "objects:list", body, &out); err != nil {
			return nil, err
		}
		for _, k := range out.Keys {
			if !strings.HasPrefix(k, prefix) {
				return nil, sessionErr("listing returned a key outside the requested prefix")
			}
			keys = append(keys, k)
		}
		if out.NextToken == nil || *out.NextToken == "" {
			return keys, nil
		}
		token = out.NextToken
	}
}

// Delete removes one key under this session's snapshot.
func (p *WriteProvider) Delete(remotePath string) error {
	return p.deleteContext(p.base, remotePath)
}

func (p *WriteProvider) deleteContext(ctx context.Context, key string) error {
	if err := p.checkWritable(key); err != nil {
		return err
	}
	ctx, stop := p.merge(ctx)
	defer stop()
	var out struct {
		Deleted []string `json:"deleted"`
		Denied  []struct {
			Key  string `json:"key"`
			Code string `json:"code"`
		} `json:"denied"`
		Failed []struct {
			Key  string `json:"key"`
			Code string `json:"code"`
		} `json:"failed"`
	}
	if err := p.call(ctx, "objects:delete", map[string]any{"keys": []string{key}}, &out); err != nil {
		return err
	}
	for _, d := range out.Denied {
		if d.Key == key {
			return &controlError{op: "objects:delete", status: http.StatusForbidden, code: d.Code}
		}
	}
	for _, f := range out.Failed {
		if f.Key == key {
			return sessionErr("storage could not delete %s (%s)", key, f.Code)
		}
	}
	return nil
}
