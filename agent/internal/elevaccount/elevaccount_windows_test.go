//go:build windows

package elevaccount

import (
	"context"
	"testing"
)

func TestWindowsManagerExposesVerifiedDeprovisionContract(t *testing.T) {
	manager := NewVerified()
	var _ interface {
		Deprovision(context.Context) (AccountEvidence, error)
		VerifyClean(context.Context) (AccountEvidence, error)
	} = manager
}
