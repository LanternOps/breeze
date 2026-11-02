//go:build darwin && !cgo

package yarac

import "errors"

// Shipped darwin agents are cgo builds (ScreenCaptureKit, libopenh264); a
// CGO_ENABLED=0 darwin build exists only as a CI compile check. It cannot
// read its code-signing state, so the engine fails closed rather than
// risking a SIGKILL if such a binary is ever signed with the hardened
// runtime.
func platformCodeSigning() (codeSigning, error) {
	return codeSigning{}, errors.New("code-signing state is unreadable in a CGO_ENABLED=0 darwin build")
}
