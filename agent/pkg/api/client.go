package api

import (
	"bytes"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// ErrHTTPStatus is returned by the api client when an HTTP request
// completes but the server returned a non-success status code. Callers
// can type-assert via errors.As to classify the failure (auth, not
// found, rate limit, server error).
type ErrHTTPStatus struct {
	StatusCode int
	Body       string
}

func (e *ErrHTTPStatus) Error() string {
	return fmt.Sprintf("http %d: %s", e.StatusCode, e.Body)
}

type Client struct {
	baseURL    string
	authToken  string
	agentID    string
	httpClient *http.Client
}

type EnrollRequest struct {
	EnrollmentKey    string `json:"enrollmentKey"`
	EnrollmentSecret string `json:"enrollmentSecret,omitempty"`
	Hostname         string `json:"hostname"`
	OSType           string `json:"osType"`
	OSVersion        string `json:"osVersion"`
	Architecture     string `json:"architecture"`
	AgentVersion     string `json:"agentVersion,omitempty"`
	DeviceRole       string `json:"deviceRole,omitempty"`
	// IsVirtual / VirtualizationPlatform are the orthogonal "is this a VM and
	// on what hypervisor" attribute (issue #1387), derived by the agent from
	// the same hardware identity strings that drive DeviceRole. They are a
	// second policy-targeting axis, not a role.
	IsVirtual              bool          `json:"isVirtual,omitempty"`
	VirtualizationPlatform string        `json:"virtualizationPlatform,omitempty"`
	HardwareInfo           *HardwareInfo `json:"hardwareInfo,omitempty"`
}

type HardwareInfo struct {
	CPUModel                string `json:"cpuModel,omitempty"`
	CPUCores                int    `json:"cpuCores,omitempty"`
	CPUThreads              int    `json:"cpuThreads,omitempty"`
	RAMTotalMB              uint64 `json:"ramTotalMb,omitempty"`
	DiskTotalGB             uint64 `json:"diskTotalGb,omitempty"`
	GPUModel                string `json:"gpuModel,omitempty"`
	SerialNumber            string `json:"serialNumber,omitempty"`
	Manufacturer            string `json:"manufacturer,omitempty"`
	Model                   string `json:"model,omitempty"`
	MotherboardManufacturer string `json:"motherboardManufacturer,omitempty"`
	MotherboardProduct      string `json:"motherboardProduct,omitempty"`
	MotherboardVersion      string `json:"motherboardVersion,omitempty"`
	BIOSVersion             string `json:"biosVersion,omitempty"`
}

type MtlsCertData struct {
	Certificate  string `json:"certificate"`
	PrivateKey   string `json:"privateKey"`
	ExpiresAt    string `json:"expiresAt"`
	SerialNumber string `json:"serialNumber"`
}

type EnrollResponse struct {
	AgentID   string `json:"agentId"`
	AuthToken string `json:"authToken"`
	// DeviceID is the server's device row UUID (devices.id) — distinct from
	// AgentID (devices.agent_id). Wave 5 Task 5: the mTLS renewal recovery
	// proof (see RecoveryProof / mtls.BuildRenewalProofCanonicalBytes) is
	// canonicalized on this value, matching mtlsRenewalProof.ts server-side.
	// The enrollment route has always returned deviceId; this field lets the
	// agent finally capture and persist it (config.Config.DeviceID).
	DeviceID          string             `json:"deviceId,omitempty"`
	WatchdogAuthToken string             `json:"watchdogAuthToken"`
	HelperAuthToken   string             `json:"helperAuthToken"`
	OrgID             string             `json:"orgId"`
	SiteID            string             `json:"siteId"`
	BackupServerURL   string             `json:"backupServerUrl"`
	Config            AgentConfig        `json:"config"`
	Mtls              *MtlsCertData      `json:"mtls"`
	ManifestTrustKeys []ManifestTrustKey `json:"manifestTrustKeys,omitempty"`
	// Wave 6 Task 7. Present so the wire contract is complete and a device
	// enrolling mid-rotation is told about the pending key change on first
	// contact. Trust bootstrap itself still happens through
	// config.BootstrapPinnedManifestKeys; a delegation cannot bootstrap trust
	// (its old key ID would not be pinned yet), so these are adopted on the
	// first heartbeat after enrollment rather than during it.
	ManifestKeyDelegations []ManifestKeyDelegation `json:"manifestKeyDelegations,omitempty"`
}

// ManifestTrustKey is a per-deployment Ed25519 pubkey delivered at enrollment
// for self-host agent updates (#625). The agent pins these alongside the
// embedded LanternOps trust root.
type ManifestTrustKey struct {
	KeyID        string `json:"keyId"`
	PublicKeyB64 string `json:"publicKeyB64"`
	ValidFrom    string `json:"validFrom,omitempty"`
}

// ManifestKeyDelegation is a signed, monotonic, time-bounded authorisation to
// add ONE previously unseen manifest signing key to the agent's frozen trust
// set (Wave 6 Task 7). It is validated by config.ApplyManifestKeyDelegation,
// which verifies the signature against the currently-trusted key named by
// OldKeyID; nothing here is trusted on receipt.
type ManifestKeyDelegation struct {
	SchemaVersion   int    `json:"schemaVersion"`
	OldKeyID        string `json:"oldKeyId"`
	NewKeyID        string `json:"newKeyId"`
	NewPublicKeyB64 string `json:"newPublicKeyB64"`
	// Deliberately json.Number rather than uint64. A malformed epoch (a
	// negative, a fraction, an exponent) would make encoding/json fail the
	// WHOLE response decode if this were uint64 — costing the agent its
	// commands, upgrades and token rotation over a field it may not even
	// need. As json.Number the bad value is confined to this record, which
	// then fails closed in ParseEpoch.
	Epoch           json.Number `json:"epoch"`
	NotBefore       string      `json:"notBefore"`
	NotAfter        string      `json:"notAfter"`
	SignatureBase64 string      `json:"signatureBase64"`
}

// ParseEpoch converts the wire epoch to the unsigned integer the canonical
// signing payload uses. It accepts ONLY a plain non-negative decimal, matching
// the API's formatDelegationEpoch — "1e3" or "1.0" denote a value that could
// not have been signed in that spelling, so they fail closed.
func (d ManifestKeyDelegation) ParseEpoch() (uint64, error) {
	raw := d.Epoch.String()
	if raw == "" {
		return 0, fmt.Errorf("manifest key delegation epoch is missing")
	}
	epoch, err := strconv.ParseUint(raw, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("manifest key delegation epoch is not an unsigned decimal integer")
	}
	return epoch, nil
}

type RenewCertResponse struct {
	Mtls        *MtlsCertData `json:"mtls"`
	Quarantined bool          `json:"quarantined,omitempty"`
	Error       string        `json:"error,omitempty"`
}

// RecoveryProof is the expired-certificate recovery proof sent as
// recoveryProof on a v2 /renew-cert request, matching
// apps/api/src/services/mtlsRenewalProof.ts's RenewalProof shape exactly.
// SignatureBase64 is produced by mtls.SignRenewalProof over the canonical
// bytes built by mtls.BuildRenewalProofCanonicalBytes.
type RecoveryProof struct {
	ChallengeID     string `json:"challengeId"`
	ExpiresUnix     int64  `json:"expiresUnix"`
	SignatureBase64 string `json:"signatureBase64"`
}

// RenewCertV2Response is the reply to a protocolVersion-2 /renew-cert
// request. A CAPABLE server answers with the two-phase (pending +
// activation-window) shape: ProtocolVersion == 2 and CertificateID set. A
// LEGACY server (mid rolling-upgrade, running the pre-Task-4 route) answers
// with the old single-phase shape instead — no protocolVersion or
// certificateId, Mtls populated and already active. Callers MUST check
// IsLegacyResponse() before deciding whether to stage-and-confirm or
// promote immediately; decoding tolerantly handles both wire shapes with a
// single struct.
type RenewCertV2Response struct {
	ProtocolVersion     int           `json:"protocolVersion"`
	CertificateID       string        `json:"certificateId"`
	ActivationExpiresAt string        `json:"activationExpiresAt"`
	Mtls                *MtlsCertData `json:"mtls"`
	Quarantined         bool          `json:"quarantined,omitempty"`
	Error               string        `json:"error,omitempty"`
}

// IsLegacyResponse reports whether this response used the pre-Task-4
// single-phase shape (rolling-upgrade compatibility): no protocolVersion or
// certificateId came back even though the agent's request declared
// protocolVersion 2. In that case Mtls (if present) is already the server's
// final, active certificate — there is no pending row to confirm.
func (r *RenewCertV2Response) IsLegacyResponse() bool {
	return r.ProtocolVersion != 2 || r.CertificateID == ""
}

// RenewalChallengeResponse is the reply to POST /renew-cert/challenge.
type RenewalChallengeResponse struct {
	ChallengeID string `json:"challengeId"`
	ExpiresUnix int64  `json:"expiresUnix"`
	Error       string `json:"error,omitempty"`
}

// ConfirmCertRenewalResponse is the reply to POST /renew-cert/confirm.
type ConfirmCertRenewalResponse struct {
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	// AlreadyActive is set by the server when the confirmed certificate was
	// ALREADY this device's active identity — i.e. a previous confirm
	// succeeded and its response was lost in flight. The agent must still
	// promote the pending material in that case, not discard it.
	AlreadyActive bool `json:"alreadyActive,omitempty"`
}

// ConfirmConflictBody is the shape a two-phase-capable server returns with a
// 409 from /renew-cert/confirm. `State` is the certificate row's actual state,
// which tells the agent whether the material it is holding was already adopted
// by the server ("active") or is terminally dead ("revoked",
// "pending_revocation") and must be discarded. An older server sends no
// `state`, which the agent treats as the far more likely "already active"
// case — see heartbeat.confirmPendingMTLSCert.
type ConfirmConflictBody struct {
	Error string `json:"error,omitempty"`
	State string `json:"state,omitempty"`
}

type RotateTokenResponse struct {
	AuthToken         string `json:"authToken"`
	WatchdogAuthToken string `json:"watchdogAuthToken"`
	HelperAuthToken   string `json:"helperAuthToken"`
	RotatedAt         string `json:"rotatedAt"`
	// Issue #2621 — set by two-phase-capable servers. The credentials above are
	// STAGED: the server still treats the agent's previous set as current until
	// ConfirmTokenRotation succeeds. The agent must durably persist and read
	// back the new set BEFORE confirming.
	ConfirmationRequired bool   `json:"confirmationRequired"`
	PendingExpiresAt     string `json:"pendingExpiresAt"`
}

// ConfirmTokenRotationResponse is the reply to phase two of a rotation.
type ConfirmTokenRotationResponse struct {
	Confirmed      bool   `json:"confirmed"`
	AlreadyCurrent bool   `json:"alreadyCurrent"`
	ConfirmedAt    string `json:"confirmedAt"`
	Error          string `json:"error"`
	Code           string `json:"code"`
}

type AgentConfig struct {
	HeartbeatIntervalSeconds         int      `json:"heartbeatIntervalSeconds"`
	MetricsCollectionIntervalSeconds int      `json:"metricsCollectionIntervalSeconds"`
	EnabledCollectors                []string `json:"enabledCollectors,omitempty"`
}

// refuseUntrustedRedirect is the http.Client.CheckRedirect policy for the agent
// API client. Every request the client makes carries the device token — Enroll
// sends it as the custom x-agent-reenrollment-token header, the other calls send
// it as Authorization: Bearer. Go follows redirects by default and, while it
// drops Authorization/Cookie once a redirect leaves the original domain (it
// still trusts subdomains), it forwards arbitrary custom headers — so a
// compromised or MITM'd server could 30x a request to a host it controls and
// harvest the token.
//
// Merely stripping the headers is not enough: following the redirect would still
// hand the request body (during enroll: hostname, hardware serial, OS info) to
// the attacker and let it forge the response the agent parses and persists
// (e.g. authToken / mTLS cert). A legitimate Breeze server never redirects an
// agent to a different host, so refuse the redirect outright and surface it to
// the caller (which wraps the resulting error). Trusted redirects on the same
// endpoint — a different path, or an http->https upgrade — are still followed.
// An https->http downgrade is refused because it would expose the token over
// cleartext. See #1043.
func refuseUntrustedRedirect(req *http.Request, via []*http.Request) error {
	if len(via) == 0 {
		return nil
	}
	prev := via[len(via)-1]
	// The hostname is the trust boundary: the agent already trusts its
	// configured server, so a same-host redirect (different path or port, or
	// an http->https upgrade) is fine, but a redirect to any other host is not.
	// Compared case-insensitively since hostnames are.
	if !strings.EqualFold(req.URL.Hostname(), prev.URL.Hostname()) {
		return fmt.Errorf("refusing redirect from host %s to untrusted host %s during credentialed request", prev.URL.Hostname(), req.URL.Hostname())
	}
	if prev.URL.Scheme == "https" && req.URL.Scheme != "https" {
		return fmt.Errorf("refusing https->%s downgrade redirect to %s during credentialed request", req.URL.Scheme, req.URL.Hostname())
	}
	return nil
}

func NewClient(baseURL, authToken, agentID string) *Client {
	return &Client{
		baseURL:   baseURL,
		authToken: authToken,
		agentID:   agentID,
		httpClient: &http.Client{
			Timeout:       30 * time.Second,
			CheckRedirect: refuseUntrustedRedirect,
		},
	}
}

// NewClientWithTLS creates a client that presents a client certificate in TLS handshakes.
func NewClientWithTLS(baseURL, authToken, agentID string, tlsCfg *tls.Config) *Client {
	transport := &http.Transport{}
	if tlsCfg != nil {
		transport.TLSClientConfig = tlsCfg
	}
	return &Client{
		baseURL:   baseURL,
		authToken: authToken,
		agentID:   agentID,
		httpClient: &http.Client{
			Timeout:       30 * time.Second,
			Transport:     transport,
			CheckRedirect: refuseUntrustedRedirect,
		},
	}
}

func (c *Client) Enroll(req *EnrollRequest) (*EnrollResponse, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal enroll request: %w", err)
	}

	httpReq, err := http.NewRequest("POST", c.baseURL+"/api/v1/agents/enroll", bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create request: %w", err)
	}

	httpReq.Header.Set("Content-Type", "application/json")

	// On a forced re-enrollment the agent still holds its existing device
	// token (loaded from secrets.yaml into the client). Present it so the
	// server can match the existing device row and re-enroll it in place
	// rather than treating this as a brand-new device and 409-ing on the
	// hostname collision with the agent's own active row. The server reads
	// this header in the enrollment route's existing-device branch. Empty on
	// a fresh enroll (no stored token) -> header omitted, behaviour
	// unchanged. See #1028.
	if c.authToken != "" {
		httpReq.Header.Set("x-agent-reenrollment-token", c.authToken)
	}

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		bodyBytes, _ := io.ReadAll(resp.Body)
		return nil, &ErrHTTPStatus{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
	}

	var enrollResp EnrollResponse
	if err := json.NewDecoder(resp.Body).Decode(&enrollResp); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &enrollResp, nil
}

func (c *Client) SubmitCommandResult(commandID string, result interface{}) error {
	body, err := json.Marshal(result)
	if err != nil {
		return fmt.Errorf("failed to marshal result: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/%s/commands/%s/result", c.baseURL, c.agentID, commandID)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("failed to send request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("submit result failed with status %d", resp.StatusCode)
	}

	return nil
}

// RenewCert requests a new mTLS certificate from the server.
// This endpoint does not require mTLS itself (WAF-excluded), only bearer auth.
func (c *Client) RenewCert() (*RenewCertResponse, error) {
	url := fmt.Sprintf("%s/api/v1/agents/renew-cert", c.baseURL)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create renew-cert request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send renew-cert request: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read renew-cert response body: %w", err)
	}

	// Check status code before attempting to parse JSON
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusForbidden {
		return nil, fmt.Errorf("renew-cert failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var result RenewCertResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to decode renew-cert response (status %d): %w", resp.StatusCode, err)
	}

	if resp.StatusCode == http.StatusForbidden {
		return &result, nil // caller checks Quarantined or Error
	}

	return &result, nil
}

// RequestRenewalChallenge requests a short-lived (5-minute) recovery
// challenge for expired-certificate renewal (POST /renew-cert/challenge).
// The caller signs the returned challenge with the OLD certificate's private
// key (mtls.SignRenewalProof) to prove possession before it can renew
// without an active, unexpired mTLS handshake.
func (c *Client) RequestRenewalChallenge() (*RenewalChallengeResponse, error) {
	url := fmt.Sprintf("%s/api/v1/agents/renew-cert/challenge", c.baseURL)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create renew-cert/challenge request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send renew-cert/challenge request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read renew-cert/challenge response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, &ErrHTTPStatus{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
	}

	var result RenewalChallengeResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to decode renew-cert/challenge response: %w", err)
	}
	return &result, nil
}

// RenewCertV2 requests a certificate renewal using the two-phase
// (protocolVersion 2) protocol (security remediation Wave 5 Task 5). proof
// is nil for a routine renewal against a still-valid certificate, and
// populated (via RequestRenewalChallenge + mtls.SignRenewalProof) only when
// the active certificate has already expired.
//
// The response may come back in either wire shape — see
// RenewCertV2Response.IsLegacyResponse. This method itself does not decide
// what to do with the result; the caller (heartbeat's two-phase renewal
// driver) does.
func (c *Client) RenewCertV2(proof *RecoveryProof) (*RenewCertV2Response, error) {
	reqBody := map[string]any{"protocolVersion": 2}
	if proof != nil {
		reqBody["recoveryProof"] = proof
	}
	body, err := json.Marshal(reqBody)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal renew-cert request: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/renew-cert", c.baseURL)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create renew-cert request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send renew-cert request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read renew-cert response body: %w", err)
	}

	// Same tolerance as RenewCert: a 403 quarantine response is still decoded
	// so the caller can inspect Quarantined/Error, matching existing agent
	// behavior for the legacy endpoint.
	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusForbidden {
		return nil, fmt.Errorf("renew-cert failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var result RenewCertV2Response
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to decode renew-cert response (status %d): %w", resp.StatusCode, err)
	}
	return &result, nil
}

// ConfirmCertRenewal completes phase two of a two-phase mTLS renewal
// (POST /renew-cert/confirm). It MUST be called on a Client built with
// NewClientWithTLS presenting the PENDING certificate's material — the
// server authenticates the new identity via the edge's certificate
// assertion, not the request body. A non-2xx response is returned as an
// error and the caller must NOT promote the pending certificate in that
// case (see ErrHTTPStatus for status-code introspection).
func (c *Client) ConfirmCertRenewal(certificateID string) (*ConfirmCertRenewalResponse, error) {
	body, err := json.Marshal(map[string]any{
		"protocolVersion": 2,
		"certificateId":   certificateID,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to marshal renew-cert/confirm request: %w", err)
	}

	url := fmt.Sprintf("%s/api/v1/agents/renew-cert/confirm", c.baseURL)
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(body))
	if err != nil {
		return nil, fmt.Errorf("failed to create renew-cert/confirm request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send renew-cert/confirm request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read renew-cert/confirm response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		// Non-2xx: do not promote. The caller keeps the pending certificate on
		// disk (or discards it, for the terminal cases it recognizes) and
		// retains the OLD active certificate untouched either way.
		return nil, &ErrHTTPStatus{StatusCode: resp.StatusCode, Body: string(bodyBytes)}
	}

	var result ConfirmCertRenewalResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to decode renew-cert/confirm response: %w", err)
	}
	return &result, nil
}

func (c *Client) RotateToken() (*RotateTokenResponse, error) {
	url := fmt.Sprintf("%s/api/v1/agents/%s/rotate-token", c.baseURL, c.agentID)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create rotate-token request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send rotate-token request: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read rotate-token response body: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("rotate-token failed with status %d: %s", resp.StatusCode, string(bodyBytes))
	}

	var result RotateTokenResponse
	if err := json.Unmarshal(bodyBytes, &result); err != nil {
		return nil, fmt.Errorf("failed to decode rotate-token response: %w", err)
	}

	return &result, nil
}

// ErrPendingRotationExpired reports that the staged credential set died before
// the agent could confirm it. The caller must fall back to its durable
// credentials and start a fresh rotation.
var ErrPendingRotationExpired = errors.New("pending rotation expired")

// ErrRotationUnresolvable reports that the staged credential set is neither the
// server's staged credential nor its current one — a newer rotation, an admin
// token reset or a re-enrollment moved past it. Issue #2894: before the server
// signalled this the agent could not tell it from a transient conflict, so it
// re-confirmed on every heartbeat tick until the pending TTL expired.
//
// Like ErrPendingRotationExpired this is TERMINAL: the caller must discard the
// staged set instead of retrying.
var ErrRotationUnresolvable = errors.New("pending rotation can never be promoted")

// IsRotationTerminal reports whether a ConfirmTokenRotation error means the
// staged credential set is provably dead and must be discarded.
//
// The set is deliberately small and closed. A conflict the server marked
// retryable, an unknown code from a newer server, a 5xx and a transport failure
// all return false and therefore retry — discarding a staged set the server may
// still be authenticating the device with is unrecoverable (#2772/#2773), while
// retrying a dead one merely costs a request per tick until the TTL lapses.
func IsRotationTerminal(err error) bool {
	return errors.Is(err, ErrPendingRotationExpired) || errors.Is(err, ErrRotationUnresolvable)
}

// ConfirmTokenRotation completes phase two of a two-phase rotation. It MUST be
// called on a client built with the NEW (staged) agent token — the server treats
// possession of that token as the endpoint's proof that the credential was
// durably persisted, and only then promotes it to current.
func (c *Client) ConfirmTokenRotation() (*ConfirmTokenRotationResponse, error) {
	url := fmt.Sprintf("%s/api/v1/agents/%s/rotate-token/confirm", c.baseURL, c.agentID)
	req, err := http.NewRequest("POST", url, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create rotate-token confirm request: %w", err)
	}

	req.Header.Set("Authorization", "Bearer "+c.authToken)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("failed to send rotate-token confirm request: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("failed to read rotate-token confirm response body: %w", err)
	}

	var result ConfirmTokenRotationResponse

	if resp.StatusCode == http.StatusOK {
		// A 200 has to actually parse, and actually say confirmed. Ignoring the
		// decode error here would turn a captive portal or proxy answering 200
		// with HTML into a zero-valued result, and the caller's `return
		// resp.Confirmed` would then report failure with NO error and NO log
		// line — an invisible confirm loop running every tick until the pending
		// TTL lapses. That is the #2894 symptom reproduced on the success path.
		if err := json.Unmarshal(bodyBytes, &result); err != nil {
			return nil, fmt.Errorf("rotate-token confirm returned 200 with an undecodable body (%d bytes): %w", len(bodyBytes), err)
		}
		if !result.Confirmed {
			return nil, fmt.Errorf("rotate-token confirm returned 200 without confirming: %s", string(bodyBytes))
		}
		return &result, nil
	}

	// Best-effort decode on an error status: only `code` matters, and a body
	// that will not parse simply leaves it empty, which falls through to the
	// retryable generic error below.
	_ = json.Unmarshal(bodyBytes, &result)

	// Issue #2894 — only these two codes are terminal. Every other code
	// (including `rotation_conflict` and `pending_token_required`, which the
	// server emits while the staged token may still be live) falls through to
	// the generic error below and is retried.
	//
	// The sentinels are WRAPPED, never returned bare: discarding a credential set
	// is the one irreversible action in this flow, and the log line the caller
	// writes for it is the only forensic record. A bare sentinel would reduce it
	// to a constant string and throw away the status, the code and the server's
	// own explanation.
	switch result.Code {
	case "pending_rotation_expired":
		return nil, fmt.Errorf("rotate-token confirm rejected (status %d, code %q): %s: %w",
			resp.StatusCode, result.Code, result.Error, ErrPendingRotationExpired)
	case "rotation_unresolvable":
		return nil, fmt.Errorf("rotate-token confirm rejected (status %d, code %q): %s: %w",
			resp.StatusCode, result.Code, result.Error, ErrRotationUnresolvable)
	}
	// A 401 here means the server would not accept the STAGED token at all — it
	// expired, or it was revoked by an admin rotation or re-enrollment. Either
	// way it can never be promoted, so treat it as expired and stop retrying.
	// This is safe: the agent's current credentials are untouched by a failed
	// confirm.
	//
	// This inference has to stay, and it is deliberately the ONE terminal verdict
	// not driven by a code: an expired pending hash is rejected by agentAuth
	// BEFORE this route runs, so a 401 is the only signal the agent can ever
	// receive for the ordinary expiry case. Making it retryable would replace a
	// TTL-bounded loop with an unbounded one. The body is carried into the error
	// so an operator can tell an expiry from, say, a device suspension.
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("rotate-token confirm rejected with 401 (the staged token is not accepted at all): %s: %w",
			string(bodyBytes), ErrPendingRotationExpired)
	}
	return nil, fmt.Errorf("rotate-token confirm failed with status %d: %s", resp.StatusCode, string(bodyBytes))
}
