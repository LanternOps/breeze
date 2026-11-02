//go:build !darwin

package yarac

// Linux and Windows do not enforce code signing on anonymous executable
// pages.
func platformCodeSigning() (codeSigning, error) { return codeSigning{}, nil }
