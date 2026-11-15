//go:build tpmsim

// Run with: CGO_ENABLED=1 go test -tags tpmsim ./internal/tpmattest/
// The simulator is the TCG reference TPM (go-tpm-tools), built with cgo.

package tpmattest

import (
	"bytes"
	"context"
	"testing"

	"github.com/google/go-tpm/tpm2"
	"github.com/google/go-tpm/tpm2/transport"
	"github.com/google/go-tpm/tpm2/transport/simulator"
)

func simulatorOpener(t *testing.T) Opener {
	t.Helper()
	return func() (transport.TPMCloser, error) { return simulator.OpenSimulator() }
}

func TestAttestOnTheSimulator(t *testing.T) {
	server := &fakeServer{}
	if err := Attest(context.Background(), simulatorOpener(t), server); err != nil {
		t.Fatalf("Attest: %v", err)
	}
	if !bytes.Equal(server.completed, server.secret) {
		t.Fatal("the TPM did not recover the secret")
	}
}

func TestTheEKIsTheDefaultTemplateTheAPIChecks(t *testing.T) {
	tpm, err := simulator.OpenSimulator()
	if err != nil {
		t.Fatal(err)
	}
	defer tpm.Close()
	ek, err := createPrimary(tpm, tpm2.RSAEKTemplate)
	if err != nil {
		t.Fatal(err)
	}
	defer flush(tpm, ek.handle)
	// The API's ekTemplateRefusal: type, nameAlg, attributes 0x000300b2, then the policy digest.
	if !bytes.HasPrefix(ek.public, []byte{0x00, 0x01, 0x00, 0x0b, 0x00, 0x03, 0x00, 0xb2, 0x00, 0x20, 0x83, 0x71, 0x97, 0x67}) {
		t.Fatalf("unexpected EK header % x", ek.public[:14])
	}
}

func TestACredentialBoundToAnotherObjectIsRefusedByTheTPM(t *testing.T) {
	server := &fakeServer{tamperName: true}
	err := Attest(context.Background(), simulatorOpener(t), server)
	if err == nil {
		t.Fatal("the TPM activated a credential made for another object")
	}
	if server.completed != nil {
		t.Fatal("a secret was sent after a refused activation")
	}
}

func TestAvailableOnTheSimulator(t *testing.T) {
	if available, ok := Available(simulatorOpener(t)); !available || !ok {
		t.Fatalf("got (%v, %v), want (true, true)", available, ok)
	}
}
