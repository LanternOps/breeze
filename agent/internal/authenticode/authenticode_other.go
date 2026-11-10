//go:build !windows

package authenticode

// Verify always fails off Windows.
func Verify(string) (Signer, error) { return Signer{}, ErrUnsupported }

// VerifyChain always fails off Windows.
func VerifyChain(string) error { return ErrUnsupported }
