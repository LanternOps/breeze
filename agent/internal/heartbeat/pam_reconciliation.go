package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/pamlifetime"
	"github.com/breeze-rmm/agent/internal/remote/tools"
)

const (
	pamReconciliationProtocolVersion = 1
	pamBindingChunkSize              = 100
	pamTransportTimeout              = 30 * time.Second
	pamTransportMaxResponseBytes     = 1 << 20

	pamBindingStatusBound      = "bound"
	pamBindingStatusDuplicate  = "duplicate"
	pamBindingStatusStale      = "stale"
	pamBindingStatusUnresolved = "unresolved"

	pamResultClassificationApplied   = "applied"
	pamResultClassificationDuplicate = "duplicate"
	pamResultClassificationStale     = "stale"
	pamResultClassificationRejected  = "rejected"
)

type pamBindingCandidate struct {
	ObservationID string `json:"observationId"`
	ActuationID   string `json:"actuationId"`
	Generation    uint64 `json:"generation"`
}

type pamBindingDisposition struct {
	Status        string `json:"status"`
	ObservationID string `json:"observationId"`
	CommandID     string `json:"commandId,omitempty"`
}

type pamResultAcknowledgement struct {
	ProtocolVersion int    `json:"protocolVersion"`
	Classification  string `json:"classification"`
}

type pamBindingRequest struct {
	ProtocolVersion int                   `json:"protocolVersion"`
	Candidates      []pamBindingCandidate `json:"candidates"`
}

type pamBindingResponse struct {
	ProtocolVersion int                     `json:"protocolVersion"`
	Dispositions    []pamBindingDisposition `json:"dispositions"`
}

func (h *Heartbeat) pamTransportHTTPClient() (*http.Client, error) {
	base := h.httpClient()
	if base == nil {
		return nil, errors.New("heartbeat HTTP client is unavailable")
	}
	client := *base
	client.CheckRedirect = func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}
	return &client, nil
}

func (h *Heartbeat) pamTransportURL(path string) (string, error) {
	if h == nil || h.config == nil {
		return "", errors.New("heartbeat configuration is unavailable")
	}
	base := strings.TrimRight(h.serverURL(), "/")
	if base == "" {
		return "", errors.New("server URL is unavailable")
	}
	return base + path, nil
}

func decodePamTransportResponse(body io.Reader, target any) error {
	raw, err := io.ReadAll(io.LimitReader(body, pamTransportMaxResponseBytes+1))
	if err != nil {
		return err
	}
	if len(raw) > pamTransportMaxResponseBytes {
		return fmt.Errorf("response exceeds %d bytes", pamTransportMaxResponseBytes)
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("response contains multiple JSON values")
		}
		return fmt.Errorf("decode trailing response data: %w", err)
	}
	return nil
}

func (h *Heartbeat) postPamJSON(ctx context.Context, requestURL string, payload any, response any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encode PAM reconciliation request: %w", err)
	}
	client, err := h.pamTransportHTTPClient()
	if err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, pamTransportTimeout)
	defer cancel()
	resp, err := httputil.Do(requestCtx, client, http.MethodPost, requestURL, body, http.Header{
		"Authorization": {h.authHeader()},
		"Content-Type":  {"application/json"},
	}, h.retryCfg)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("PAM reconciliation request failed with status %d", resp.StatusCode)
	}
	if err := decodePamTransportResponse(resp.Body, response); err != nil {
		return fmt.Errorf("decode PAM reconciliation response: %w", err)
	}
	return nil
}

func validatePamBindingCandidate(candidate pamBindingCandidate) error {
	if _, err := canonicalPamUUID(candidate.ObservationID); err != nil {
		return fmt.Errorf("invalid observation ID: %w", err)
	}
	if _, err := canonicalPamUUID(candidate.ActuationID); err != nil {
		return fmt.Errorf("invalid actuation ID: %w", err)
	}
	if candidate.Generation == 0 {
		return errors.New("generation must be positive")
	}
	return nil
}

func validatePamBindingDisposition(disposition pamBindingDisposition) error {
	if _, err := canonicalPamUUID(disposition.ObservationID); err != nil {
		return fmt.Errorf("invalid disposition observation ID: %w", err)
	}
	switch disposition.Status {
	case pamBindingStatusBound:
		if _, err := canonicalPamUUID(disposition.CommandID); err != nil {
			return fmt.Errorf("invalid bound command ID: %w", err)
		}
	case pamBindingStatusDuplicate, pamBindingStatusStale, pamBindingStatusUnresolved:
		if disposition.CommandID != "" {
			return fmt.Errorf("%s disposition returned an unexpected command ID", disposition.Status)
		}
	default:
		return fmt.Errorf("invalid binding status %q", disposition.Status)
	}
	return nil
}

func (h *Heartbeat) resolvePamBindings(ctx context.Context, candidates []pamBindingCandidate) ([]pamBindingDisposition, error) {
	if len(candidates) == 0 {
		return nil, nil
	}
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		if err := validatePamBindingCandidate(candidate); err != nil {
			return nil, err
		}
		if _, exists := seen[candidate.ObservationID]; exists {
			return nil, fmt.Errorf("duplicate candidate observation ID %q", candidate.ObservationID)
		}
		seen[candidate.ObservationID] = struct{}{}
	}

	requestURL, err := h.pamTransportURL(fmt.Sprintf(
		"/api/v1/agents/%s/pam/reconciliation-bindings",
		url.PathEscape(h.config.AgentID),
	))
	if err != nil {
		return nil, err
	}
	resolved := make([]pamBindingDisposition, 0, len(candidates))
	for start := 0; start < len(candidates); start += pamBindingChunkSize {
		end := min(start+pamBindingChunkSize, len(candidates))
		chunk := candidates[start:end]
		var response pamBindingResponse
		if err := h.postPamJSON(ctx, requestURL, pamBindingRequest{
			ProtocolVersion: pamReconciliationProtocolVersion,
			Candidates:      chunk,
		}, &response); err != nil {
			return nil, fmt.Errorf("resolve PAM reconciliation bindings: %w", err)
		}
		if response.ProtocolVersion != pamReconciliationProtocolVersion {
			return nil, fmt.Errorf("unsupported PAM binding protocol version %d", response.ProtocolVersion)
		}
		if len(response.Dispositions) != len(chunk) {
			return nil, fmt.Errorf("received %d PAM binding dispositions for %d candidates", len(response.Dispositions), len(chunk))
		}
		byObservation := make(map[string]pamBindingDisposition, len(response.Dispositions))
		for _, disposition := range response.Dispositions {
			if err := validatePamBindingDisposition(disposition); err != nil {
				return nil, err
			}
			if _, expected := seen[disposition.ObservationID]; !expected {
				return nil, fmt.Errorf("unexpected PAM binding disposition for observation %q", disposition.ObservationID)
			}
			if _, duplicate := byObservation[disposition.ObservationID]; duplicate {
				return nil, fmt.Errorf("duplicate PAM binding disposition for observation %q", disposition.ObservationID)
			}
			byObservation[disposition.ObservationID] = disposition
		}
		for _, candidate := range chunk {
			disposition, ok := byObservation[candidate.ObservationID]
			if !ok {
				return nil, fmt.Errorf("missing PAM binding disposition for observation %q", candidate.ObservationID)
			}
			resolved = append(resolved, disposition)
		}
	}
	return resolved, nil
}

func validPamResultClassification(classification string) bool {
	switch classification {
	case pamResultClassificationApplied,
		pamResultClassificationDuplicate,
		pamResultClassificationStale,
		pamResultClassificationRejected:
		return true
	default:
		return false
	}
}

func (h *Heartbeat) submitPamReconciliationResult(ctx context.Context, commandID string, result pamlifetime.Result) (pamResultAcknowledgement, error) {
	var acknowledgement pamResultAcknowledgement
	if _, err := canonicalPamUUID(commandID); err != nil {
		return acknowledgement, fmt.Errorf("invalid command ID: %w", err)
	}
	if _, err := canonicalPamUUID(result.ObservationID); err != nil {
		return acknowledgement, fmt.Errorf("invalid observation ID: %w", err)
	}
	requestURL, err := h.pamTransportURL(fmt.Sprintf(
		"/api/v1/agents/%s/commands/%s/result",
		url.PathEscape(h.config.AgentID),
		url.PathEscape(commandID),
	))
	if err != nil {
		return acknowledgement, err
	}
	envelope := tools.NewSuccessResult(result, 0)
	if envelope.Status != "completed" {
		return acknowledgement, errors.New("encode PAM reconciliation result envelope")
	}
	envelope.Result = result
	if err := h.postPamJSON(ctx, requestURL, envelope, &acknowledgement); err != nil {
		return pamResultAcknowledgement{}, fmt.Errorf("submit PAM reconciliation result: %w", err)
	}
	if acknowledgement.ProtocolVersion != pamReconciliationProtocolVersion {
		return pamResultAcknowledgement{}, fmt.Errorf("unsupported PAM result acknowledgement protocol version %d", acknowledgement.ProtocolVersion)
	}
	if !validPamResultClassification(acknowledgement.Classification) {
		return pamResultAcknowledgement{}, fmt.Errorf("invalid PAM result classification %q", acknowledgement.Classification)
	}
	return acknowledgement, nil
}

func (h *Heartbeat) setPamReconciliationManagerAvailable(available bool) {
	h.pamReconciliationMu.Lock()
	h.pamReconciliationManagerAvailable = available
	h.pamReconciliationMu.Unlock()
}

func (h *Heartbeat) ensurePamReconciliationMemory() {
	h.pamReconciliationMu.Lock()
	defer h.pamReconciliationMu.Unlock()
	if h.pamReconciliationStaged == nil {
		h.pamReconciliationStaged = make(map[string]pamlifetime.Result)
	}
	if h.pamReconciliationBlocked == nil {
		h.pamReconciliationBlocked = make(map[string]struct{})
	}
	if h.pamReconciliationWake == nil {
		h.pamReconciliationWake = make(chan struct{}, 1)
	}
}

func (h *Heartbeat) stagePamReconciliationResults(results []pamlifetime.Result) []pamlifetime.Result {
	h.ensurePamReconciliationMemory()
	staged := make([]pamlifetime.Result, len(results))
	copy(staged, results)
	identityFailures := 0
	h.pamReconciliationMu.Lock()
	defer h.pamReconciliationMu.Unlock()
	for i := range staged {
		observationID, err := pamlifetime.ReconciliationObservationID(staged[i])
		if err != nil {
			identityFailures++
			continue
		}
		staged[i].ObservationID = observationID
		h.pamReconciliationStaged[observationID] = staged[i]
	}
	h.pamReconciliationIdentityFailures = identityFailures
	return staged
}

func (h *Heartbeat) signalPamReconciliationWork() {
	h.ensurePamReconciliationMemory()
	h.pamReconciliationMu.Lock()
	wake := h.pamReconciliationWake
	h.pamReconciliationMu.Unlock()
	select {
	case wake <- struct{}{}:
	default:
	}
}

func (h *Heartbeat) pamBindingResolver() func(context.Context, []pamBindingCandidate) ([]pamBindingDisposition, error) {
	if h.pamResolveBindingsFn != nil {
		return h.pamResolveBindingsFn
	}
	return h.resolvePamBindings
}

func (h *Heartbeat) pamResultSubmitter() func(context.Context, string, pamlifetime.Result) (pamResultAcknowledgement, error) {
	if h.pamSubmitResultFn != nil {
		return h.pamSubmitResultFn
	}
	return h.submitPamReconciliationResult
}

func pamBindingCandidateForResult(result pamlifetime.Result) pamBindingCandidate {
	return pamBindingCandidate{
		ObservationID: result.ObservationID,
		ActuationID:   result.ActuationID,
		Generation:    result.Generation,
	}
}

func (h *Heartbeat) stagedPamReconciliationResults() []pamlifetime.Result {
	h.pamReconciliationMu.Lock()
	defer h.pamReconciliationMu.Unlock()
	results := make([]pamlifetime.Result, 0, len(h.pamReconciliationStaged))
	for _, result := range h.pamReconciliationStaged {
		results = append(results, result)
	}
	return results
}

func (h *Heartbeat) removeStagedPamReconciliationResult(observationID string) {
	h.pamReconciliationMu.Lock()
	delete(h.pamReconciliationStaged, observationID)
	h.pamReconciliationMu.Unlock()
}

func (h *Heartbeat) setPamReconciliationBlocked(observationID string, blocked bool) {
	h.ensurePamReconciliationMemory()
	h.pamReconciliationMu.Lock()
	defer h.pamReconciliationMu.Unlock()
	if blocked {
		h.pamReconciliationBlocked[observationID] = struct{}{}
	} else {
		delete(h.pamReconciliationBlocked, observationID)
	}
}

func (h *Heartbeat) resolveStagedPamReconciliation(ctx context.Context) {
	results := h.stagedPamReconciliationResults()
	if len(results) == 0 {
		return
	}
	candidates := make([]pamBindingCandidate, len(results))
	for i, result := range results {
		candidates[i] = pamBindingCandidateForResult(result)
	}
	dispositions, err := h.pamBindingResolver()(ctx, candidates)
	if err != nil {
		return
	}
	for i, disposition := range dispositions {
		result := results[i]
		switch disposition.Status {
		case pamBindingStatusBound:
			if h.pamReconciliationOutbox == nil {
				continue
			}
			if err := h.pamReconciliationOutbox.Enqueue(disposition.CommandID, result); err == nil {
				h.removeStagedPamReconciliationResult(result.ObservationID)
			}
		case pamBindingStatusDuplicate, pamBindingStatusStale:
			h.removeStagedPamReconciliationResult(result.ObservationID)
		case pamBindingStatusUnresolved:
		}
	}
}

func (h *Heartbeat) resolveQuarantinedPamReconciliation(ctx context.Context, entries []pamReconciliationOutboxEntry) {
	if len(entries) == 0 || h.pamReconciliationOutbox == nil {
		return
	}
	candidates := make([]pamBindingCandidate, len(entries))
	for i, entry := range entries {
		candidates[i] = pamBindingCandidateForResult(entry.Observation)
	}
	dispositions, err := h.pamBindingResolver()(ctx, candidates)
	if err != nil {
		return
	}
	for i, disposition := range dispositions {
		if disposition.Status != pamBindingStatusDuplicate && disposition.Status != pamBindingStatusStale {
			continue
		}
		entry := entries[i]
		_ = h.pamReconciliationOutbox.Remove(pamReconciliationStateQuarantined, entry.CommandID, entry.Observation.ObservationID)
	}
}

func (h *Heartbeat) reresolveRejectedPamEntry(ctx context.Context, entry pamReconciliationOutboxEntry, retryRebound bool) {
	h.setPamReconciliationBlocked(entry.Observation.ObservationID, true)
	dispositions, err := h.pamBindingResolver()(ctx, []pamBindingCandidate{pamBindingCandidateForResult(entry.Observation)})
	if err != nil || len(dispositions) != 1 || h.pamReconciliationOutbox == nil {
		return
	}
	disposition := dispositions[0]
	switch disposition.Status {
	case pamBindingStatusDuplicate, pamBindingStatusStale:
		if err := h.pamReconciliationOutbox.Remove(pamReconciliationStatePending, entry.CommandID, entry.Observation.ObservationID); err == nil {
			h.setPamReconciliationBlocked(entry.Observation.ObservationID, false)
		}
	case pamBindingStatusUnresolved:
		return
	case pamBindingStatusBound:
		if disposition.CommandID == entry.CommandID {
			if err := h.pamReconciliationOutbox.Quarantine(entry.CommandID, entry.Observation.ObservationID, "same_command_rejected"); err == nil {
				h.setPamReconciliationBlocked(entry.Observation.ObservationID, false)
			}
			return
		}
		if err := h.pamReconciliationOutbox.Rebind(entry.CommandID, entry.Observation.ObservationID, disposition.CommandID); err != nil {
			return
		}
		h.setPamReconciliationBlocked(entry.Observation.ObservationID, false)
		if retryRebound {
			entry.CommandID = disposition.CommandID
			h.submitPendingPamReconciliation(ctx, entry, false)
		}
	}
}

func (h *Heartbeat) submitPendingPamReconciliation(ctx context.Context, entry pamReconciliationOutboxEntry, retryRebound bool) {
	acknowledgement, err := h.pamResultSubmitter()(ctx, entry.CommandID, entry.Observation)
	if err != nil || h.pamReconciliationOutbox == nil {
		return
	}
	switch acknowledgement.Classification {
	case pamResultClassificationApplied, pamResultClassificationDuplicate, pamResultClassificationStale:
		if err := h.pamReconciliationOutbox.Remove(pamReconciliationStatePending, entry.CommandID, entry.Observation.ObservationID); err == nil {
			h.setPamReconciliationBlocked(entry.Observation.ObservationID, false)
		}
	case pamResultClassificationRejected:
		h.reresolveRejectedPamEntry(ctx, entry, retryRebound)
	}
}

func (h *Heartbeat) recomputePamReconciliationReadiness() {
	if h == nil {
		return
	}
	h.ensurePamReconciliationMemory()
	h.pamReconciliationMu.Lock()
	managerAvailable := h.pamReconciliationManagerAvailable
	stagedCount := len(h.pamReconciliationStaged)
	blockedCount := len(h.pamReconciliationBlocked)
	identityFailures := h.pamReconciliationIdentityFailures
	h.pamReconciliationMu.Unlock()
	if h.pamLocalReconcileRunning.Load() || !managerAvailable || stagedCount != 0 || blockedCount != 0 || identityFailures != 0 {
		h.pamReconciled.Store(false)
		return
	}
	if h.pamReconciliationOutbox == nil {
		h.pamReconciled.Store(true)
		return
	}
	snapshot, err := h.pamReconciliationOutbox.Snapshot()
	h.pamReconciled.Store(err == nil && len(snapshot.Quarantined) == 0)
}

func (h *Heartbeat) reconcilePamEvidence(ctx context.Context) {
	if h == nil || !h.pamReconciliationPassRunning.CompareAndSwap(false, true) {
		return
	}
	defer h.pamReconciliationPassRunning.Store(false)

	h.resolveStagedPamReconciliation(ctx)
	if h.pamReconciliationOutbox == nil {
		h.recomputePamReconciliationReadiness()
		return
	}
	snapshot, err := h.pamReconciliationOutbox.Snapshot()
	if err != nil {
		h.pamReconciled.Store(false)
		return
	}
	h.resolveQuarantinedPamReconciliation(ctx, snapshot.Quarantined)
	for _, entry := range snapshot.Pending {
		h.submitPendingPamReconciliation(ctx, entry, true)
	}
	h.recomputePamReconciliationReadiness()
}

func (h *Heartbeat) pamReconciliationRetryCap() time.Duration {
	if h != nil && h.config != nil && h.config.HeartbeatIntervalSeconds > 0 {
		return time.Duration(h.config.HeartbeatIntervalSeconds) * time.Second
	}
	return 30 * time.Second
}

func (h *Heartbeat) startPamReconciliationRetryLoop() {
	if h == nil {
		return
	}
	h.ensurePamReconciliationMemory()
	h.pamReconciliationRetryOnce.Do(func() {
		go func() {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			go func() {
				select {
				case <-h.stopChan:
					cancel()
				case <-ctx.Done():
				}
			}()
			delay := time.Second
			h.pamReconciliationMu.Lock()
			wake := h.pamReconciliationWake
			h.pamReconciliationMu.Unlock()
			select {
			case <-wake:
			default:
			}
			for {
				h.reconcilePamEvidence(ctx)
				if ctx.Err() != nil {
					return
				}
				capDelay := h.pamReconciliationRetryCap()
				if delay > capDelay {
					delay = capDelay
				}
				timer := time.NewTimer(delay)
				select {
				case <-h.stopChan:
					if !timer.Stop() {
						select {
						case <-timer.C:
						default:
						}
					}
					return
				case <-wake:
					if !timer.Stop() {
						select {
						case <-timer.C:
						default:
						}
					}
					delay = time.Second
				case <-timer.C:
					if delay < capDelay {
						delay = min(delay*2, capDelay)
					}
				}
			}
		}()
	})
}
