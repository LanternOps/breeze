package storagesession

import (
	"bytes"
	"encoding/xml"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/providers"
	"github.com/breeze-rmm/agent/internal/httputil"
)

// maxStoreErrorBodyBytes bounds how much of a refused store response is read
// to find its error code. An S3 error document is a few hundred bytes; a
// store that answers with more is not giving a code worth reading.
const maxStoreErrorBodyBytes = 4 << 10

// storeErrorCodePattern is the only shape of code ever carried: S3 codes are
// short CamelCase words (AccessDenied, NoSuchBucket). Anything else in the
// body, however it is dressed, is dropped.
var storeErrorCodePattern = regexp.MustCompile(`^[A-Za-z0-9]{1,64}$`)

// readStoreErrorCode reads at most maxStoreErrorBodyBytes of a refused store
// response and returns the S3 error code, the text of <Code> directly under a
// root <Error>, when it matches storeErrorCodePattern; otherwise "". Nothing
// else from the body is ever returned, logged or kept.
func readStoreErrorCode(body io.Reader) string {
	data, _ := io.ReadAll(io.LimitReader(body, maxStoreErrorBodyBytes))
	if len(data) == 0 {
		return ""
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	inCode := false
	var code strings.Builder
	for {
		tok, err := dec.Token()
		if err != nil {
			// EOF before </Code>, a truncated or malformed body, an
			// undeclared entity: no code.
			return ""
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			switch {
			case inCode:
				return "" // markup inside <Code>
			case depth == 1 && t.Name.Local != "Error":
				return ""
			case depth == 2 && t.Name.Local == "Code":
				inCode = true
			}
		case xml.CharData:
			if inCode {
				if code.Len()+len(t) > 256 {
					return ""
				}
				code.Write(t)
			}
		case xml.EndElement:
			if inCode {
				c := strings.TrimSpace(code.String())
				if storeErrorCodePattern.MatchString(c) {
					return c
				}
				return ""
			}
			depth--
			if depth == 0 {
				return "" // </Error> without a <Code>
			}
		}
	}
}

// storageStatusError is a non-2xx answer from the object store itself (not
// the control plane). code is the store's S3 error code when it gave one.
type storageStatusError struct {
	status     int
	retryAfter time.Duration
	code       string
}

// newStorageStatusError reads resp's status, Retry-After and error code. It
// reads at most maxStoreErrorBodyBytes of the body and leaves the body open.
func newStorageStatusError(resp *http.Response) *storageStatusError {
	return &storageStatusError{
		status:     resp.StatusCode,
		retryAfter: httputil.ParseRetryAfter(resp.Header, time.Now()),
		code:       readStoreErrorCode(resp.Body),
	}
}

// answer is the store's answer as said in every message that carries it:
// "storage answered status 403", plus " (AccessDenied)" when there is a code.
func (e *storageStatusError) answer() string {
	if e.code == "" {
		return fmt.Sprintf("storage answered status %d", e.status)
	}
	return fmt.Sprintf("storage answered status %d (%s)", e.status, e.code)
}

func (e *storageStatusError) Error() string {
	return "storage session: " + e.answer()
}

// Is makes a storage 404 a confirmed-absent object.
func (e *storageStatusError) Is(target error) bool {
	return e.status == http.StatusNotFound && target == providers.ErrObjectNotFound
}

// StoreErrorCode implements the interface providers.StoreErrorCode looks for.
func (e *storageStatusError) StoreErrorCode() string { return e.code }

// destinationRefusalThreshold is how many DIFFERENT object keys the store
// must refuse in a row, with no store request succeeding in between, before
// the writer declares the destination refusing and fails every later call.
//
// It is four times the upload pool's width (backup.uploadConcurrency, 8).
// Every store request of the run counts (file uploads and their parts,
// read-backs, the lease refresh), and any success from any of them resets the
// count, so on a working destination a refused object has to be followed by
// 31 more refused objects across all workers with not one success among them.
// One object refused over and over counts once. On a destination that
// refuses everything, the pool reaches it within its first few files per
// worker: minutes, against the hours or days a run used to spend skipping
// every file.
const destinationRefusalThreshold = 32

// objectLevelNotFoundCodes are 404 codes that describe one object, not the
// destination: a working store answering that an object (or a multipart
// upload, or a version) is absent. They neither count nor reset: reading back
// thousands of genuinely missing objects must not fail the run.
var objectLevelNotFoundCodes = map[string]struct{}{
	"NoSuchKey":     {},
	"NoSuchUpload":  {},
	"NoSuchVersion": {},
}

// countsAsDestinationRefusal reports whether a store answer is the kind a
// refusing destination gives: 401, 403, or a 404 that does not name a missing
// object (NoSuchBucket, or no code at all). 5xx, 429 and transport failures
// are the transient path and never count.
func countsAsDestinationRefusal(e *storageStatusError) bool {
	switch e.status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return true
	case http.StatusNotFound:
		_, objectLevel := objectLevelNotFoundCodes[e.code]
		return !objectLevel
	}
	return false
}

// destinationRefusedError ends a run whose destination refused every
// request. It names the store's last refusal and wraps
// providers.ErrDestinationRefused; it is deliberately NOT a 404/ErrObjectNotFound,
// so no caller reads it as an absent object.
type destinationRefusedError struct {
	last *storageStatusError
}

func (e *destinationRefusedError) Error() string {
	return providers.ErrDestinationRefused.Error() + ": " + e.last.answer()
}

func (e *destinationRefusedError) Unwrap() error { return providers.ErrDestinationRefused }

func (e *destinationRefusedError) StoreErrorCode() string { return e.last.code }

// refusalTracker counts consecutive store refusals across different keys for
// one writer. It is shared by every goroutine using the writer.
type refusalTracker struct {
	mu          sync.Mutex
	refusedKeys map[string]struct{}
	tripped     *destinationRefusedError
}

// err is the destination error once the threshold was reached, else nil.
func (t *refusalTracker) err() error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tripped == nil {
		return nil
	}
	return t.tripped
}

// succeeded records a 2xx answer from the store: the destination works.
func (t *refusalTracker) succeeded() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tripped == nil && len(t.refusedKeys) > 0 {
		clear(t.refusedKeys)
	}
}

// refused records a non-2xx store answer for key and returns the error the
// caller should return: the destination error once the threshold is (or
// already was) reached, otherwise statusErr itself.
func (t *refusalTracker) refused(key string, statusErr *storageStatusError) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tripped != nil {
		return t.tripped
	}
	if !countsAsDestinationRefusal(statusErr) {
		return statusErr
	}
	if t.refusedKeys == nil {
		t.refusedKeys = make(map[string]struct{})
	}
	t.refusedKeys[key] = struct{}{}
	if len(t.refusedKeys) < destinationRefusalThreshold {
		return statusErr
	}
	t.tripped = &destinationRefusedError{last: statusErr}
	// Status and code only: never the key, URL, headers or body.
	slog.Error("storage session: the backup destination refused every request; failing the run",
		"status", statusErr.status,
		"storeCode", statusErr.code,
		"distinctObjectsRefused", len(t.refusedKeys),
	)
	return t.tripped
}
