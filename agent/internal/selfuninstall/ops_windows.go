//go:build windows

package selfuninstall

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"

	"github.com/breeze-rmm/agent/internal/procspawn"
)

const (
	serviceStopTimeout  = 60 * time.Second
	serviceKillTimeout  = 15 * time.Second
	serviceStartTimeout = 60 * time.Second
	servicePoll         = 500 * time.Millisecond
	// msiUninstallTimeout bounds one msiexec client. Windows Installer keeps
	// running server-side if it is reached; the uninstall is then reported
	// failed and verified on the next attempt.
	msiUninstallTimeout = 20 * time.Minute
	// recoveryResetPeriodSeconds matches winsvcinstall and the MSI.
	recoveryResetPeriodSeconds = 86400
)

type windowsOps struct{}

// NewWindowsOps returns the real Windows side effects.
func NewWindowsOps() WindowsOps { return windowsOps{} }

func (windowsOps) ReleaseIsolation(ctx context.Context, agentBinary string) error {
	out, err := procspawn.CommandContext(ctx, agentBinary, "containment", "release-all", "--reason", "uninstall").CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s containment release-all: %w (output: %s)", agentBinary, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (windowsOps) Sleep(ctx context.Context, d time.Duration) error { return sleepCtx(ctx, d) }

// openService returns nil, nil when the service is not registered.
func openService(m *mgr.Mgr, name string) (*mgr.Service, error) {
	s, err := m.OpenService(name)
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil, nil
	}
	return s, err
}

func (windowsOps) StopService(ctx context.Context, name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to the service manager: %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	s, err := openService(m, name)
	if err != nil || s == nil {
		return err
	}
	defer func() { _ = s.Close() }()
	return stopAndWait(ctx, s)
}

// stopAndWait asks the service to stop and waits for STOPPED; one that does
// not stop in time has its process terminated and is waited for again.
func stopAndWait(ctx context.Context, s *mgr.Service) error {
	status, err := s.Query()
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	if status.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil && !errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) &&
		!errors.Is(err, windows.ERROR_SERVICE_CANNOT_ACCEPT_CTRL) {
		return fmt.Errorf("request stop: %w", err)
	}
	if waitForState(ctx, s, svc.Stopped, serviceStopTimeout) == nil {
		return nil
	}
	status, err = s.Query()
	if err != nil {
		return fmt.Errorf("query: %w", err)
	}
	if status.ProcessId != 0 {
		if h, openErr := windows.OpenProcess(windows.PROCESS_TERMINATE, false, status.ProcessId); openErr == nil {
			_ = windows.TerminateProcess(h, 1)
			_ = windows.CloseHandle(h)
		}
	}
	if err := waitForState(ctx, s, svc.Stopped, serviceKillTimeout); err != nil {
		return fmt.Errorf("did not stop within %s, nor after its process was terminated: %w", serviceStopTimeout, err)
	}
	return nil
}

func waitForState(ctx context.Context, s *mgr.Service, want svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		status, err := s.Query()
		if err != nil {
			return err
		}
		if status.State == want {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("still in state %d after %s", status.State, timeout)
		}
		if err := sleepCtx(ctx, servicePoll); err != nil {
			return err
		}
	}
}

func (windowsOps) DeleteService(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to the service manager: %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	s, err := openService(m, name)
	if err != nil || s == nil {
		return err
	}
	defer func() { _ = s.Close() }()
	if err := s.Delete(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return err
	}
	return nil
}

// ServiceExists treats a registration marked for deletion as gone: it is
// removed once the last open handle to it closes. A no-op config change is
// the documented way to tell (it fails with ERROR_SERVICE_MARKED_FOR_DELETE).
func (windowsOps) ServiceExists(name string) (bool, error) {
	m, err := mgr.Connect()
	if err != nil {
		return false, fmt.Errorf("connect to the service manager: %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	s, err := openService(m, name)
	if err != nil || s == nil {
		return false, err
	}
	defer func() { _ = s.Close() }()
	err = windows.ChangeServiceConfig(s.Handle, windows.SERVICE_NO_CHANGE, windows.SERVICE_NO_CHANGE,
		windows.SERVICE_NO_CHANGE, nil, nil, nil, nil, nil, nil, nil)
	if errors.Is(err, windows.ERROR_SERVICE_MARKED_FOR_DELETE) {
		return false, nil
	}
	return true, nil
}

func (windowsOps) KillProcesses(names []string) {
	if len(names) == 0 {
		return
	}
	args := []string{"/F"}
	for _, n := range names {
		args = append(args, "/IM", n)
	}
	// Exit 128 means none were running; nothing here is worth failing on, and
	// verify-processes checks what matters.
	if out, err := procspawn.Command(systemTool("taskkill.exe"), args...).CombinedOutput(); err != nil {
		log.Debug("taskkill", "error", err.Error(), "output", strings.TrimSpace(string(out)))
	}
}

func (windowsOps) RelatedProducts(upgradeCodes []string) ([]string, error) {
	return relatedProducts(upgradeCodes)
}

func (windowsOps) UninstallProduct(ctx context.Context, productCode, logPath string) (int, error) {
	if logPath != "" {
		_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
	}
	ctx, cancel := context.WithTimeout(ctx, msiUninstallTimeout)
	defer cancel()
	args := []string{"/x", productCode, "/qn", "/norestart", "REBOOT=ReallySuppress"}
	if logPath != "" {
		args = append(args, "/l*v", logPath)
	}
	err := procspawn.CommandContext(ctx, systemTool("msiexec.exe"), args...).Run()
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		return 0, nil
	case errors.As(err, &exitErr):
		return exitErr.ExitCode(), nil
	default:
		return -1, err
	}
}

func scheduledTaskExists(name string) bool {
	return procspawn.Command(systemTool("schtasks.exe"), "/Query", "/TN", name).Run() == nil
}

func (windowsOps) DeleteScheduledTask(name string) error {
	if !scheduledTaskExists(name) {
		return nil
	}
	out, err := procspawn.Command(systemTool("schtasks.exe"), "/Delete", "/TN", name, "/F").CombinedOutput()
	if err != nil {
		return fmt.Errorf("schtasks /Delete: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (windowsOps) ScheduledTaskExists(name string) (bool, error) {
	return scheduledTaskExists(name), nil
}

func (windowsOps) RemoveFile(path string) error {
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func (windowsOps) RemoveFileAtReboot(path string) error {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(p, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
}

func (windowsOps) RemoveAll(path string) error { return os.RemoveAll(path) }

func (windowsOps) ProcessesRunning(names []string) ([]string, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(snap) }()
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	seen := map[string]bool{}
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		exe := windows.UTF16ToString(entry.ExeFile[:])
		for _, n := range names {
			if strings.EqualFold(exe, n) {
				seen[n] = true
			}
		}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return nil, err
	}
	var running []string
	for _, n := range names {
		if seen[n] {
			running = append(running, n)
		}
	}
	return running, nil
}

// RestoreService undoes the in-process preparation (start=disabled, recovery
// cleared) and restarts the service. Restarting matters even when it is still
// running: that process has its self-uninstall exit armed.
func (windowsOps) RestoreService(ctx context.Context, name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect to the service manager: %w", err)
	}
	defer func() { _ = m.Disconnect() }()
	s, err := openService(m, name)
	if err != nil {
		return err
	}
	if s == nil {
		return fmt.Errorf("the %s service is no longer registered; nothing to restore", name)
	}
	defer func() { _ = s.Close() }()

	cfg, err := s.Config()
	if err != nil {
		return fmt.Errorf("read config: %w", err)
	}
	if cfg.StartType != mgr.StartAutomatic {
		cfg.StartType = mgr.StartAutomatic
		if err := s.UpdateConfig(cfg); err != nil {
			return fmt.Errorf("re-enable automatic start: %w", err)
		}
	}
	if err := s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, recoveryResetPeriodSeconds); err != nil {
		return fmt.Errorf("restore recovery actions: %w", err)
	}
	_ = s.SetRecoveryActionsOnNonCrashFailures(true)

	if err := stopAndWait(ctx, s); err != nil {
		return fmt.Errorf("stop before restart: %w", err)
	}
	if err := s.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
		return fmt.Errorf("start: %w", err)
	}
	return waitForState(ctx, s, svc.Running, serviceStartTimeout)
}

// systemTool resolves a System32 tool by full path, never by PATH.
func systemTool(name string) string {
	if dir, err := windows.GetSystemDirectory(); err == nil {
		return filepath.Join(dir, name)
	}
	return name
}
