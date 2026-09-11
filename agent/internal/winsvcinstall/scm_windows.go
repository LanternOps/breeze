//go:build windows

package winsvcinstall

import (
	"errors"
	"fmt"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// recoveryResetPeriodSeconds is how long Windows waits before forgetting a
// service's failure count (24 h).
const recoveryResetPeriodSeconds = 86400

// Connect opens the Service Control Manager. The caller must Close the Manager.
func Connect() (Manager, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("failed to connect to the Service Control Manager (run as Administrator): %w", err)
	}
	return &scmManager{m: m}, nil
}

type scmManager struct{ m *mgr.Mgr }

func (s *scmManager) Open(name string) (Service, error) {
	handle, err := s.m.OpenService(name)
	if err != nil {
		// "does not exist" is the create signal and must stay distinguishable
		// from an SCM that simply refused to answer.
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return nil, ErrNotInstalled
		}
		return nil, err
	}
	return &scmService{s: handle}, nil
}

func (s *scmManager) Create(spec Spec, exePath string) (Service, error) {
	handle, err := s.m.CreateService(spec.Name, exePath, mgr.Config{
		DisplayName:  spec.DisplayName,
		Description:  spec.Description,
		StartType:    mgr.StartAutomatic,
		ErrorControl: mgr.ErrorNormal,
	}, spec.Args...)
	if err != nil {
		return nil, err
	}
	return &scmService{s: handle}, nil
}

func (s *scmManager) Close() error { return s.m.Disconnect() }

type scmService struct{ s *mgr.Service }

func (x *scmService) Status() (Status, error) {
	st, err := x.s.Query()
	if err != nil {
		return Status{}, err
	}
	return Status{
		State:           neutralState(st.State),
		Win32ExitCode:   st.Win32ExitCode,
		ServiceExitCode: st.ServiceSpecificExitCode,
	}, nil
}

// neutralState maps the SCM's state to the three states the install sequence
// branches on. Everything else (STOP_PENDING, PAUSED, …) is "busy, keep
// polling" — deliberately not STOPPED, so a service on its way down is never
// mistaken for one that is already down.
func neutralState(s svc.State) State {
	switch s {
	case svc.Stopped:
		return StateStopped
	case svc.StartPending:
		return StateStartPending
	case svc.Running:
		return StateRunning
	default:
		return StateOther
	}
}

func (x *scmService) RequestStop() error {
	if _, err := x.s.Control(svc.Stop); err != nil {
		// The service stopped between our sample and this call. Not a failure.
		if errors.Is(err, windows.ERROR_SERVICE_NOT_ACTIVE) {
			return ErrNotRunning
		}
		return err
	}
	return nil
}

// Reconfigure repoints an existing registration at exePath.
//
// Only the three fields the install functionally depends on are re-asserted:
// the command line, so the service runs the binary we just staged; StartType,
// so an upgrade heals a service left Disabled by earlier troubleshooting
// (otherwise the install would succeed and the Start that follows would fail
// with ERROR_SERVICE_DISABLED); and ErrorControl. This mirrors the unconditional
// `systemctl enable` the Linux install does.
//
// Spec.DisplayName and Spec.Description are deliberately NOT applied here, only
// on Create. The MSI registers BreezeAgent with its own display name, and the
// MSI is the supported Windows install path — re-running `service install` on
// such a host should fix what is broken, not silently rename the service in
// services.msc. Everything else (account, dependencies, SID type, delayed
// start) is read back and preserved for the same reason.
func (x *scmService) Reconfigure(spec Spec, exePath string) error {
	cfg, err := x.s.Config()
	if err != nil {
		return fmt.Errorf("read the current service configuration: %w", err)
	}
	cfg.BinaryPathName = binaryPathName(exePath, spec.Args...)
	cfg.StartType = mgr.StartAutomatic
	cfg.ErrorControl = mgr.ErrorNormal
	return x.s.UpdateConfig(cfg)
}

// binaryPathName builds the service command line exactly the way
// mgr.CreateService does internally, so a reconfigured service and a freshly
// created one end up registered identically — including the quoting that keeps
// `C:\Program Files\…` from being read as two arguments.
func binaryPathName(exePath string, args ...string) string {
	line := syscall.EscapeArg(exePath)
	for _, a := range args {
		line += " " + syscall.EscapeArg(a)
	}
	return line
}

func (x *scmService) SetRecoveryActions() error {
	return x.s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 30 * time.Second},
	}, recoveryResetPeriodSeconds)
}

// RequestStart passes no arguments: the command line, including "run", lives in
// the registration itself, and start-time arguments would not survive an SCM
// restart of the service.
func (x *scmService) RequestStart() error { return x.s.Start() }

func (x *scmService) Close() error { return x.s.Close() }

var (
	_ Manager = (*scmManager)(nil)
	_ Service = (*scmService)(nil)
)
