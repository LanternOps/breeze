//go:build windows

package elevaccount

import (
	"context"
	"fmt"
	"syscall"
	"testing"
)

func TestWindowsManagerExposesVerifiedDeprovisionContract(t *testing.T) {
	manager := NewVerified()
	var _ interface {
		Deprovision(context.Context) (AccountEvidence, error)
		VerifyClean(context.Context) (AccountEvidence, error)
	} = manager
}

func TestWindowsNeverProvisionedAccountCleanupWithMockSAM(t *testing.T) {
	for _, status := range []uint32{nerrUserNotFound, errorNoneMapped} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			absent := absentAccountErr(fmt.Errorf("lookup %s: %w", AccountName, syscall.Errno(status)))
			passwordCalls, lookupCalls := 0, 0
			unexpected := func() { t.Fatal("absent account reached a later SAM mutation or group lookup") }
			manager := &windowsManager{cleanupOps: &windowsAccountCleanupOps{
				setPassword: func(name, _ string) error {
					if name != AccountName {
						t.Fatalf("wrong account: %s", name)
					}
					passwordCalls++
					return absent
				},
				accountEnabled: func(name string) (bool, error) {
					if name != AccountName {
						t.Fatalf("wrong account: %s", name)
					}
					lookupCalls++
					return false, absent
				},
				removeFromAdministrators: func(string) error { unexpected(); return nil },
				setUserFlags:             func(string, uint32) error { unexpected(); return nil },
				accountInAdministrators:  func(string) (bool, error) { unexpected(); return false, nil },
			}}
			for _, probe := range []func(context.Context) (AccountEvidence, error){manager.Deprovision, manager.VerifyClean} {
				evidence, err := probe(context.Background())
				if err != nil || evidence.Enabled || evidence.InAdministrators {
					t.Fatalf("never-provisioned cleanup = %+v, %v", evidence, err)
				}
			}
			if passwordCalls != 1 || lookupCalls != 1 {
				t.Fatalf("SAM calls = %d mutations / %d reads", passwordCalls, lookupCalls)
			}
		})
	}
}
