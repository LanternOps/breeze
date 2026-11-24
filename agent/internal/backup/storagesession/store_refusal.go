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
// to find its error code and reason. An S3 error document is a few hundred bytes; a
// store that answers with more is not giving a code worth reading.
const maxStoreErrorBodyBytes = 4 << 10

// storeErrorCodePattern is the only shape of code ever carried: S3 codes are
// short CamelCase words (AccessDenied, NoSuchBucket). Anything else in the
// body, however it is dressed, is dropped.
var storeErrorCodePattern = regexp.MustCompile(`^[A-Za-z0-9]{1,64}$`)

// maxStoreErrorMessageBytes bounds the <Message> text that is matched against
// storeReasonPhrases. A longer message is not matched at all.
const maxStoreErrorMessageBytes = 1 << 10

// storeReasonProviderCapExceeded is the reason carried when the store said an
// account cap or quota was reached (#12623). It is a fixed token: the API's
// failure classifier (packages/shared backupFailureCategory.ts) matches it
// literally, so it must never change.
const storeReasonProviderCapExceeded = "provider_cap_exceeded"

// storeReasonPhrases is the fixed allowlist a store's <Message> is matched
// against, case-insensitively and with whitespace collapsed. A match carries
// only its fixed reason token; the provider's text itself is never returned,
// logged or kept.
//
// Backblaze B2 answers a capped account with 403 and <Code>AccessDenied</Code>,
// so the code alone reads as a key or bucket-policy problem; the cap is named
// only in <Message>. Each of these contains "cap exceeded":
//   - S3-compatible API, download bandwidth / Class B transaction cap, as
//     observed in #12623: "Cannot download file, download bandwidth or
//     transaction (Class B) cap exceeded. See the Caps & Alerts page to
//     increase your cap."
//   - Native API docs, https://www.backblaze.com/apidocs/b2-upload-file and
//     https://www.backblaze.com/apidocs/b2-download-file-by-name (403
//     cap_exceeded / download_cap_exceeded): "Usage cap exceeded."
//   - Native API docs, https://www.backblaze.com/apidocs/b2-list-file-names
//     (403 transaction_cap_exceeded): "Transaction cap exceeded. Daily
//     transaction caps apply to non-paying accounts."
//
// B2 does not document its S3-compatible cap messages, and the wording of its
// storage-cap refusal there has not been observed; the phrase is what the
// messages above share.
var storeReasonPhrases = []struct {
	phrase *regexp.Regexp
	reason string
}{
	{regexp.MustCompile(`(?i)\bcap exceeded\b`), storeReasonProviderCapExceeded},
}

// storeReasonCodes are S3 error codes that name a cap or quota by themselves:
// QuotaExceeded, a 403 from Ceph RGW (rgw_http_s3_errors in
// https://github.com/ceph/ceph/blob/main/src/rgw/rgw_common.cc) and from
// VersityGW (https://github.com/versity/versitygw/wiki/Incompatibilities-With-AWS-S3).
var storeReasonCodes = map[string]string{
	"QuotaExceeded": storeReasonProviderCapExceeded,
}

// storeReasonOf matches a store's <Message> text against storeReasonPhrases
// and returns the reason token, or "".
func storeReasonOf(message string) string {
	normalized := strings.Join(strings.Fields(message), " ")
	for _, p := range storeReasonPhrases {
		if p.phrase.MatchString(normalized) {
			return p.reason
		}
	}
	return ""
}

// readStoreError reads at most maxStoreErrorBodyBytes of a refused store
// response. code is the S3 error code, the text of <Code> directly under a
// root <Error>, when it matches storeErrorCodePattern; otherwise "". reason is
// a fixed token from storeReasonPhrases when <Message>, directly under the
// same <Error>, matches one; otherwise "". Nothing else from the body is ever
// returned, logged or kept.
//
// A body that turns out truncated or malformed after a valid <Code> still
// yields that code, as it always did, but never a reason: a reason is only
// read from a complete, well-formed error document.
func readStoreError(body io.Reader) (code, reason string) {
	data, _ := io.ReadAll(io.LimitReader(body, maxStoreErrorBodyBytes))
	if len(data) == 0 {
		return "", ""
	}
	dec := xml.NewDecoder(bytes.NewReader(data))
	depth := 0
	// field is the direct child of <Error> being read ("Code" or "Message"),
	// or "" when none is. text accumulates its character data.
	field := ""
	var text strings.Builder
	codeSeen := false
	var message string
	messageSeen := false
	for {
		tok, err := dec.Token()
		if err != nil {
			// EOF before </Error>, a truncated or malformed body, an
			// undeclared entity: the code, if one was read, but no reason.
			return code, ""
		}
		switch t := tok.(type) {
		case xml.StartElement:
			depth++
			switch {
			case field == "Code":
				return "", "" // markup inside <Code>
			case field == "Message":
				// Markup inside <Message>: not a message worth matching.
				field = ""
				messageSeen = true
			case depth == 1 && t.Name.Local != "Error":
				return "", ""
			case depth == 2 && t.Name.Local == "Code" && !codeSeen:
				field = "Code"
				text.Reset()
			case depth == 2 && t.Name.Local == "Message" && !messageSeen:
				field = "Message"
				text.Reset()
			}
		case xml.CharData:
			if field == "" {
				continue
			}
			limit := 256
			if field == "Message" {
				limit = maxStoreErrorMessageBytes
			}
			if text.Len()+len(t) > limit {
				if field == "Code" {
					return "", ""
				}
				field = ""
				messageSeen = true
				continue
			}
			text.Write(t)
		case xml.EndElement:
			depth--
			switch {
			case field == "Code" && depth == 1:
				field = ""
				codeSeen = true
				if c := strings.TrimSpace(text.String()); storeErrorCodePattern.MatchString(c) {
					code = c
				} else {
					return "", ""
				}
			case field == "Message" && depth == 1:
				field = ""
				messageSeen = true
				message = text.String()
			case depth == 0:
				// </Error>: the document is complete.
				return code, storeReasonOf(message)
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
	// reason is a fixed token from storeReasonPhrases or storeReasonCodes
	// (only on a 403), never the store's own text.
	reason string
}

// newStorageStatusError reads resp's status, Retry-After, error code and
// reason. It reads at most maxStoreErrorBodyBytes of the body and leaves the
// body open. A reason is kept only on a 403, the status a capped store
// refuses with: a 5xx or 429 stays on the transient path whatever it says.
func newStorageStatusError(resp *http.Response) *storageStatusError {
	code, reason := readStoreError(resp.Body)
	if reason == "" {
		reason = storeReasonCodes[code]
	}
	if resp.StatusCode != http.StatusForbidden {
		reason = ""
	}
	return &storageStatusError{
		status:     resp.StatusCode,
		retryAfter: httputil.ParseRetryAfter(resp.Header, time.Now()),
		code:       code,
		reason:     reason,
	}
}

// answer is the store's answer as said in every message that carries it:
// "storage answered status 403", plus " (AccessDenied)" when there is a code,
// or " (AccessDenied, provider_cap_exceeded)" when there is also a reason.
//
// The API classifies backup failures from this text alone, so its shape is a
// wire contract: the status and code come first, unchanged, so an API that
// predates the reason token still reads the code it always did, and the
// reason follows as a separate fixed token.
func (e *storageStatusError) answer() string {
	var details []string
	if e.code != "" {
		details = append(details, e.code)
	}
	if e.reason != "" {
		details = append(details, e.reason)
	}
	if len(details) == 0 {
		return fmt.Sprintf("storage answered status %d", e.status)
	}
	return fmt.Sprintf("storage answered status %d (%s)", e.status, strings.Join(details, ", "))
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
// object. A 404 with a code counts unless the code is object-level
// (NoSuchBucket counts, NoSuchKey does not). A 404 with no code counts only on
// a write: a PUT creates its object, so a 404 there is the bucket or the
// destination missing, while a codeless 404 on a read may be a proxy or a
// store answering a missing object without an S3 body, and a read-back pass
// over missing objects must never fail the run. 5xx, 429 and transport
// failures are the transient path and never count.
func countsAsDestinationRefusal(e *storageStatusError, write bool) bool {
	switch e.status {
	case http.StatusUnauthorized, http.StatusForbidden:
		return true
	case http.StatusNotFound:
		if e.code == "" {
			return write
		}
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

// refused records a non-2xx store answer for key (write: it answered a PUT)
// and returns the error the caller should return: the destination error once
// the threshold is (or already was) reached, otherwise statusErr itself.
func (t *refusalTracker) refused(key string, write bool, statusErr *storageStatusError) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.tripped != nil {
		return t.tripped
	}
	if !countsAsDestinationRefusal(statusErr, write) {
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
		"storeReason", statusErr.reason,
		"distinctObjectsRefused", len(t.refusedKeys),
	)
	return t.tripped
}
