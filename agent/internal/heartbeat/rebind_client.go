package heartbeat

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/mtls"
)

// The two rebind routes (#8318 §6.3, §6.4) and the probe heartbeat as the
// target (§6.6). One attempt per call: the flow (rebind_flow.go) owns retries
// and backoff. No error or log line here ever carries a token.

const (
	rebindCallTimeout  = 30 * time.Second
	rebindMaxBodyBytes = 1 << 20
)

// rebindRefusal is every refusal body: { error, code, state?, cancelReason? }.
// Details is set only on the API's own request validation 400 (zod).
type rebindRefusal struct {
	Error        string          `json:"error"`
	Code         string          `json:"code"`
	State        string          `json:"state"`
	CancelReason *string         `json:"cancelReason"`
	Details      json.RawMessage `json:"details"`
}

// setRefused reports a 400 the API itself gave because of the set or the
// body (invalid_staged_set, or its request validation). Both are decided
// before anything is staged and are deterministic for the same body, so
// this set was never staged and a fresh one may replace it. Any other 400
// (a proxy, a WAF) proves nothing of the kind.
func (r rebindRefusal) setRefused(status int) bool {
	return status == http.StatusBadRequest && (r.Code == "invalid_staged_set" || len(r.Details) > 0)
}

// intentOver reports a refusal that ends the intent (§6.6 rule): 409 with
// state cancelled or expired.
func (r rebindRefusal) intentOver(status int) bool {
	return status == http.StatusConflict && (r.State == "cancelled" || r.State == "expired")
}

// rebindAnswer is one call's outcome. status 0 means no HTTP answer.
type rebindAnswer struct {
	status     int
	refusal    rebindRefusal
	retryAfter time.Duration
	body       []byte
	err        error
}

func (a rebindAnswer) String() string {
	if a.status == 0 {
		if a.err != nil {
			return "no answer: " + a.err.Error()
		}
		return "no answer"
	}
	if a.refusal.Code != "" {
		return fmt.Sprintf("HTTP %d %s", a.status, a.refusal.Code)
	}
	return fmt.Sprintf("HTTP %d", a.status)
}

type rebindStageRequest struct {
	IntentID                string `json:"intentId"`
	StagedTokenHash         string `json:"stagedTokenHash"`
	StagedWatchdogTokenHash string `json:"stagedWatchdogTokenHash"`
	StagedHelperTokenHash   string `json:"stagedHelperTokenHash"`
	ConfirmationTokenHash   string `json:"confirmationTokenHash"`
}

type rebindStageResponse struct {
	IntentID      string                    `json:"intentId"`
	StagedAgentID string                    `json:"stagedAgentId"`
	Target        *config.RebindTarget      `json:"target"`
	Certificate   *config.RebindCertificate `json:"certificate"`
	ExpiresAt     string                    `json:"expiresAt"`
}

// rebindHash is the wire form of every staged secret: lowercase hex SHA-256
// of the whole token string, prefix included.
func rebindHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func rebindStageBody(s *config.RebindStagedSet) rebindStageRequest {
	return rebindStageRequest{
		IntentID:                s.IntentID,
		StagedTokenHash:         rebindHash(s.AuthToken),
		StagedWatchdogTokenHash: rebindHash(s.WatchdogAuthToken),
		StagedHelperTokenHash:   rebindHash(s.HelperAuthToken),
		ConfirmationTokenHash:   rebindHash(s.ConfirmationToken),
	}
}

// newRebindHTTPClient builds the client that presents the target's staged
// certificate (nil = none). A seam for tests.
var newRebindHTTPClient = func(tlsCfg *tls.Config) *http.Client {
	return newHeartbeatHTTPClient(tlsCfg)
}

// rebindTargetClient is the client for calls that must present the target's
// staged certificate: confirm (valid before and after the commit, §5) and the
// probe as the target. Without a staged certificate it is the source's own
// client (the server had no mTLS provider at phase 1).
//
// One client per staged certificate, kept across confirm and probe retries
// (so their connections are reused) and rebuilt when phase 1 hands a fresh
// certificate; closeRebindClient drops it when the flow ends.
func (h *Heartbeat) rebindTargetClient(s *config.RebindStagedSet) (*http.Client, error) {
	if s.Certificate == nil {
		return h.httpClient(), nil
	}
	key := rebindHash(s.Certificate.Certificate + "\n" + s.Certificate.PrivateKey)
	h.rebind.clientMu.Lock()
	defer h.rebind.clientMu.Unlock()
	if h.rebind.client != nil && h.rebind.clientKey == key {
		return h.rebind.client, nil
	}
	tlsCfg, err := mtls.BuildTLSConfig(s.Certificate.Certificate, s.Certificate.PrivateKey)
	if err != nil {
		return nil, fmt.Errorf("staged certificate: %w", err)
	}
	if h.rebind.client != nil {
		h.rebind.client.CloseIdleConnections()
	}
	h.rebind.client, h.rebind.clientKey = newRebindHTTPClient(tlsCfg), key
	return h.rebind.client, nil
}

// closeRebindClient closes the staged certificate's idle connections and
// drops its client: the flow has ended (swapped, over, or discarded).
func (h *Heartbeat) closeRebindClient() {
	h.rebind.clientMu.Lock()
	defer h.rebind.clientMu.Unlock()
	if h.rebind.client != nil {
		h.rebind.client.CloseIdleConnections()
	}
	h.rebind.client, h.rebind.clientKey = nil, ""
}

// rebindRequest makes one call. body nil: no request body (a GET).
func rebindRequest(client *http.Client, method, endpoint, bearer string, body any) rebindAnswer {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return rebindAnswer{err: fmt.Errorf("encoding request: %w", err)}
		}
		payload = bytes.NewReader(raw)
	}
	ctx, cancel := context.WithTimeout(context.Background(), rebindCallTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, endpoint, payload)
	if err != nil {
		return rebindAnswer{err: fmt.Errorf("building request: %w", err)}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", bearer)
	resp, err := client.Do(req)
	if err != nil {
		// url.Error carries the URL (agent ids only), never headers.
		return rebindAnswer{err: err}
	}
	defer func() { _ = resp.Body.Close() }()
	raw, readErr := io.ReadAll(io.LimitReader(resp.Body, rebindMaxBodyBytes))
	ans := rebindAnswer{status: resp.StatusCode}
	if resp.StatusCode == http.StatusOK {
		if readErr != nil {
			// A 200 whose body was lost is a lost response: retry.
			return rebindAnswer{err: fmt.Errorf("reading a 200 answer: %w", readErr)}
		}
		ans.body = raw
		return ans
	}
	_ = json.Unmarshal(raw, &ans.refusal)
	if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode == http.StatusServiceUnavailable {
		ans.retryAfter = httputil.ParseRetryAfter(resp.Header, time.Now())
	}
	return ans
}

func rebindRouteURL(base, agentID, action string) string {
	return fmt.Sprintf("%s/api/v1/agents/%s/%s", base, url.PathEscape(agentID), action)
}

// postRebindStage sends phase 1 with the SOURCE's credentials and its active
// client certificate (the heartbeat client).
func (h *Heartbeat) postRebindStage(s *config.RebindStagedSet) rebindAnswer {
	return rebindRequest(h.httpClient(), http.MethodPost, rebindRouteURL(h.serverURL(), s.SourceAgentID, "rebind"), h.authHeader(), rebindStageBody(s))
}

// postRebindConfirm sends confirm with the confirm-only token.
func (h *Heartbeat) postRebindConfirm(s *config.RebindStagedSet) rebindAnswer {
	client, err := h.rebindTargetClient(s)
	if err != nil {
		return rebindAnswer{err: err}
	}
	return rebindRequest(client, http.MethodPost, rebindRouteURL(h.serverURL(), s.SourceAgentID, "rebind-confirm"),
		"Bearer "+s.ConfirmationToken, struct{}{})
}

// postRebindProbe authenticates as the TARGET with the staged set (§6.6): a
// 2xx proves a confirm committed (the staged hashes are never a device's
// credentials before it). It is `GET /agents/:stagedAgentId/config`, which
// agent auth guards like every agent route (credentials, status, mTLS
// binding) and whose handler only reads: unlike a heartbeat, it claims none
// of the target's commands, and its answer is dropped before the restart.
func (h *Heartbeat) postRebindProbe(s *config.RebindStagedSet) rebindAnswer {
	if s.StagedAgentID == "" {
		return rebindAnswer{err: errors.New("no staged agent id to probe")}
	}
	client, err := h.rebindTargetClient(s)
	if err != nil {
		return rebindAnswer{err: err}
	}
	return rebindRequest(client, http.MethodGet, rebindRouteURL(h.serverURL(), s.StagedAgentID, "config"), "Bearer "+s.AuthToken, nil)
}
