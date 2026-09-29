// Package storagesession implements brokered access to backup storage.
// Instead of receiving reusable storage credentials, the helper receives a
// short-lived storage session from the control plane and exchanges exact
// object keys for short-lived object URLs:
//   - read sessions (restore-shaped commands) resolve GET URLs only;
//   - write sessions (backup_run, mssql_backup, hyperv_backup) are bound to
//     ONE server-issued snapshot id and resolve PUT / UploadPart URLs for
//     keys under snapshots/<that id>/ only; multipart create/complete/abort,
//     list and delete run on the control plane.
//
// Wire contract (version 1):
//
//	command payload: "storageSession": {version, sessionId, token, baseUrl,
//	                  expiresAt, deadline, capabilities, maxBatch}
//	                  write sessions add {scope: "snapshot_write", snapshotId,
//	                  partSizeBytes, conditionalWrites}
//	resolve: POST {baseUrl}/api/v1/agents/{agentId}/storage-sessions/{sessionId}/objects:resolve
//	renew:   POST {baseUrl}/api/v1/agents/{agentId}/storage-sessions/{sessionId}/renew
//	write:   POST …/snapshot:resume, …/multipart:create, …/multipart:complete,
//	         …/multipart:abort, …/objects:list, …/objects:delete
//
// Every call carries the agent's own bearer credential in Authorization and
// the session token in the X-Breeze-Storage-Session header — never in a URL.
package storagesession

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/backup/bmr"
)

const (
	// ProtocolVersion is the storage-session protocol this build implements.
	// The helper reports it to the main agent (--protocol-info), which
	// reports it in the heartbeat; the server only brokers reads for a
	// device whose installed helper reports at least this version.
	ProtocolVersion = 1

	// WriteProtocolVersion is the brokered storage-write protocol this build
	// implements (1 = backups are written through storage sessions instead
	// of the configured storage credentials; 0 = not implemented). Reported
	// the same way as ProtocolVersion. Version 1 covers the write provider,
	// the server-issued snapshot id, resume and continuation of a journaled
	// snapshot, and the helper wiring for backup_run, mssql_backup and
	// hyperv_backup — raise it only with all of them in the build.
	WriteProtocolVersion = 1

	// SessionHeader carries the session token on control-plane calls.
	SessionHeader = "X-Breeze-Storage-Session"

	// CapabilityResolveBatch is required: it is the only read method this
	// helper uses.
	CapabilityResolveBatch = "resolve_batch"
	// CapabilityRenew enables lease renewal; without it the lease simply
	// runs to its expiry.
	CapabilityRenew = "renew"
	// Write-session capabilities; every one of them is required, since a
	// backup uses all of them.
	CapabilityPut       = "put"
	CapabilityMultipart = "multipart"
	CapabilityList      = "list"
	CapabilityDelete    = "delete"
	CapabilityResume    = "resume"

	// ScopeSnapshotWrite is the scope of a write session. A read session
	// carries no scope.
	ScopeSnapshotWrite = "snapshot_write"

	// CommandClassRead / CommandClassWrite name the kind of command a
	// session is delivered with (see ValidateFor).
	CommandClassRead  = "read"
	CommandClassWrite = "write"

	// Bounds of a write session's multipart part size (S3 limits).
	minPartSizeBytes = 5 << 20
	maxPartSizeBytes = 5 << 30

	// maxBatchLimit bounds the server-advertised batch size.
	maxBatchLimit = 1000

	// deadlineSkewAllowance tolerates a device clock running ahead of the
	// server when judging whether a freshly delivered session is already past
	// its absolute deadline. The server remains the authority on expiry.
	deadlineSkewAllowance = 2 * time.Minute
)

var (
	sessionIDPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	// >= 256 bits of base64url (43 chars unpadded), optional padding.
	tokenPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,512}={0,2}$`)
)

// allowLoopbackHTTP permits plain http to loopback hosts. It is false in
// every production build and only flipped by tests (AllowLoopbackHTTPForTest).
var allowLoopbackHTTP = false

// Descriptor is the storageSession object carried by a command payload.
type Descriptor struct {
	Version      int      `json:"version"`
	SessionID    string   `json:"sessionId"`
	Token        string   `json:"token"`
	BaseURL      string   `json:"baseUrl"`
	ExpiresAt    string   `json:"expiresAt"`
	Deadline     string   `json:"deadline"`
	Capabilities []string `json:"capabilities"`
	MaxBatch     int      `json:"maxBatch"`

	// Write sessions only.
	Scope             string `json:"scope,omitempty"`
	SnapshotID        string `json:"snapshotId,omitempty"`
	PartSizeBytes     int64  `json:"partSizeBytes,omitempty"`
	ConditionalWrites bool   `json:"conditionalWrites,omitempty"`

	baseURL   *url.URL
	expiresAt time.Time
	deadline  time.Time
}

// String never includes the token. Value receivers, so a pointer, a nil
// pointer and a copied value all format safely.
func (d Descriptor) String() string {
	return fmt.Sprintf("storageSession(version=%d scope=%s sessionId=%s snapshotId=%s baseUrl=%s expiresAt=%s deadline=%s)",
		d.Version, d.scopeName(), d.SessionID, d.SnapshotID, d.BaseURL, d.ExpiresAt, d.Deadline)
}

// GoString never includes the token.
func (d Descriptor) GoString() string { return d.String() }

// Format routes every fmt verb through String so %+v / %#v cannot print the
// token field.
func (d Descriptor) Format(f fmt.State, _ rune) { _, _ = f.Write([]byte(d.String())) }

func sessionErr(format string, args ...any) error {
	return fmt.Errorf("storage session: "+format, args...)
}

// isPresent reports whether a raw JSON field carries a value (not absent,
// not null).
func isPresent(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null"))
}

// ParsePayload extracts and validates the storageSession of a command
// payload (read or write scope; the caller checks which with ValidateFor). It returns (nil, nil) when the payload carries no session,
// so the caller keeps its legacy behaviour. When a session IS present every
// problem is an error — the caller must fail the command and must not fall
// back to any other storage source:
//   - storageSession and providerConfig are mutually exclusive;
//   - a provider label other than "s3" conflicts with brokered reads;
//   - the version must be exactly ProtocolVersion;
//   - every field must be well formed (see validate).
func ParsePayload(payload json.RawMessage, now time.Time) (*Descriptor, error) {
	if !isPresent(payload) {
		return nil, nil
	}
	var envelope struct {
		StorageSession json.RawMessage `json:"storageSession"`
		ProviderConfig json.RawMessage `json:"providerConfig"`
		Provider       json.RawMessage `json:"provider"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		// Only a payload that might carry a session is interesting here; a
		// malformed payload is reported by the command's own parser.
		if bytes.Contains(payload, []byte(`"storageSession"`)) {
			return nil, sessionErr("invalid command payload: %v", err)
		}
		return nil, nil
	}
	if !isPresent(envelope.StorageSession) {
		return nil, nil
	}
	if isPresent(envelope.ProviderConfig) {
		return nil, sessionErr("storageSession and providerConfig are mutually exclusive")
	}
	if isPresent(envelope.Provider) {
		var provider string
		if err := json.Unmarshal(envelope.Provider, &provider); err != nil || (provider != "" && provider != "s3") {
			return nil, sessionErr("storage sessions support only the s3 provider, payload names provider %s", strings.TrimSpace(string(envelope.Provider)))
		}
	}

	var raw struct {
		Version *int `json:"version"`
		Descriptor
	}
	dec := json.NewDecoder(bytes.NewReader(envelope.StorageSession))
	if err := dec.Decode(&raw); err != nil {
		return nil, sessionErr("storageSession is not a valid object")
	}
	if raw.Version == nil {
		return nil, sessionErr("storageSession version is missing")
	}
	d := raw.Descriptor
	d.Version = *raw.Version
	if err := d.validate(now); err != nil {
		return nil, err
	}
	return &d, nil
}

func (d *Descriptor) validate(now time.Time) error {
	if d.Version != ProtocolVersion {
		return sessionErr("unsupported storage session version %d (this helper supports version %d)", d.Version, ProtocolVersion)
	}
	if !sessionIDPattern.MatchString(d.SessionID) {
		return sessionErr("sessionId must be a UUID")
	}
	if !tokenPattern.MatchString(d.Token) {
		return sessionErr("token is missing or malformed")
	}
	base, err := parseBaseURL(d.BaseURL)
	if err != nil {
		return err
	}
	expiresAt, err := time.Parse(time.RFC3339, d.ExpiresAt)
	if err != nil {
		return sessionErr("expiresAt is not an RFC3339 timestamp")
	}
	deadline, err := time.Parse(time.RFC3339, d.Deadline)
	if err != nil {
		return sessionErr("deadline is not an RFC3339 timestamp")
	}
	if expiresAt.After(deadline) {
		return sessionErr("expiresAt is after the session deadline")
	}
	if !now.IsZero() && now.After(deadline.Add(deadlineSkewAllowance)) {
		return sessionErr("session deadline has passed")
	}
	if !hasCapability(d.Capabilities, CapabilityResolveBatch) {
		return sessionErr("session does not offer the %s capability", CapabilityResolveBatch)
	}
	if d.MaxBatch < 1 || d.MaxBatch > maxBatchLimit {
		return sessionErr("maxBatch %d is outside 1..%d", d.MaxBatch, maxBatchLimit)
	}
	switch d.Scope {
	case "":
		if d.SnapshotID != "" {
			return sessionErr("a read session must not name a snapshotId")
		}
	case ScopeSnapshotWrite:
		if !validSnapshotID(d.SnapshotID) {
			return sessionErr("write session snapshotId is missing or malformed")
		}
		for _, c := range []string{CapabilityPut, CapabilityMultipart, CapabilityList, CapabilityDelete, CapabilityResume} {
			if !hasCapability(d.Capabilities, c) {
				return sessionErr("write session does not offer the %s capability", c)
			}
		}
		if d.PartSizeBytes < minPartSizeBytes || d.PartSizeBytes > maxPartSizeBytes {
			return sessionErr("write session partSizeBytes %d is outside %d..%d", d.PartSizeBytes, int64(minPartSizeBytes), int64(maxPartSizeBytes))
		}
	default:
		return sessionErr("unsupported storage session scope %q", d.Scope)
	}
	d.baseURL = base
	d.expiresAt = expiresAt
	d.deadline = deadline
	return nil
}

// ValidateFor checks that the session's scope fits the command it was
// delivered with: a read command needs a read session, a backup (write)
// command a write session. Anything else fails closed.
func (d *Descriptor) ValidateFor(commandClass string) error {
	if d == nil {
		return sessionErr("descriptor is missing")
	}
	switch commandClass {
	case CommandClassRead:
		if d.Scope != "" {
			return sessionErr("a %s session cannot serve a read command", d.scopeName())
		}
	case CommandClassWrite:
		if d.Scope != ScopeSnapshotWrite {
			return sessionErr("a %s session cannot serve a backup write command", d.scopeName())
		}
	default:
		return sessionErr("unknown command class %q", commandClass)
	}
	return nil
}

func (d Descriptor) scopeName() string {
	if d.Scope == "" {
		return "snapshot_read"
	}
	return d.Scope
}

// validSnapshotID reports whether id is a single well-formed snapshot-id
// segment of the shared object-key contract (bmr.ParseObjectKey).
func validSnapshotID(id string) bool {
	if id == "" {
		return false
	}
	parsed, ok := bmr.ParseObjectKey("snapshots/" + id + "/manifest.json")
	return ok && parsed.SnapshotID == id
}

func hasCapability(caps []string, want string) bool {
	for _, c := range caps {
		if c == want {
			return true
		}
	}
	return false
}

// parseBaseURL accepts an https origin (optionally with a trailing "/") and
// nothing else: no credentials, path, query or fragment.
func parseBaseURL(raw string) (*url.URL, error) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || u.Opaque != "" {
		return nil, sessionErr("baseUrl must be an absolute https origin")
	}
	if !schemeAllowed(u) {
		return nil, sessionErr("baseUrl must use https")
	}
	if u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || strings.Contains(raw, "#") || (u.Path != "" && u.Path != "/") {
		return nil, sessionErr("baseUrl must be a bare origin")
	}
	return &url.URL{Scheme: u.Scheme, Host: strings.ToLower(u.Host)}, nil
}

// schemeAllowed: https always; http only for loopback hosts and only when
// the test-only switch is on.
func schemeAllowed(u *url.URL) bool {
	switch strings.ToLower(u.Scheme) {
	case "https":
		return true
	case "http":
		return allowLoopbackHTTP && isLoopbackHost(u.Hostname())
	default:
		return false
	}
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// originOf normalises a URL string to its origin for comparison.
func originOf(raw string) (string, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return "", false
	}
	return canonicalOrigin(u), true
}

// canonicalOrigin renders scheme://host[:port] with the scheme and host
// lower-cased and the scheme's default port (https 443, http 80) omitted, so
// "https://host" and "https://host:443" compare equal. Any other port is
// kept, and scheme and host must still match exactly.
func canonicalOrigin(u *url.URL) string {
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	port := u.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		return scheme + "://" + net.JoinHostPort(host, port)
	}
	if strings.Contains(host, ":") {
		return scheme + "://[" + host + "]"
	}
	return scheme + "://" + host
}
