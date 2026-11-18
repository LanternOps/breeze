package sessionbroker

import (
	"errors"
	"fmt"
	"syscall"
)

// Win32 codes returned by LookupAccountName / LookupAccountSid. They are
// spelled out here, not taken from x/sys/windows, so the classification is
// tested on every platform.
const (
	winErrorNoLogonServers         syscall.Errno = 1311 // ERROR_NO_LOGON_SERVERS
	winErrorNoneMapped             syscall.Errno = 1332 // ERROR_NONE_MAPPED
	winErrorNoSuchDomain           syscall.Errno = 1355 // ERROR_NO_SUCH_DOMAIN (does not exist or could not be contacted)
	winErrorTimeout                syscall.Errno = 1460 // ERROR_TIMEOUT
	winRPCServerUnavailable        syscall.Errno = 1722 // RPC_S_SERVER_UNAVAILABLE
	winRPCCallFailed               syscall.Errno = 1726 // RPC_S_CALL_FAILED
	winRPCCallFailedDNE            syscall.Errno = 1727 // RPC_S_CALL_FAILED_DNE
	winErrorTrustedDomainFailure   syscall.Errno = 1788 // ERROR_TRUSTED_DOMAIN_FAILURE
	winErrorTrustedRelationFailure syscall.Errno = 1789 // ERROR_TRUSTED_RELATIONSHIP_FAILURE
	winErrorNetlogonNotStarted     syscall.Errno = 1792 // ERROR_NETLOGON_NOT_STARTED
	winErrorDCNotFound             syscall.Errno = 1908 // ERROR_DOMAIN_CONTROLLER_NOT_FOUND
)

// classifyWindowsLookupError marks a Windows account lookup failure as "no
// such account" or "directory unavailable"; other failures are returned
// unmarked.
func classifyWindowsLookupError(err error) error {
	var errno syscall.Errno
	if err == nil || !errors.As(err, &errno) {
		return err
	}
	switch errno {
	case winErrorNoneMapped:
		return fmt.Errorf("%w: %v", errAccountNotFound, err)
	case winErrorNoLogonServers, winErrorNoSuchDomain, winErrorTimeout,
		winRPCServerUnavailable, winRPCCallFailed, winRPCCallFailedDNE,
		winErrorTrustedDomainFailure, winErrorTrustedRelationFailure,
		winErrorNetlogonNotStarted, winErrorDCNotFound:
		return fmt.Errorf("%w: %v", errAccountDirectoryUnavailable, err)
	}
	return err
}
