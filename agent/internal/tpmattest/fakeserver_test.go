//go:build tpmsim || tpmreal

package tpmattest

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"errors"

	"github.com/google/go-tpm/tpm2"
)

// fakeServer is the API's half, done as the API does it: the API's
// TypeScript MakeCredential matches go-tpm's tpm2.CreateCredential byte for
// byte, with a 32-byte seed and the EK's AES-128 key
// (apps/api/src/services/tpmAttestation/makeCredential.test.ts).
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
	ekKey, err := tpm2.ImportEncapsulationKey(ek)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256(akPublic)
	if s.tamperName {
		digest[0] ^= 0xff
	}
	name := binary.BigEndian.AppendUint16(nil, uint16(tpm2.TPMAlgSHA256))
	name = append(name, digest[:]...)
	s.secret = make([]byte, 32)
	if _, err := rand.Read(s.secret); err != nil {
		return nil, err
	}
	id, enc, err := tpm2.CreateCredential(rand.Reader, ekKey, name, s.secret)
	if err != nil {
		return nil, err
	}
	return &Challenge{ID: "c-1", CredentialBlob: id, EncryptedSecret: enc}, nil
}

func (s *fakeServer) Complete(_ context.Context, _ string, secret []byte) error {
	s.completed = secret
	if !bytes.Equal(secret, s.secret) {
		return errors.New("wrong secret")
	}
	return nil
}
