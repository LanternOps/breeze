package tools

import (
	"encoding/base64"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// DiagnosticAuthorizationPayloadKey is the command-payload field that carries a
// server-signed, per-command authorization derived from an administrator-
// approved diagnostic read grant. Only diag_file_list / diag_file_read honour
// it (and require it); every other command carrying it is refused.
const DiagnosticAuthorizationPayloadKey = "diagnosticAuthorization"

// diagAuthDomain separates this signature from every other message signed
// with the deployment key (release manifests, rollback directives). It must
// match DOMAIN in apps/api/src/services/diagnosticAccess/authorization.ts.
const diagAuthDomain = "breeze-agent-diagnostic-read-v1"

// diagClockSkew tolerates a device clock running slow (a token that appears
// issued slightly in the future). Expiry itself is never extended.
const diagClockSkew = 1 * time.Minute

// diagMaxTokenLifetime bounds how far in the future a token may claim to
// expire, independent of the server's choice, so a token signed with a far
// expiry (a bug, or a compromised signer) is refused rather than honoured.
// The server mints at delivery with a 2-minute lifetime, capped at the grant's
// expiry, and the agent honours it only until that expiry. That is the bound on
// an authorization already delivered when its grant is revoked (undelivered
// commands stop at delivery).
const diagMaxTokenLifetime = 2 * time.Minute

// Coded failures. The API maps each code to a distinct condition for the
// caller (see diagnosticAccess/errors.ts); keep the two lists in step.
const (
	DiagErrMalformed         = "E_DIAG_MALFORMED"
	DiagErrSignature         = "E_DIAG_SIGNATURE"
	DiagErrExpired           = "E_DIAG_EXPIRED"
	DiagErrDevice            = "E_DIAG_DEVICE"
	DiagErrReplay            = "E_DIAG_REPLAY"
	DiagErrOperation         = "E_DIAG_OPERATION"
	DiagErrPathMismatch      = "E_DIAG_PATH_MISMATCH"
	DiagErrPathForm          = "E_DIAG_PATH_FORM"
	DiagErrOutOfScope        = "E_DIAG_OUT_OF_SCOPE"
	DiagErrSensitive         = "E_DIAG_SENSITIVE_NOT_GRANTED"
	DiagErrHardDenied        = "E_DIAG_HARD_DENIED"
	DiagErrLinkRefused       = "E_DIAG_LINK_REFUSED"
	DiagErrNotFound          = "E_DIAG_NOT_FOUND"
	DiagErrPermissionDenied  = "E_DIAG_OS_PERMISSION_DENIED"
	DiagErrNotAFile          = "E_DIAG_NOT_A_FILE"
	DiagErrNotADirectory     = "E_DIAG_NOT_A_DIRECTORY"
	DiagErrIO                = "E_DIAG_IO"
	DiagErrNotSupported      = "E_DIAG_UNSUPPORTED_PLATFORM"
	DiagErrWriteNotPermitted = "E_DIAG_WRITE_NOT_PERMITTED"
	DiagErrCommandMismatch   = "E_DIAG_COMMAND_MISMATCH"
	DiagErrArgsMismatch      = "E_DIAG_ARGS_MISMATCH"
	DiagErrEncryption        = "E_DIAG_ENCRYPTION"
)

// DiagError is a coded, user-presentable failure. Error() is "<CODE>: <msg>",
// which is what reaches the command result's error field.
type DiagError struct {
	Code string
	Msg  string
}

func (e *DiagError) Error() string { return e.Code + ": " + e.Msg }

func diagErr(code, format string, args ...any) *DiagError {
	return &DiagError{Code: code, Msg: fmt.Sprintf(format, args...)}
}

// DiagGrantRoot is one approved location. Recursive grants cover the whole
// subtree. A non-recursive grant covers the location itself: listing it, and
// reading the files directly inside it (never listing a subdirectory).
type DiagGrantRoot struct {
	Path      string `json:"path"`
	Recursive bool   `json:"recursive"`
}

// DiagnosticAuthorization is the signed per-command authorization.
type DiagnosticAuthorization struct {
	Version          int             `json:"v"`
	AuthorizationID  string          `json:"authorizationId"`
	CommandID        string          `json:"commandId"`
	GrantID          string          `json:"grantId"`
	DeviceID         string          `json:"deviceId"`
	OrgID            string          `json:"orgId"`
	Operation        string          `json:"operation"`
	RequestPath      string          `json:"requestPath"`
	Offset           int64           `json:"offset"`
	MaxBytes         int64           `json:"maxBytes"`
	Limit            int64           `json:"limit"`
	Encoding         string          `json:"encoding"`
	ResultPublicKey  string          `json:"resultPublicKey"`
	Roots            []DiagGrantRoot `json:"roots"`
	SensitiveClasses []string        `json:"sensitiveClasses"`
	ApprovedBy       string          `json:"approvedBy"`
	IssuedAt         string          `json:"issuedAt"`
	ExpiresAt        string          `json:"expiresAt"`
	KeyID            string          `json:"keyId"`
	Signature        string          `json:"signature"`
}

// DiagGrantEnv is what the heartbeat supplies: this device's identity and a
// verifier over the deployment keys pinned from this server's heartbeat only
// (not the embedded vendor release keys the updater also trusts).
type DiagGrantEnv struct {
	DeviceID string
	OrgID    string
	Verify   func(keyID string, payload, signature []byte) error
	Now      func() time.Time
}

func (e DiagGrantEnv) now() time.Time {
	if e.Now != nil {
		return e.Now()
	}
	return time.Now()
}

func rejectControl(field, value string) error {
	for _, r := range value {
		if r < 0x20 || r == 0x7f {
			return diagErr(DiagErrMalformed, "%s contains a control character", field)
		}
	}
	return nil
}

// CanonicalBytes is the exact byte string the server signed. Every field is
// on its own line; control characters are rejected so no field can smuggle a
// line break into a neighbour's position.
func (a *DiagnosticAuthorization) CanonicalBytes() ([]byte, error) {
	if a.Version != 1 {
		return nil, diagErr(DiagErrMalformed, "unsupported authorization version %d", a.Version)
	}
	classes := append([]string(nil), a.SensitiveClasses...)
	sort.Strings(classes)
	lines := []string{
		diagAuthDomain,
		a.AuthorizationID,
		a.CommandID,
		a.GrantID,
		a.DeviceID,
		a.OrgID,
		a.Operation,
		a.RequestPath,
		fmt.Sprintf("%d", a.Offset),
		fmt.Sprintf("%d", a.MaxBytes),
		fmt.Sprintf("%d", a.Limit),
		a.Encoding,
		a.ResultPublicKey,
		fmt.Sprintf("%d", len(a.Roots)),
	}
	for _, root := range a.Roots {
		flag := "0"
		if root.Recursive {
			flag = "1"
		}
		lines = append(lines, flag+":"+root.Path)
	}
	lines = append(lines,
		strings.Join(classes, ","),
		a.ApprovedBy,
		a.IssuedAt,
		a.ExpiresAt,
		a.KeyID,
	)
	for i, line := range lines {
		if err := rejectControl(fmt.Sprintf("line %d", i), line); err != nil {
			return nil, err
		}
	}
	return []byte(strings.Join(lines, "\n")), nil
}

// ParseDiagnosticAuthorization extracts the authorization from a command
// payload. present is false only when the key is absent altogether; a key
// that is present but unusable is an error, never a silent fallback.
func ParseDiagnosticAuthorization(payload map[string]any) (*DiagnosticAuthorization, bool, error) {
	raw, ok := payload[DiagnosticAuthorizationPayloadKey]
	if !ok || raw == nil {
		return nil, false, nil
	}
	obj, ok := raw.(map[string]any)
	if !ok {
		return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization must be an object")
	}
	str := func(key string) (string, error) {
		v, ok := obj[key].(string)
		if !ok || v == "" {
			return "", diagErr(DiagErrMalformed, "diagnostic authorization field %q missing", key)
		}
		return v, nil
	}
	a := &DiagnosticAuthorization{}
	switch v := obj["v"].(type) {
	case float64:
		a.Version = int(v)
	case int:
		a.Version = v
	default:
		return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization version missing")
	}
	var err error
	for _, f := range []struct {
		key string
		dst *string
	}{
		{"authorizationId", &a.AuthorizationID},
		{"commandId", &a.CommandID},
		{"grantId", &a.GrantID},
		{"deviceId", &a.DeviceID},
		{"orgId", &a.OrgID},
		{"operation", &a.Operation},
		{"requestPath", &a.RequestPath},
		{"resultPublicKey", &a.ResultPublicKey},
		{"approvedBy", &a.ApprovedBy},
		{"issuedAt", &a.IssuedAt},
		{"expiresAt", &a.ExpiresAt},
		{"keyId", &a.KeyID},
		{"signature", &a.Signature},
	} {
		if *f.dst, err = str(f.key); err != nil {
			return nil, true, err
		}
	}
	// encoding applies to reads only; a list authorization carries "".
	if v, ok := obj["encoding"]; ok && v != nil {
		enc, ok := v.(string)
		if !ok {
			return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization field \"encoding\" malformed")
		}
		a.Encoding = enc
	}
	num := func(key string) (int64, error) {
		switch v := obj[key].(type) {
		case float64:
			if v != float64(int64(v)) || v < 0 {
				return 0, diagErr(DiagErrMalformed, "diagnostic authorization field %q must be a non-negative integer", key)
			}
			return int64(v), nil
		case int:
			return int64(v), nil
		case int64:
			return v, nil
		default:
			return 0, diagErr(DiagErrMalformed, "diagnostic authorization field %q missing", key)
		}
	}
	for _, f := range []struct {
		key string
		dst *int64
	}{{"offset", &a.Offset}, {"maxBytes", &a.MaxBytes}, {"limit", &a.Limit}} {
		if *f.dst, err = num(f.key); err != nil {
			return nil, true, err
		}
	}
	roots, ok := obj["roots"].([]any)
	if !ok || len(roots) == 0 || len(roots) > 20 {
		return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization roots must list 1-20 locations")
	}
	for _, r := range roots {
		m, ok := r.(map[string]any)
		if !ok {
			return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization root malformed")
		}
		p, ok := m["path"].(string)
		rec, okRec := m["recursive"].(bool)
		if !ok || p == "" || !okRec {
			return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization root malformed")
		}
		a.Roots = append(a.Roots, DiagGrantRoot{Path: p, Recursive: rec})
	}
	if classes, ok := obj["sensitiveClasses"].([]any); ok {
		for _, c := range classes {
			s, ok := c.(string)
			if !ok || !diagKnownClasses[s] {
				return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization names an unknown sensitive class")
			}
			a.SensitiveClasses = append(a.SensitiveClasses, s)
		}
	} else if obj["sensitiveClasses"] != nil {
		return nil, true, diagErr(DiagErrMalformed, "diagnostic authorization sensitiveClasses malformed")
	}
	return a, true, nil
}

// diagReplayCache remembers authorization ids this process has accepted until
// they expire, so one signed authorization runs at most once per agent
// process. Command-id dedup in the heartbeat already stops a redelivered
// command; this also stops the same token being lifted into a different
// command.
type diagReplayCache struct {
	mu   sync.Mutex
	seen map[string]time.Time
}

var diagReplay = &diagReplayCache{seen: map[string]time.Time{}}

func (c *diagReplayCache) claim(id string, expires, now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, exp := range c.seen {
		if now.After(exp.Add(diagClockSkew)) {
			delete(c.seen, k)
		}
	}
	if _, dup := c.seen[id]; dup {
		return false
	}
	c.seen[id] = expires
	return true
}

// VerifyDiagnosticAuthorization checks everything about the token that does
// not require touching the filesystem: signature, device binding, lifetime,
// operation, the exact requested path, and single use. Containment against
// the roots happens later, on the opened handle.
// DiagCommandArgs are the command's own arguments the authorization must match
// exactly, so a token minted for one page or one encoding cannot be replayed
// against another.
type DiagCommandArgs struct {
	CommandID       string
	Path            string
	Offset          int64
	MaxBytes        int64
	Limit           int64
	Encoding        string
	ResultPublicKey string
}

func VerifyDiagnosticAuthorization(a *DiagnosticAuthorization, env DiagGrantEnv, operation string, args DiagCommandArgs) error {
	if env.Verify == nil {
		return diagErr(DiagErrSignature, "no pinned deployment key is available to verify the authorization")
	}
	if operation != "list" && operation != "read" {
		return diagErr(DiagErrWriteNotPermitted, "diagnostic authorization covers list and read only")
	}
	canonical, err := a.CanonicalBytes()
	if err != nil {
		return err
	}
	sig, err := base64.StdEncoding.DecodeString(a.Signature)
	if err != nil || len(sig) != 64 {
		return diagErr(DiagErrSignature, "diagnostic authorization signature is not a valid Ed25519 signature")
	}
	if err := env.Verify(a.KeyID, canonical, sig); err != nil {
		return diagErr(DiagErrSignature, "diagnostic authorization signature did not verify against a pinned deployment key")
	}
	// Everything below is signed content, so it is now trustworthy input.
	if env.DeviceID == "" || a.DeviceID != env.DeviceID {
		return diagErr(DiagErrDevice, "diagnostic authorization was issued for a different device")
	}
	if env.OrgID == "" || a.OrgID != env.OrgID {
		return diagErr(DiagErrDevice, "diagnostic authorization was issued for a different organization")
	}
	if a.Operation != operation {
		return diagErr(DiagErrOperation, "diagnostic authorization is for %q, not %q", a.Operation, operation)
	}
	if args.CommandID == "" || a.CommandID != args.CommandID {
		return diagErr(DiagErrCommandMismatch, "diagnostic authorization was issued for a different command")
	}
	if a.RequestPath != args.Path {
		return diagErr(DiagErrPathMismatch, "command path does not match the authorized path")
	}
	if a.Offset != args.Offset || a.MaxBytes != args.MaxBytes || a.Limit != args.Limit ||
		a.Encoding != args.Encoding || a.ResultPublicKey != args.ResultPublicKey {
		return diagErr(DiagErrArgsMismatch, "command arguments do not match the authorization")
	}
	issued, err1 := time.Parse(time.RFC3339, a.IssuedAt)
	expires, err2 := time.Parse(time.RFC3339, a.ExpiresAt)
	if err1 != nil || err2 != nil || !expires.After(issued) {
		return diagErr(DiagErrMalformed, "diagnostic authorization timestamps are invalid")
	}
	if expires.Sub(issued) > diagMaxTokenLifetime {
		return diagErr(DiagErrMalformed, "diagnostic authorization lifetime exceeds the agent's limit")
	}
	now := env.now()
	// Expiry is exact: the server already caps it at the grant's own expiry,
	// so no skew is added here. Skew applies only to a token that looks
	// issued in the future (a device clock running slow).
	if now.After(expires) {
		return diagErr(DiagErrExpired, "diagnostic authorization expired at %s", a.ExpiresAt)
	}
	if now.Add(diagClockSkew).Before(issued) {
		return diagErr(DiagErrExpired, "diagnostic authorization is not valid yet (device clock may be wrong)")
	}
	if !diagReplay.claim(a.AuthorizationID, expires, now) {
		return diagErr(DiagErrReplay, "diagnostic authorization has already been used")
	}
	return nil
}

// errDiagUnsupported is returned by platform hooks that cannot bind a check to
// an opened handle; grant mode then refuses rather than degrading.
var errDiagUnsupported = errors.New("final path by handle is not supported on this platform")
