//go:build !windows

package elevaccount

import "context"

type noopManager struct{}

func newManager() AccountManager { return &noopManager{} }

func (*noopManager) EnsureProvisioned() error { return nil }

func (*noopManager) Promote(context.Context) (Credential, error) {
	return Credential{}, ErrUnsupportedPlatform
}

func (*noopManager) Demote(context.Context) error { return nil }

func (*noopManager) Deprovision(context.Context) (AccountEvidence, error) {
	return AccountEvidence{}, ErrUnsupportedPlatform
}

func (*noopManager) VerifyClean(context.Context) (AccountEvidence, error) {
	return AccountEvidence{}, ErrUnsupportedPlatform
}
