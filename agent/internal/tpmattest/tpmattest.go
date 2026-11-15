// Package tpmattest proves to the Breeze API that this machine holds a TPM's
// endorsement key, so the API can record the EK as the device's baseline
// before anyone reformats the machine (#8318 wave T1; spec
// docs/superpowers/specs/installer-enrollment/2026-10-12-reinstall-reattach-design.md
// §12.1). A later reinstall that proves the same EK can be reattached to the
// same device row with stronger evidence than hardware hints (wave T2).
//
// The flow, one TPM session per attempt:
//
//  1. CreatePrimary the EK (TCG RSA-2048 default template) and a restricted
//     RSA signing AK, both in the endorsement hierarchy.
//  2. Send both public areas to POST /agents/:id/attestation/challenge. The
//     server answers a credential blob made with MakeCredential(EK, AK name).
//  3. TPM2_ActivateCredential: only the TPM holding that EK, with that AK
//     loaded, recovers the secret.
//  4. Send the secret to POST /agents/:id/attestation/complete.
//
// TOFU on the EK: this proves the same key, not the same physical TPM. It does
// not deliver non-exportable agent keys (#7433). Nothing here is logged beyond
// the outcome: no secret, blob or key.
package tpmattest

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/go-tpm/tpm2"
	"github.com/google/go-tpm/tpm2/transport"
)

// ErrNoTPM means there is no TPM 2.0 to use: none present, TPM 1.2 only, or
// TBS unavailable. The agent then reports tpmAvailable=false and moves on.
var ErrNoTPM = errors.New("no usable TPM 2.0")

// Opener opens the platform's TPM 2.0 (openPlatformTPM by default).
type Opener func() (transport.TPMCloser, error)

// Challenge is the API's answer to the two public areas: the buffers of
// TPM2B_ID_OBJECT and TPM2B_ENCRYPTED_SECRET, without their size.
type Challenge struct {
	ID              string
	CredentialBlob  []byte
	EncryptedSecret []byte
}

// API is the server half of the flow (the agent's HTTP client in production).
type API interface {
	Challenge(ctx context.Context, ekPublic, akPublic []byte) (*Challenge, error)
	Complete(ctx context.Context, challengeID string, secret []byte) error
}

// AKTemplate is the attestation key: a restricted RSA-2048 signing key that
// never leaves its TPM. The API checks restricted, sign, fixedTPM,
// fixedParent and sensitiveDataOrigin, and refuses decrypt.
var AKTemplate = tpm2.TPMTPublic{
	Type:    tpm2.TPMAlgRSA,
	NameAlg: tpm2.TPMAlgSHA256,
	ObjectAttributes: tpm2.TPMAObject{
		FixedTPM:            true,
		FixedParent:         true,
		SensitiveDataOrigin: true,
		UserWithAuth:        true,
		NoDA:                true,
		Restricted:          true,
		SignEncrypt:         true,
	},
	Parameters: tpm2.NewTPMUPublicParms(tpm2.TPMAlgRSA, &tpm2.TPMSRSAParms{
		Scheme: tpm2.TPMTRSAScheme{
			Scheme:  tpm2.TPMAlgRSASSA,
			Details: tpm2.NewTPMUAsymScheme(tpm2.TPMAlgRSASSA, &tpm2.TPMSSigSchemeRSASSA{HashAlg: tpm2.TPMAlgSHA256}),
		},
		KeyBits: 2048,
	}),
	Unique: tpm2.NewTPMUPublicID(tpm2.TPMAlgRSA, &tpm2.TPM2BPublicKeyRSA{Buffer: make([]byte, 256)}),
}

type primary struct {
	handle tpm2.TPMHandle
	name   tpm2.TPM2BName
	public []byte // marshalled TPMT_PUBLIC
}

func createPrimary(t transport.TPM, template tpm2.TPMTPublic) (*primary, error) {
	rsp, err := tpm2.CreatePrimary{
		PrimaryHandle: tpm2.TPMRHEndorsement,
		InPublic:      tpm2.New2B(template),
	}.Execute(t)
	if err != nil {
		return nil, err
	}
	pub, err := rsp.OutPublic.Contents()
	if err != nil {
		flush(t, rsp.ObjectHandle)
		return nil, fmt.Errorf("reading the public area: %w", err)
	}
	return &primary{handle: rsp.ObjectHandle, name: rsp.Name, public: tpm2.Marshal(pub)}, nil
}

func flush(t transport.TPM, h tpm2.TPMHandle) {
	_, _ = tpm2.FlushContext{FlushHandle: h}.Execute(t)
}

// ekPolicy satisfies the default EK's authPolicy, PolicySecret(TPM_RH_ENDORSEMENT).
func ekPolicy(t transport.TPM, handle tpm2.TPMISHPolicy, nonceTPM tpm2.TPM2BNonce) error {
	_, err := tpm2.PolicySecret{
		AuthHandle:    tpm2.TPMRHEndorsement,
		PolicySession: handle,
		NonceTPM:      nonceTPM,
	}.Execute(t)
	return err
}

// Attest runs one attempt of the flow against the TPM `open` returns. It
// returns ErrNoTPM when there is no TPM 2.0 to use.
func Attest(ctx context.Context, open Opener, api API) error {
	if open == nil {
		open = openPlatformTPM
	}
	t, err := open()
	if err != nil {
		return err
	}
	defer t.Close()

	ek, err := createPrimary(t, tpm2.RSAEKTemplate)
	if err != nil {
		return fmt.Errorf("creating the EK: %w", err)
	}
	defer flush(t, ek.handle)
	ak, err := createPrimary(t, AKTemplate)
	if err != nil {
		return fmt.Errorf("creating the AK: %w", err)
	}
	defer flush(t, ak.handle)

	challenge, err := api.Challenge(ctx, ek.public, ak.public)
	if err != nil {
		return fmt.Errorf("asking for a challenge: %w", err)
	}
	rsp, err := tpm2.ActivateCredential{
		ActivateHandle: tpm2.NamedHandle{Handle: ak.handle, Name: ak.name},
		KeyHandle: tpm2.AuthHandle{
			Handle: ek.handle,
			Name:   ek.name,
			Auth:   tpm2.Policy(tpm2.TPMAlgSHA256, 16, ekPolicy),
		},
		CredentialBlob: tpm2.TPM2BIDObject{Buffer: challenge.CredentialBlob},
		Secret:         tpm2.TPM2BEncryptedSecret{Buffer: challenge.EncryptedSecret},
	}.Execute(t)
	if err != nil {
		return fmt.Errorf("activating the credential: %w", err)
	}
	if err := api.Complete(ctx, challenge.ID, rsp.CertInfo.Buffer); err != nil {
		return fmt.Errorf("completing the attestation: %w", err)
	}
	return nil
}

// Available reports whether a TPM 2.0 answers here, and whether the answer is
// known: ok=false when the probe failed for another reason (a permission
// error, a busy TBS), so the agent reports nothing rather than a wrong false.
func Available(open Opener) (available bool, ok bool) {
	if open == nil {
		open = openPlatformTPM
	}
	t, err := open()
	if errors.Is(err, ErrNoTPM) {
		return false, true
	}
	if err != nil {
		return false, false
	}
	defer t.Close()
	if _, err := (tpm2.GetCapability{
		Capability:    tpm2.TPMCapTPMProperties,
		Property:      uint32(tpm2.TPMPTFamilyIndicator),
		PropertyCount: 1,
	}).Execute(t); err != nil {
		// A device that does not speak TPM 2.0 commands.
		return false, true
	}
	return true, true
}
