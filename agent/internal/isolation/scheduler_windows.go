//go:build windows

package isolation

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"syscall"
	"time"
	"unsafe"

	"github.com/breeze-rmm/agent/internal/isolation/journal"
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

var procRecoveryWinVerifyTrust = windows.NewLazySystemDLL("wintrust.dll").NewProc("WinVerifyTrust")

// NewPlatformScheduler supplies Windows' independent recovery tasks. Paths are
// loaded afresh from the journal so an artifact rotation also rotates actions.
func NewPlatformScheduler(dataDir string) RecoveryScheduler {
	return &windowsScheduler{
		dataDir: dataDir,
		tempDir: dataDir,
		recoveryPath: func() (string, error) {
			j, err := journal.Load(journal.Path(dataDir))
			if err != nil {
				return "", err
			}
			return j.RecoveryPath, nil
		},
		run: func(args ...string) ([]byte, error) {
			systemDir, err := windows.GetSystemDirectory()
			if err != nil {
				return nil, fmt.Errorf("resolve schtasks directory: %w", err)
			}
			return runRecoveryCommand(30*time.Second, filepath.Join(systemDir, "schtasks.exe"), args...)
		},
		exists:          func(path string) bool { info, err := os.Stat(path); return err == nil && info.Mode().IsRegular() },
		verifySignature: verifyRecoveryAuthenticode,
		selfTest:        func(path string) error { _, err := runRecoveryCommand(15*time.Second, path, "self-test"); return err },
		now:             time.Now,
	}
}

func runRecoveryCommand(timeout time.Duration, path string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, args...).CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("execute %s: %w (%s)", path, err, output)
	}
	return output, nil
}

func verifyRecoveryAuthenticode(path string) error {
	filePath, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return fmt.Errorf("encode recovery path: %w", err)
	}
	if err := procRecoveryWinVerifyTrust.Find(); err != nil {
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
		// Isolation must not depend on reaching certificate infrastructure. The
		// Authenticode chain and signature are still checked against local trust;
		// revocation/AIA retrieval cannot open an extra network dependency here.
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
		status, _, _ := procRecoveryWinVerifyTrust.Call(uintptr(windows.InvalidHWND), uintptr(unsafe.Pointer(&action)), uintptr(unsafe.Pointer(&data)))
		// WinVerifyTrust returns a LONG, not a success/failure HRESULT. Only zero
		// means trusted, including when a provider returns a positive status code.
		if uint32(status) != 0 {
			return fmt.Errorf("WinVerifyTrust status 0x%08x: %w", uint32(status), syscall.Errno(uint32(status)))
		}
		return nil
	}
	verifyErr := invoke()
	// Closing state is required even when verification failed.
	data.StateAction = windows.WTD_STATEACTION_CLOSE
	closeErr := invoke()
	return errors.Join(verifyErr, closeErr)
}
