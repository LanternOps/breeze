package heartbeat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/breeze-rmm/agent/internal/httputil"
	"github.com/breeze-rmm/agent/internal/observability"
	"github.com/breeze-rmm/agent/internal/tpmattest"
)

// TPM EK collection (#8318 wave T1; spec 2026-10-12 §12.1). Off unless the
// server says otherwise: the API pushes configUpdate.tpm_attestation_enabled
// on every heartbeat (TPM_ATTESTATION_ENABLED, default false), and while it is
// off the agent touches no TPM at all. When on, it rides on the hardware send
// (startup, every 24 h, manual refresh): the report says whether a TPM 2.0
// answers (tpmAvailable), and a usable TPM is attested once per process and
// again after tpmReattestAfter. The server records the first EK as the
// device's baseline, or refreshes its time when the EK is the same, so the
// agent keeps no local state: a reinstall attests on its first start.
// A failed attempt is retried on the next hardware send.
//
// go-tpm's commands take no context, so every TPM use runs in its own
// goroutine under a deadline (withTPM). A TPM that hangs is abandoned: the
// caller moves on, and the one stuck goroutine keeps tpmBusy set, so no
// further TPM work starts (and no goroutines pile up) until it returns.
const (
	tpmReattestAfter   = 7 * 24 * time.Hour
	tpmAttestRespLimit = 64 * 1024
)

// Variables so tests can shorten them.
var (
	tpmAttestTimeout = 3 * time.Minute
	tpmProbeTimeout  = 15 * time.Second
)

var (
	errTPMBusy    = errors.New("an earlier TPM call has not returned")
	errTPMTimeout = errors.New("the TPM did not answer in time")
	errTPMPanic   = errors.New("the TPM call panicked")
)

// withTPM runs fn, which uses the TPM, under timeout. At most one runs at a
// time; while an earlier one is still out (even abandoned), it returns
// errTPMBusy without starting another.
func (h *Heartbeat) withTPM(timeout time.Duration, fn func() error) error {
	if !h.tpmBusy.CompareAndSwap(false, true) {
		return errTPMBusy
	}
	done := make(chan error, 1)
	go func() {
		err := errTPMPanic
		defer func() {
			h.tpmBusy.Store(false)
			done <- err
		}()
		defer observability.Recoverer("heartbeat.tpm")
		err = fn()
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		return errTPMTimeout
	}
}

// tpmAvailability probes the TPM for the hardware report: nil when the
// switch is off, or the probe could not tell in time (the key is then
// omitted and the server keeps its value).
func (h *Heartbeat) tpmAvailability() *bool {
	if !h.tpmEnabled.Load() {
		return nil
	}
	var available, known bool
	if err := h.withTPM(tpmProbeTimeout, func() error {
		available, known = tpmattest.Available(h.tpmOpen)
		return nil
	}); err != nil {
		log.Warn("TPM probe skipped", "error", err.Error())
		return nil
	}
	if !known {
		return nil
	}
	return &available
}

// attestationURL is the route an attempt starts with: the loop deferral is
// checked against it before any TPM work.
func (h *Heartbeat) attestationURL(action string) string {
	return fmt.Sprintf("%s/api/v1/agents/%s/attestation/%s", h.serverURL(), h.config.AgentID, action)
}

// maybeAttestTPM starts one attestation in the background when the switch is
// on, the TPM is usable, none succeeded in the last tpmReattestAfter and the
// server is not deferring the route.
func (h *Heartbeat) maybeAttestTPM(available *bool) {
	if !h.tpmEnabled.Load() || available == nil || !*available {
		return
	}
	if last := h.tpmAttestedAt.Load(); last != 0 && time.Since(time.Unix(last, 0)) < tpmReattestAfter {
		return
	}
	// No keys are created for a call the server would refuse to take now.
	if !h.loopReady("POST", h.attestationURL("challenge")) {
		return
	}
	if !h.tpmAttestInFlight.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer h.tpmAttestInFlight.Store(false)
		defer observability.Recoverer("heartbeat.tpmAttestation")
		ctx, cancel := context.WithTimeout(context.Background(), tpmAttestTimeout)
		defer cancel()
		err := h.withTPM(tpmAttestTimeout, func() error {
			return tpmattest.Attest(ctx, h.tpmOpen, tpmAttestationAPI{h: h})
		})
		switch {
		case err == nil:
			h.tpmAttestedAt.Store(time.Now().Unix())
			log.Info("TPM endorsement key attested")
		case errors.Is(err, tpmattest.ErrNoTPM):
			log.Debug("no usable TPM 2.0; skipping attestation")
		case errors.Is(err, ErrDeferred):
			log.Debug("TPM attestation deferred by the server")
		default:
			log.Warn("TPM attestation failed; retrying on the next hardware report", "error", err.Error())
		}
	}()
}

// applyTPMAttestationConfig applies the server-side switch
// (configUpdate.tpm_attestation_enabled). Turning it on starts an attempt
// right away rather than waiting up to 24 h for the next hardware send.
func (h *Heartbeat) applyTPMAttestationConfig(raw any) {
	var on bool
	switch v := raw.(type) {
	case bool:
		on = v
	case string:
		if v != "true" && v != "false" {
			log.Warn("ignoring unrecognized tpm_attestation_enabled config update payload")
			return
		}
		on = v == "true"
	default:
		log.Warn("ignoring non-boolean tpm_attestation_enabled config update payload")
		return
	}
	if was := h.tpmEnabled.Swap(on); on && !was {
		log.Info("TPM attestation enabled by control plane")
		go func() {
			defer observability.Recoverer("heartbeat.tpmEnable")
			h.maybeAttestTPM(h.tpmAvailability())
		}()
	} else if !on && was {
		log.Info("TPM attestation disabled by control plane")
	}
}

// tpmAttestationAPI is tpmattest.API over the agent's authenticated HTTP client.
type tpmAttestationAPI struct{ h *Heartbeat }

type tpmChallengeRequest struct {
	EKPublic []byte `json:"ekPublic"`
	AKPublic []byte `json:"akPublic"`
}

type tpmChallengeResponse struct {
	ChallengeID     string `json:"challengeId"`
	CredentialBlob  []byte `json:"credentialBlob"`
	EncryptedSecret []byte `json:"encryptedSecret"`
}

type tpmCompleteRequest struct {
	ChallengeID string `json:"challengeId"`
	Secret      []byte `json:"secret"`
}

func (a tpmAttestationAPI) postAttestation(ctx context.Context, action string, payload any) ([]byte, error) {
	h := a.h
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	url := h.attestationURL(action)
	if !h.loopReady("POST", url) {
		return nil, ErrDeferred
	}
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {h.authHeader()},
	}
	resp, err := httputil.Do(ctx, h.httpClient(), "POST", url, body, headers, h.retryCfg)
	if err != nil {
		h.noteLoopAnswer("POST", url, err)
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	data, err := io.ReadAll(io.LimitReader(resp.Body, tpmAttestRespLimit))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		// The API's refusals carry a code and a reason, never key material.
		var refusal struct {
			Code   string `json:"code"`
			Reason string `json:"reason"`
		}
		_ = json.Unmarshal(data, &refusal)
		return nil, fmt.Errorf("attestation %s: HTTP %d %s %s", action, resp.StatusCode, refusal.Code, refusal.Reason)
	}
	return data, nil
}

func (a tpmAttestationAPI) Challenge(ctx context.Context, ekPublic, akPublic []byte) (*tpmattest.Challenge, error) {
	data, err := a.postAttestation(ctx, "challenge", tpmChallengeRequest{EKPublic: ekPublic, AKPublic: akPublic})
	if err != nil {
		return nil, err
	}
	var rsp tpmChallengeResponse
	if err := json.NewDecoder(bytes.NewReader(data)).Decode(&rsp); err != nil {
		return nil, fmt.Errorf("attestation challenge: %w", err)
	}
	if rsp.ChallengeID == "" || len(rsp.CredentialBlob) == 0 || len(rsp.EncryptedSecret) == 0 {
		return nil, errors.New("attestation challenge: incomplete answer")
	}
	return &tpmattest.Challenge{ID: rsp.ChallengeID, CredentialBlob: rsp.CredentialBlob, EncryptedSecret: rsp.EncryptedSecret}, nil
}

func (a tpmAttestationAPI) Complete(ctx context.Context, challengeID string, secret []byte) error {
	_, err := a.postAttestation(ctx, "complete", tpmCompleteRequest{ChallengeID: challengeID, Secret: secret})
	return err
}
