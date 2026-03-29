//go:build !windows

package vss

import "context"

// StubProvider is the non-Windows VSS provider. All methods return
// ErrVSSNotSupported.
type StubProvider struct{}

// NewProvider returns a StubProvider on non-Windows platforms.
func NewProvider(_ Config) Provider {
	return &StubProvider{}
}

func (s *StubProvider) CreateShadowCopy(_ context.Context, _ []string) (*VSSSession, error) {
	return nil, ErrVSSNotSupported
}

func (s *StubProvider) ReleaseShadowCopy(_ *VSSSession) error {
	return ErrVSSNotSupported
}

func (s *StubProvider) ListWriters(_ context.Context) ([]WriterStatus, error) {
	return nil, ErrVSSNotSupported
}

func (s *StubProvider) GetShadowPath(_ *VSSSession, _ string) (string, error) {
	return "", ErrVSSNotSupported
}
