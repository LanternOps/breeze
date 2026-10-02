package bmr

import (
	"encoding/json"
	"errors"
	"fmt"
)

// ErrServerCertPinMismatch is wrapped by verifyPinnedServerCert when the
// server's verified chain does not match the fingerprint(s) baked into the
// recovery media, so callers can tell a pin refusal from other TLS failures
// with errors.Is instead of matching message text.
var ErrServerCertPinMismatch = errors.New("bmr: server certificate does not match the recovery media's pinned fingerprint")

// ServerUnreachableError means the request to the recovery server never got
// an HTTP response: DNS lookup, TCP connect, TLS handshake (including a
// certificate-pin refusal), a timeout, or a reset failed. It is never a
// verdict on the recovery code (#7649). DNS/dial/TLS failures happen before
// the request is sent; a timeout or reset may come after the server already
// claimed the one-time code, so callers must not promise it was unused.
type ServerUnreachableError struct {
	// Host is the host[:port] the request was sent to.
	Host string
	Err  error
}

func (e *ServerUnreachableError) Error() string {
	return fmt.Sprintf("bmr: could not reach %s: %v", e.Host, e.Err)
}

func (e *ServerUnreachableError) Unwrap() error { return e.Err }

// UnexpectedServerResponseError means the server answered, but not with a
// response a Breeze recovery endpoint produces (an HTML/plain-text page, a
// 404 without the code_invalid body, a proxy error page). The usual cause is
// a server URL that points at some other web server. No Breeze server judged
// the recovery code (#7649).
type UnexpectedServerResponseError struct {
	// Host is the host[:port] the request was sent to.
	Host        string
	StatusCode  int
	ContentType string
}

func (e *UnexpectedServerResponseError) Error() string {
	ct := e.ContentType
	if ct == "" {
		ct = "no content type"
	}
	return fmt.Sprintf("bmr: %s did not answer as a Breeze recovery server (HTTP %d, %s)", e.Host, e.StatusCode, ct)
}

// breezeErrorCode reports whether data is a Breeze JSON error body — an
// object with a non-null `error` field — and that field's value when it is a
// string. The API's own errors carry a string (`{"error":"code_invalid"}`);
// a request-validation failure from zValidator carries an object
// (`{"success":false,"error":{"issues":[...]}}`), so code is "" there.
func breezeErrorCode(data []byte) (code string, ok bool) {
	var body struct {
		Error any `json:"error"`
	}
	if json.Unmarshal(data, &body) != nil || body.Error == nil {
		return "", false
	}
	code, _ = body.Error.(string)
	return code, true
}

// isRequestValidationError reports whether data is zValidator's failure body
// (`{"success":false,"error":{...}}`) — the shape a Breeze route returns
// when the request JSON itself fails schema validation.
func isRequestValidationError(data []byte) bool {
	var body struct {
		Success *bool          `json:"success"`
		Error   map[string]any `json:"error"`
	}
	if json.Unmarshal(data, &body) != nil {
		return false
	}
	return body.Success != nil && !*body.Success && body.Error != nil
}
