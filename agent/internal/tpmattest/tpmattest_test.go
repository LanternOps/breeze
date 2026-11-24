package tpmattest

import (
	"context"
	"errors"
	"testing"

	"github.com/google/go-tpm/tpm2/transport"
)

// The TPM-backed flow is tested against the TPM simulator behind the tpmsim
// build tag (sim_test.go; the simulator needs cgo). These cover the paths
// that need no TPM.

type noAPI struct{ calls int }

func (a *noAPI) Challenge(context.Context, []byte, []byte) (*Challenge, error) {
	a.calls++
	return nil, errors.New("unexpected")
}

func (a *noAPI) Complete(context.Context, string, []byte) error {
	a.calls++
	return errors.New("unexpected")
}

func TestAttestWithoutATPMAsksTheServerNothing(t *testing.T) {
	api := &noAPI{}
	err := Attest(context.Background(), func() (transport.TPMCloser, error) { return nil, ErrNoTPM }, api)
	if !errors.Is(err, ErrNoTPM) {
		t.Fatalf("Attest = %v, want ErrNoTPM", err)
	}
	if api.calls != 0 {
		t.Fatalf("the server was called %d times", api.calls)
	}
}

func TestAvailableTellsNoTPMFromAnUnknownAnswer(t *testing.T) {
	if available, ok := Available(func() (transport.TPMCloser, error) { return nil, ErrNoTPM }); available || !ok {
		t.Fatalf("no TPM: got (%v, %v), want (false, true)", available, ok)
	}
	if available, ok := Available(func() (transport.TPMCloser, error) { return nil, errors.New("permission denied") }); available || ok {
		t.Fatalf("an open error: got (%v, %v), want (false, false)", available, ok)
	}
}

func TestAKTemplateIsARestrictedSigningKeyBoundToItsTPM(t *testing.T) {
	a := AKTemplate.ObjectAttributes
	if !a.Restricted || !a.SignEncrypt || !a.FixedTPM || !a.FixedParent || !a.SensitiveDataOrigin {
		t.Fatalf("the AK misses an attribute the API requires: %+v", a)
	}
	if a.Decrypt {
		t.Fatal("the AK must not be a decryption key")
	}
}
