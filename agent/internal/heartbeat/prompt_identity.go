package heartbeat

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/breeze-rmm/agent/internal/promptidentity"
	"github.com/breeze-rmm/agent/internal/userhelper"
)

// MSP identity (#10190 W03, spec §3.6).
//
// Response: promptIdentity is decoded on its own (a malformed block is
// logged and ignored; the rest of the response still applies). It is
// applied first in processHeartbeatResponse: a scopeId change purges the
// prompt-list entries created under the old scope and replaces the identity
// before anything else from that heartbeat runs. When the announced logo
// differs from the stored one, its bytes are fetched over the agent's
// authenticated API channel, in the background; the last-known logo stays
// in force until the new one verifies.
//
// Request: securityCapabilities.promptIdentityProtocolVersion = 1 asks the
// server to send the block at all.

const (
	promptLogoFetchTimeout = 30 * time.Second
	// promptLogoRetryAfter spaces out retries of a logo that failed to fetch
	// or verify (the next heartbeat after it retries).
	promptLogoRetryAfter = 5 * time.Minute
)

type promptLogoFetchState struct {
	mu        sync.Mutex
	inflight  bool
	failedSha string
	failedAt  time.Time
	lastErr   string
}

// startPromptLogoFetch runs a logo fetch; tests make it synchronous.
var startPromptLogoFetch = func(f func()) { go f() }

// osUILocale is the machine's UI language as the agent process sees it
// (SYSTEM / root), probed once: the prompt host's fallback for a renderer
// that reported none.
var osUILocale = sync.OnceValue(userhelper.ProbeUILocale)

// initPromptIdentity opens the identity cache under dataDir.
func (h *Heartbeat) initPromptIdentity(dataDir string) {
	h.promptIdentity = promptidentity.Open(dataDir, promptidentity.Options{
		Fetch:         h.fetchPromptLogo,
		OnScopeChange: h.purgePromptScope,
	})
}

// purgePromptScope removes the prompt-list entries created under an MSP
// scope the device has left (org move, partner change, re-enrolment).
func (h *Heartbeat) purgePromptScope(old string) {
	if h.promptListStore == nil {
		return
	}
	n := h.promptListStore.PurgeScope(old)
	log.Info("MSP identity scope changed; purged prompt list entries of the old scope", "purged", n)
}

// applyPromptIdentity applies the response's promptIdentity block.
func (h *Heartbeat) applyPromptIdentity(resp *HeartbeatResponse) {
	if h.promptIdentity == nil || resp == nil {
		return
	}
	block, err := promptidentity.DecodeBlock(resp.PromptIdentity)
	if err == nil && block != nil {
		var changed bool
		changed, _, err = h.promptIdentity.Apply(block)
		if changed && h.promptHost != nil {
			h.promptHost.IdentityChanged()
		}
	}
	if err != nil {
		// The identity in force is kept (or, for a write failure, the new
		// one is in force in memory); nothing else in the response depends
		// on it.
		log.Warn("prompt identity block not applied", "error", err.Error())
	}
	h.maybeFetchPromptLogo()
}

// maybeFetchPromptLogo starts a logo download when the announced sha is not
// stored yet, at most one at a time, and not again within
// promptLogoRetryAfter of a failure for the same sha.
func (h *Heartbeat) maybeFetchPromptLogo() {
	sha, need := h.promptIdentity.NeedsLogo()
	if !need {
		return
	}
	st := &h.promptLogoState
	st.mu.Lock()
	if st.inflight || (st.failedSha == sha && time.Since(st.failedAt) < promptLogoRetryAfter) {
		st.mu.Unlock()
		return
	}
	st.inflight = true
	st.mu.Unlock()

	startPromptLogoFetch(func() {
		ctx, cancel := context.WithTimeout(context.Background(), promptLogoFetchTimeout)
		defer cancel()
		err := h.promptIdentity.FetchLogo(ctx, sha)
		st.mu.Lock()
		st.inflight = false
		if err != nil && !errors.Is(err, promptidentity.ErrStaleLogo) {
			st.failedSha, st.failedAt = sha, time.Now()
			if st.lastErr != err.Error() {
				st.lastErr = err.Error()
				log.Warn("MSP logo not fetched; keeping the last-known logo", "error", err.Error())
			}
		} else {
			st.failedSha, st.lastErr = "", ""
		}
		st.mu.Unlock()
		if err == nil && h.promptHost != nil {
			h.promptHost.IdentityChanged()
		}
	})
}

// fetchPromptLogo downloads the logo bytes for sha over the authenticated
// API channel (GET /api/v1/agents/:id/prompt-identity/logo?sha256=<hex>).
// Redirects are not followed and the body is capped one byte past the
// limit, so the store sees an oversized logo and refuses it.
func (h *Heartbeat) fetchPromptLogo(ctx context.Context, sha string) ([]byte, error) {
	if h.config == nil || h.config.AgentID == "" {
		return nil, errors.New("agent is not enrolled")
	}
	requestURL, err := h.pamTransportURL(fmt.Sprintf("/api/v1/agents/%s/prompt-identity/logo?sha256=%s",
		url.PathEscape(h.config.AgentID), url.QueryEscape(sha)))
	if err != nil {
		return nil, err
	}
	client, err := h.pamTransportHTTPClient()
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, requestURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", h.authHeader())
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("logo request returned HTTP %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, promptidentity.MaxLogoBytes+1))
}
