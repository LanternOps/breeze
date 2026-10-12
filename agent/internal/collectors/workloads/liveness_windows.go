package workloads

import (
	"context"
	"errors"

	"golang.org/x/sys/windows"
)

// dockerLiveness connects to the pipe only while the `docker` service is
// running. The service is opened with SERVICE_QUERY_STATUS only, so the query
// cannot start or stop anything.
func dockerLiveness() func(context.Context) liveness {
	return func(context.Context) liveness { return livenessFromService(queryServiceState("docker")) }
}

func podmanLiveness() func(context.Context) liveness { return nil }

func queryServiceState(name string) serviceState {
	scm, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return serviceUnknown
	}
	defer windows.CloseServiceHandle(scm)
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return serviceUnknown
	}
	svc, err := windows.OpenService(scm, namePtr, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
			return serviceMissing
		}
		return serviceUnknown
	}
	defer windows.CloseServiceHandle(svc)
	var status windows.SERVICE_STATUS
	if err := windows.QueryServiceStatus(svc, &status); err != nil {
		return serviceUnknown
	}
	if status.CurrentState == windows.SERVICE_RUNNING {
		return serviceRunning
	}
	return serviceStopped
}
