//go:build windows

package authenticode

import (
	"errors"
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Compile-time ABI checks complement the runtime tests: cross-vet must catch
// layout drift even when CI cannot execute these Windows-only tests.
const trustPointerSize = unsafe.Sizeof(uintptr(0))

var (
	_ [unsafe.Sizeof(windows.WinTrustData{}) - (9*trustPointerSize + 16)]byte
	_ [(9*trustPointerSize + 16) - unsafe.Sizeof(windows.WinTrustData{})]byte
	_ [unsafe.Offsetof(windows.WinTrustData{}.FileOrCatalogOrBlobOrSgnrOrCert) - (4*trustPointerSize + 8)]byte
	_ [(4*trustPointerSize + 8) - unsafe.Offsetof(windows.WinTrustData{}.FileOrCatalogOrBlobOrSgnrOrCert)]byte
	_ [unsafe.Offsetof(windows.WinTrustData{}.StateAction) - (5*trustPointerSize + 8)]byte
	_ [(5*trustPointerSize + 8) - unsafe.Offsetof(windows.WinTrustData{}.StateAction)]byte
	_ [unsafe.Offsetof(windows.WinTrustData{}.StateData) - (6*trustPointerSize + 8)]byte
	_ [(6*trustPointerSize + 8) - unsafe.Offsetof(windows.WinTrustData{}.StateData)]byte
	_ [unsafe.Offsetof(windows.WinTrustData{}.URLReference) - (7*trustPointerSize + 8)]byte
	_ [(7*trustPointerSize + 8) - unsafe.Offsetof(windows.WinTrustData{}.URLReference)]byte
	_ [unsafe.Offsetof(windows.WinTrustData{}.SignatureSettings) - (8*trustPointerSize + 16)]byte
	_ [(8*trustPointerSize + 16) - unsafe.Offsetof(windows.WinTrustData{}.SignatureSettings)]byte
	_ [unsafe.Sizeof(windows.WinTrustFileInfo{}) - 4*trustPointerSize]byte
	_ [4*trustPointerSize - unsafe.Sizeof(windows.WinTrustFileInfo{})]byte
	_ [unsafe.Offsetof(windows.WinTrustFileInfo{}.FilePath) - trustPointerSize]byte
	_ [trustPointerSize - unsafe.Offsetof(windows.WinTrustFileInfo{}.FilePath)]byte
	_ [unsafe.Offsetof(windows.WinTrustFileInfo{}.File) - 2*trustPointerSize]byte
	_ [2*trustPointerSize - unsafe.Offsetof(windows.WinTrustFileInfo{}.File)]byte
	_ [unsafe.Offsetof(windows.WinTrustFileInfo{}.KnownSubject) - 3*trustPointerSize]byte
	_ [3*trustPointerSize - unsafe.Offsetof(windows.WinTrustFileInfo{}.KnownSubject)]byte
)

var (
	wintrust                           = windows.NewLazySystemDLL("wintrust.dll")
	procWinVerifyTrust                 = wintrust.NewProc("WinVerifyTrust")
	procWTHelperProvDataFromStateData  = wintrust.NewProc("WTHelperProvDataFromStateData")
	procWTHelperGetProvSignerFromChain = wintrust.NewProc("WTHelperGetProvSignerFromChain")
	procWTHelperGetProvCertFromChain   = wintrust.NewProc("WTHelperGetProvCertFromChain")
)

// cryptProviderCert is the head of CRYPT_PROVIDER_CERT: only pCert is read, and
// it directly follows cbStruct on every architecture.
type cryptProviderCert struct {
	cbStruct uint32
	cert     *windows.CertContext
}

// VerifyChain checks the file's Authenticode chain and signature against local
// trust.
func VerifyChain(path string) error {
	return verifyTrust(path, nil)
}

// Verify checks the chain, then reads the leaf signer. The signer is read from
// the same WinVerifyTrust state that passed, not by re-opening the file, so it
// describes exactly the signature that was verified.
func Verify(path string) (Signer, error) {
	var signer Signer
	err := verifyTrust(path, func(state windows.Handle) error {
		var readErr error
		signer, readErr = readLeafSigner(state)
		return readErr
	})
	if err != nil {
		return Signer{}, err
	}
	return signer, nil
}

// verifyTrust runs WinVerifyTrust and always closes its state. inspect, when
// set, runs only after a successful verification and before the close, while
// the provider data is still valid.
func verifyTrust(path string, inspect func(state windows.Handle) error) error {
	filePath, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("encode path: %w", err)
	}
	if err := procWinVerifyTrust.Find(); err != nil {
		return fmt.Errorf("load WinVerifyTrust: %w", err)
	}
	file := windows.WinTrustFileInfo{Size: uint32(unsafe.Sizeof(windows.WinTrustFileInfo{})), FilePath: filePath}
	data := windows.WinTrustData{
		Size:                            uint32(unsafe.Sizeof(windows.WinTrustData{})),
		UIChoice:                        windows.WTD_UI_NONE,
		RevocationChecks:                windows.WTD_REVOKE_NONE,
		UnionChoice:                     windows.WTD_CHOICE_FILE,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&file),
		StateAction:                     windows.WTD_STATEACTION_VERIFY,
		// Verification must not depend on reaching certificate infrastructure.
		// The Authenticode chain and signature are still checked against local
		// trust; revocation/AIA retrieval cannot open an extra network dependency
		// here. These flags turn revocation checking off entirely, not down to
		// the local cache: see the package comment.
		ProvFlags: windows.WTD_REVOCATION_CHECK_NONE | windows.WTD_CACHE_ONLY_URL_RETRIEVAL | windows.WTD_DISABLE_MD2_MD4,
	}
	action := windows.WINTRUST_ACTION_GENERIC_VERIFY_V2
	var pinned runtime.Pinner
	pinned.Pin(filePath)
	pinned.Pin(&file)
	pinned.Pin(&data)
	pinned.Pin(&action)
	defer pinned.Unpin()
	invoke := func() error {
		status, _, _ := procWinVerifyTrust.Call(uintptr(windows.InvalidHWND), uintptr(unsafe.Pointer(&action)), uintptr(unsafe.Pointer(&data)))
		// WinVerifyTrust returns a LONG, not a success/failure HRESULT. Only zero
		// means trusted, including when a provider returns a positive status code.
		if uint32(status) != 0 {
			return fmt.Errorf("WinVerifyTrust status 0x%08x: %w", uint32(status), syscall.Errno(uint32(status)))
		}
		return nil
	}
	verifyErr := invoke()
	var inspectErr error
	if verifyErr == nil && inspect != nil {
		inspectErr = inspect(data.StateData)
	}
	// Closing state is required even when verification failed.
	data.StateAction = windows.WTD_STATEACTION_CLOSE
	closeErr := invoke()
	return errors.Join(verifyErr, inspectErr, closeErr)
}

// readLeafSigner walks provider data to the first signer's leaf certificate.
// Every step fails closed: a signature whose signer cannot be named is not one
// a publisher pin can accept.
func readLeafSigner(state windows.Handle) (Signer, error) {
	for _, proc := range []*windows.LazyProc{procWTHelperProvDataFromStateData, procWTHelperGetProvSignerFromChain, procWTHelperGetProvCertFromChain} {
		if err := proc.Find(); err != nil {
			return Signer{}, fmt.Errorf("load %s: %w", proc.Name, err)
		}
	}
	provData, _, _ := procWTHelperProvDataFromStateData.Call(uintptr(state))
	if provData == 0 {
		return Signer{}, errors.New("read signer: no provider data")
	}
	// Index 0 is the primary signer; not a counter-signer.
	providerSigner, _, _ := procWTHelperGetProvSignerFromChain.Call(provData, 0, 0, 0)
	if providerSigner == 0 {
		return Signer{}, errors.New("read signer: no signer in provider data")
	}
	// Index 0 of the signer's chain is its leaf.
	providerCert, _, _ := procWTHelperGetProvCertFromChain.Call(providerSigner, 0)
	if providerCert == 0 {
		return Signer{}, errors.New("read signer: no leaf certificate")
	}
	// wintrust owns this memory (outside the Go heap) until the state is closed.
	// The double conversion keeps vet's uintptr check quiet for a C pointer.
	cert := (*cryptProviderCert)(*(*unsafe.Pointer)(unsafe.Pointer(&providerCert))).cert
	if cert == nil || cert.EncodedCert == nil || cert.Length == 0 {
		return Signer{}, errors.New("read signer: empty leaf certificate")
	}
	// Parsed while the state is open. The parse aliases this buffer, but Signer
	// holds only strings built from it, so nothing refers to wintrust's memory
	// after the close.
	return signerFromDER(unsafe.Slice(cert.EncodedCert, cert.Length))
}
