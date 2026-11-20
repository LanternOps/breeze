//go:build tpmreal

// Against this machine's own TPM (Linux /dev/tpmrm0, Windows TBS), with
// enough rights to open it (root, the tss group, or SYSTEM):
//
//	go test -tags tpmreal -count=1 ./internal/tpmattest/
//
// It creates the EK and the AK as transient objects, activates one
// credential and flushes both: nothing persists in the TPM.

package tpmattest

import (
	"bytes"
	"context"
	"testing"
)

func TestAttestOnThisMachinesTPM(t *testing.T) {
	if available, ok := Available(nil); !ok || !available {
		t.Skipf("no usable TPM here (available=%v, known=%v)", available, ok)
	}
	server := &fakeServer{}
	if err := Attest(context.Background(), nil, server); err != nil {
		t.Fatalf("Attest: %v", err)
	}
	if !bytes.Equal(server.completed, server.secret) {
		t.Fatal("the TPM did not recover the secret")
	}
}
