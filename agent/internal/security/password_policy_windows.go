//go:build windows

package security

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	base := seceditExportBaseDir()
	dir, err := securefs.CreatePrivateTempDir(base, "secpol-")
	if err != nil {
		return nil, fmt.Errorf("create secedit export directory under %s: %w", base, err)
	}
	defer func() { _ = os.RemoveAll(dir) }()

	cfgPath := filepath.Join(dir, "secpol.inf")
	logPath := filepath.Join(dir, "secedit.log")
	ctx, cancel := context.WithTimeout(context.Background(), seceditTimeout)
	defer cancel()
	output, runErr := exec.CommandContext(ctx, filepath.Join(sysDir, "secedit.exe"),
		"/export", "/areas", "SECURITYPOLICY",
		"/cfg", cfgPath,
		"/log", logPath,
		"/quiet",
	).CombinedOutput()
	if ctx.Err() != nil {
		// Killed mid-run: whatever is in the file may be truncated.
		return nil, fmt.Errorf("secedit export timed out after %s", seceditTimeout)
	}
	var exitErr *exec.ExitError
	if runErr != nil && !errors.As(runErr, &exitErr) {
		return nil, fmt.Errorf("run secedit: %w", runErr)
	}

	// secedit can exit non-zero ("completed with warnings" for an unrelated
	// attribute) after writing a complete export, so a non-zero exit is
	// accepted only when the export itself parses.
	data, readErr := os.ReadFile(cfgPath)
	if readErr == nil {
		record, parseErr := parseSeceditSystemAccess(data)
		if parseErr == nil {
			if runErr != nil {
				log.Warn("secedit exited non-zero but its export parsed; using it",
					"exitCode", exitErr.ExitCode(), "detail", seceditDiagnostic(output, logPath))
			}
			return record, nil
		}
		readErr = parseErr
	}
	if runErr != nil {
		return nil, fmt.Errorf("secedit export exited %d: %v (%s)", exitErr.ExitCode(), readErr, seceditDiagnostic(output, logPath))
	}
	return nil, fmt.Errorf("secedit export: %w", readErr)
}

// seceditDiagnostic is a short tail of secedit's console output, or of its
// log file when the console said nothing (/quiet), for error messages.
func seceditDiagnostic(output []byte, logPath string) string {
	text := strings.TrimSpace(string(output))
	if text == "" {
		if data, err := os.ReadFile(logPath); err == nil {
			if decoded, err := decodeSeceditExport(data); err == nil {
				text = strings.TrimSpace(decoded)
			}
		}
	}
	const maxLen = 300
	if len(text) > maxLen {
		text = "..." + text[len(text)-maxLen:]
	}
	if text == "" {
		return "no output"
	}
	return text
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
	if err := userModalsGet(3, unsafe.Pointer(&info3), unsafe.Sizeof(info3)); err != nil {
		log.Warn("NetUserModalsGet level 3 failed; lockout threshold will be reported unknown", "error", err.Error())
	} else {
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
