//go:build windows

package security

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"

	"github.com/breeze-rmm/agent/internal/config"
	"github.com/breeze-rmm/agent/internal/securefs"
)

const seceditTimeout = 30 * time.Second

// seceditExportBaseDir is where the per-run export directory is created;
// tests point it at a temp dir.
var seceditExportBaseDir = config.GetDataDir

// collectPasswordPolicySecedit exports the local security policy with
// `secedit /export /areas SECURITYPOLICY` and parses [System Access]. The
// export needs a file, so it goes into a fresh directory under the agent's
// data dir created with a protected SYSTEM + Administrators DACL (never a
// world-writable temp dir) and removed afterwards.
func collectPasswordPolicySecedit() (map[string]any, error) {
	sysDir, err := windows.GetSystemDirectory()
	if err != nil {
		return nil, fmt.Errorf("locate system directory: %w", err)
	}
	dir, err := securefs.CreatePrivateTempDir(seceditExportBaseDir(), "secpol-")
	if err != nil {
		return nil, err
	}
	defer func() { _ = os.RemoveAll(dir) }()

	cfgPath := filepath.Join(dir, "secpol.inf")
	_, runErr := runCommand(seceditTimeout, filepath.Join(sysDir, "secedit.exe"),
		"/export", "/areas", "SECURITYPOLICY",
		"/cfg", cfgPath,
		"/log", filepath.Join(dir, "secedit.log"),
		"/quiet",
	)
	// secedit can exit non-zero ("completed with warnings" for an unrelated
	// attribute) after writing a complete export, so the file decides.
	data, readErr := os.ReadFile(cfgPath)
	if readErr != nil {
		if runErr != nil {
			return nil, fmt.Errorf("secedit export: %w", runErr)
		}
		return nil, fmt.Errorf("read secedit export: %w", readErr)
	}
	record, parseErr := parseSeceditSystemAccess(data)
	if parseErr != nil {
		if runErr != nil {
			return nil, fmt.Errorf("secedit export: %v: %w", runErr, parseErr)
		}
		return nil, parseErr
	}
	return record, nil
}

var procNetUserModalsGet = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserModalsGet")

// collectPasswordPolicyNetAPI reads the local account policy with
// NetUserModalsGet (what `net accounts` calls, minus the translated labels).
// Used when secedit fails; it cannot report password complexity.
func collectPasswordPolicyNetAPI() (map[string]any, error) {
	if err := procNetUserModalsGet.Find(); err != nil {
		return nil, err
	}

	// USER_MODALS_INFO_0
	var info0 struct {
		MinPasswdLen, MaxPasswdAge, MinPasswdAge, ForceLogoff, PasswordHistLen uint32
	}
	if err := userModalsGet(0, unsafe.Pointer(&info0), unsafe.Sizeof(info0)); err != nil {
		return nil, fmt.Errorf("NetUserModalsGet level 0: %w", err)
	}
	policy := userModalsPolicy{
		MinPasswordLen:    info0.MinPasswdLen,
		MaxPasswordAgeSec: info0.MaxPasswdAge,
		MinPasswordAgeSec: info0.MinPasswdAge,
		PasswordHistLen:   info0.PasswordHistLen,
	}

	// USER_MODALS_INFO_3
	var info3 struct {
		LockoutDuration, LockoutObservationWindow, LockoutThreshold uint32
	}
	if err := userModalsGet(3, unsafe.Pointer(&info3), unsafe.Sizeof(info3)); err == nil {
		policy.LockoutThreshold = info3.LockoutThreshold
		policy.HaveLockout = true
	}
	return passwordPolicyFromUserModals(policy), nil
}

// userModalsGet copies the fixed-size USER_MODALS_INFO_<level> structure for
// the local computer into dst and frees the API buffer.
func userModalsGet(level uint32, dst unsafe.Pointer, size uintptr) error {
	var buf *byte
	r, _, _ := procNetUserModalsGet.Call(0, uintptr(level), uintptr(unsafe.Pointer(&buf)))
	if r != 0 {
		return syscall.Errno(r)
	}
	if buf == nil {
		return errors.New("NetUserModalsGet returned no buffer")
	}
	defer func() { _ = windows.NetApiBufferFree(buf) }()
	copy(unsafe.Slice((*byte)(dst), size), unsafe.Slice(buf, size))
	return nil
}
