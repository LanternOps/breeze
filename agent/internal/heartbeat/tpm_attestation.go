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

// TPM EK collection (#8318 wave T1; spec 2026-10-12 §12.1). It rides on the
// hardware send (startup, every 24 h, manual refresh): the report says
// whether a TPM 2.0 answers (tpmAvailable), and a usable TPM is attested once
// per process and again after tpmReattestAfter. The server records the EK as
// the device's baseline, or refreshes its time when the EK is the same, so
// the agent keeps no local state: a reinstall attests on its first start.
// A failed attempt is retried on the next hardware send.
const (
	tpmReattestAfter   = 7 * 24 * time.Hour
	tpmAttestTimeout   = 3 * time.Minute
	tpmAttestRespLimit = 64 * 1024
)

// tpmAvailability probes the TPM for the hardware report: nil when the probe
// could not tell (the key is then omitted and the server keeps its value).
func (h *Heartbeat) tpmAvailability() *bool {
	available, known := tpmattest.Available(h.tpmOpen)
	if !known {
		return nil
	}
	return &available
}

// maybeAttestTPM starts one attestation in the background when the TPM is
// usable and none succeeded in the last tpmReattestAfter.
func (h *Heartbeat) maybeAttestTPM(available *bool) {
	if available == nil || !*available {
		return
	}
	if last := h.tpmAttestedAt.Load(); last != 0 && time.Since(time.Unix(last, 0)) < tpmReattestAfter {
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
		if err := tpmattest.Attest(ctx, h.tpmOpen, tpmAttestationAPI{h: h}); err != nil {
			if errors.Is(err, tpmattest.ErrNoTPM) {
				log.Debug("no usable TPM 2.0; skipping attestation")
				return
			}
			log.Warn("TPM attestation failed; retrying on the next hardware report", "error", err.Error())
			return
		}
		h.tpmAttestedAt.Store(time.Now().Unix())
		log.Info("TPM endorsement key attested")
	}()
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

func (a tpmAttestationAPI) post(ctx context.Context, action string, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	url := fmt.Sprintf("%s/api/v1/agents/%s/attestation/%s", a.h.serverURL(), a.h.config.AgentID, action)
	if !a.h.loopReady("POST", url) {
		return nil, ErrDeferred
	}
	headers := http.Header{
		"Content-Type":  {"application/json"},
		"Authorization": {a.h.authHeader()},
	}
	resp, err := httputil.Do(ctx, a.h.httpClient(), "POST", url, body, headers, a.h.retryCfg)
	if err != nil {
		a.h.noteLoopAnswer("POST", url, err)
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
	data, err := a.post(ctx, "challenge", tpmChallengeRequest{EKPublic: ekPublic, AKPublic: akPublic})
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
	_, err := a.post(ctx, "complete", tpmCompleteRequest{ChallengeID: challengeID, Secret: secret})
	return err
}
