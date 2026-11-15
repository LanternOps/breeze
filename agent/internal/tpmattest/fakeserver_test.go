//go:build tpmsim || tpmreal

package tpmattest

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"errors"
	"math/big"

	legacy "github.com/google/go-tpm/legacy/tpm2"
	"github.com/google/go-tpm/legacy/tpm2/credactivation"
	"github.com/google/go-tpm/tpm2"
)

// fakeServer is the API's half, done as the API does it (the API's
// TypeScript MakeCredential matches go-tpm's credactivation byte for byte:
// apps/api/src/services/tpmAttestation/makeCredential.test.ts).
type fakeServer struct {
	secret    []byte
	completed []byte
	// tamperName binds the credential to another object, as a forged AK would.
	tamperName bool
}

func (s *fakeServer) Challenge(_ context.Context, ekPublic, akPublic []byte) (*Challenge, error) {
	ek, err := tpm2.Unmarshal[tpm2.TPMTPublic](ekPublic)
	if err != nil {
		return nil, err
	}
	ekRSA, err := ek.Unique.RSA()
	if err != nil {
		return nil, err
	}
	pub := &rsa.PublicKey{N: new(big.Int).SetBytes(ekRSA.Buffer), E: 65537}
	digest := sha256.Sum256(akPublic)
	if s.tamperName {
		digest[0] ^= 0xff
	}
	s.secret = make([]byte, 32)
	if _, err := rand.Read(s.secret); err != nil {
		return nil, err
	}
	id, enc, err := credactivation.Generate(&legacy.HashValue{Alg: legacy.AlgSHA256, Value: digest[:]}, pub, 16, s.secret)
	if err != nil {
		return nil, err
	}
	encrypted := enc[2:]
	for len(encrypted) != 256 {
		encrypted = encrypted[2:]
	}
	return &Challenge{ID: "c-1", CredentialBlob: id[2:], EncryptedSecret: encrypted}, nil
}

func (s *fakeServer) Complete(_ context.Context, _ string, secret []byte) error {
	s.completed = secret
	if !bytes.Equal(secret, s.secret) {
		return errors.New("wrong secret")
	}
	return nil
}
