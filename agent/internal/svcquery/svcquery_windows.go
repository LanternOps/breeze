//go:build windows

package svcquery

import (
	"errors"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// IsRunning returns true if the named Windows service exists and is running.
func IsRunning(name string) (bool, error) {
	info, err := GetStatus(name)
	if err != nil {
		return false, err
	}
	return info.IsActive(), nil
}

// GetStatus queries a single Windows service by key name or display name.
// It first tries the name as a service key name. If that fails, it scans
// all services for a matching display name (case-insensitive).
func GetStatus(name string) (ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return ServiceInfo{}, fmt.Errorf("svcquery: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	s, err := openServiceForQuery(m, name)
	if err != nil {
		if !errors.Is(err, ErrServiceNotFound) {
			// The service may exist (e.g. access denied) — do not fall back to
			// a display-name scan or report it as not found.
			return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: open service %s: %w", name, err)
		}
		// Fallback: try to resolve as a display name
		resolved, resolveErr := resolveDisplayName(m, name)
		if resolveErr != nil {
			if errors.Is(resolveErr, ErrServiceNotFound) {
				return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: open service %s: %w", name, err)
			}
			return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: resolve display name %q: %w", name, resolveErr)
		}
		s, err = openServiceForQuery(m, resolved)
		if err != nil {
			return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: open service %s (resolved from %q): %w", resolved, name, err)
		}
	}
	defer s.Close()

	status, err := s.Query()
	if err != nil {
		return ServiceInfo{Name: name, Status: StatusUnknown}, fmt.Errorf("svcquery: query %s: %w", name, err)
	}

	cfg, _ := queryBaseConfig(s)

	info := ServiceInfo{
		Name:        name,
		DisplayName: cfg.DisplayName,
		Status:      mapWindowsState(status.State),
		StartType:   mapWindowsStartType(cfg.StartType),
		BinaryPath:  cfg.BinaryPathName,
	}
	return info, nil
}

// ListServices returns all services on the system.
func ListServices() ([]ServiceInfo, error) {
	m, err := mgr.Connect()
	if err != nil {
		return nil, fmt.Errorf("svcquery: connect to SCM: %w", err)
	}
	defer m.Disconnect()

	names, err := m.ListServices()
	if err != nil {
		return nil, fmt.Errorf("svcquery: list services: %w", err)
	}

	services := make([]ServiceInfo, 0, len(names))
	for _, name := range names {
		s, err := openServiceForQuery(m, name)
		if err != nil {
			continue
		}
		status, err := s.Query()
		if err != nil {
			s.Close()
			continue
		}
		cfg, _ := queryBaseConfig(s)
		services = append(services, ServiceInfo{
			Name:        name,
			DisplayName: cfg.DisplayName,
			Status:      mapWindowsState(status.State),
			StartType:   mapWindowsStartType(cfg.StartType),
			BinaryPath:  cfg.BinaryPathName,
		})
		s.Close()
	}
	return services, nil
}

// resolveDisplayName scans all services to find one whose display name
// matches (case-insensitive). Returns the service key name.
func resolveDisplayName(m *mgr.Mgr, displayName string) (string, error) {
	names, err := m.ListServices()
	if err != nil {
		return "", err
	}
	lower := strings.ToLower(displayName)
	// A service we could not inspect might be the one being asked for, so if
	// nothing matches we must not claim the name does not exist.
	var uninspected error
	for _, keyName := range names {
		s, err := openServiceForQuery(m, keyName)
		if err != nil {
			if uninspected == nil && !errors.Is(err, ErrServiceNotFound) {
				uninspected = fmt.Errorf("open service %s: %w", keyName, err)
			}
			continue
		}
		cfg, err := queryBaseConfig(s)
		s.Close()
		if err != nil {
			if uninspected == nil {
				uninspected = fmt.Errorf("query config %s: %w", keyName, err)
			}
			continue
		}
		if strings.ToLower(cfg.DisplayName) == lower {
			return keyName, nil
		}
	}
	if uninspected != nil {
		return "", fmt.Errorf("no inspectable service with display name %q (%w)", displayName, uninspected)
	}
	return "", fmt.Errorf("no service with display name %q: %w", displayName, ErrServiceNotFound)
}

// queryServiceAccess is the only access svcquery needs: Query() requires
// SERVICE_QUERY_STATUS and queryBaseConfig() requires SERVICE_QUERY_CONFIG.
// mgr.(*Mgr).OpenService requests SERVICE_ALL_ACCESS, which services with a
// restrictive DACL (e.g. WinDefend) refuse with "Access is denied" (#7967).
const queryServiceAccess = windows.SERVICE_QUERY_STATUS | windows.SERVICE_QUERY_CONFIG

// winOpenService is a seam so tests can assert the requested access mask and
// simulate ERROR_ACCESS_DENIED without a non-elevated host.
var winOpenService = windows.OpenService

// openServiceForQuery opens a service read-only. A service that does not exist
// is reported as an error wrapping ErrServiceNotFound.
func openServiceForQuery(m *mgr.Mgr, name string) (*mgr.Service, error) {
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return nil, fmt.Errorf("%w: invalid service name %q: %w", ErrServiceNotFound, name, err)
	}
	h, err := winOpenService(m.Handle, namePtr, queryServiceAccess)
	if err != nil {
		return nil, classifyOpenError(err)
	}
	return &mgr.Service{Name: name, Handle: h}, nil
}

// classifyOpenError wraps ErrServiceNotFound around OpenService errors that
// prove the service does not exist. Everything else (notably
// ERROR_ACCESS_DENIED) is returned unchanged: the service may exist.
func classifyOpenError(err error) error {
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) || errors.Is(err, windows.ERROR_INVALID_NAME) {
		return fmt.Errorf("%w: %w", ErrServiceNotFound, err)
	}
	return err
}

// baseConfig is the subset of a service's configuration svcquery reports.
type baseConfig struct {
	DisplayName    string
	StartType      uint32
	BinaryPathName string
}

// queryBaseConfig reads only QueryServiceConfig. mgr.(*Service).Config also
// issues QueryServiceConfig2 for the description, delayed-start and SID info,
// and fails outright when any of those fail — e.g. a description stored as an
// unresolvable MUI resource returns ERROR_FILE_NOT_FOUND (seen on
// WaaSMedicSvc). None of that is needed here, so it must not hide the display
// name, start type or binary path.
func queryBaseConfig(s *mgr.Service) (baseConfig, error) {
	n := uint32(1024)
	for {
		b := make([]byte, n)
		p := (*windows.QUERY_SERVICE_CONFIG)(unsafe.Pointer(&b[0]))
		err := windows.QueryServiceConfig(s.Handle, p, n, &n)
		if err == nil {
			return baseConfig{
				DisplayName:    windows.UTF16PtrToString(p.DisplayName),
				StartType:      p.StartType,
				BinaryPathName: windows.UTF16PtrToString(p.BinaryPathName),
			}, nil
		}
		if !errors.Is(err, windows.ERROR_INSUFFICIENT_BUFFER) || n <= uint32(len(b)) {
			return baseConfig{}, err
		}
	}
}

func mapWindowsState(state svc.State) ServiceStatus {
	switch state {
	case svc.Running:
		return StatusRunning
	case svc.Stopped:
		return StatusStopped
	case svc.Paused:
		return StatusStopped
	case svc.StartPending, svc.ContinuePending:
		return StatusRunning
	case svc.StopPending, svc.PausePending:
		return StatusStopped
	default:
		return StatusUnknown
	}
}

func mapWindowsStartType(startType uint32) string {
	switch startType {
	case mgr.StartAutomatic, mgr.StartAutomatic + 0x80: // 0x80 = delayed start flag
		return "automatic"
	case mgr.StartManual:
		return "manual"
	case mgr.StartDisabled:
		return "disabled"
	default:
		return strings.ToLower(fmt.Sprintf("type_%d", startType))
	}
}
