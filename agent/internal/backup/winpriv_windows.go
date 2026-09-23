//go:build windows

package backup

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"

	"golang.org/x/sys/windows"
)

// hasSecurityPrivilege reports whether SeSecurityPrivilege is currently
// held ENABLED on behalf of at least one live enableCaptureSDPrivileges /
// enableRestoreSDPrivileges scope AND a real SACL read succeeded under it
// (probeSACL). Capture and apply only request the SACL while it is true —
// requesting SACL_SECURITY_INFORMATION / ACCESS_SYSTEM_SECURITY without the
// privilege fails the whole call. It is reset to false when the last such
// scope is released.
var hasSecurityPrivilege atomic.Bool

var procAdjustTokenPrivileges = modadvapi32.NewProc("AdjustTokenPrivileges")

// privRef is the per-privilege reference count behind acquirePrivilege.
// Privilege state lives on the PROCESS token, so two overlapping scopes (a
// backup walk and a restore in the same helper, or two restores) share one
// enabled bit: the first acquirer enables it, the last releaser disables it
// again — but only if it was disabled before the first acquirer touched it
// (enabledByUs), so a privilege something else had already enabled is never
// switched off underneath it.
type privRef struct {
	refs        int
	enabledByUs bool
}

const securityPrivName = "SeSecurityPrivilege"

var (
	privMu          sync.Mutex
	privRefs        = map[string]*privRef{}
	securityHolders int // live scopes whose SeSecurityPrivilege probe succeeded; guarded by privMu
	errPrivNotHeld  = errors.New("privilege not held by the process token")
)

// setPrivilege enables (or, with enable=false, disables) name on this
// process's own token and reports whether it was enabled beforehand. SYSTEM
// (the account the agent and its backup/restore helpers run as) holds
// every privilege but most DISABLED by default — Windows only evaluates
// ENABLED privileges during an access check.
//
// AdjustTokenPrivileges is called through the raw proc rather than x/sys's
// wrapper because the wrapper discards GetLastError on success, and
// ERROR_NOT_ALL_ASSIGNED (the token does not hold the privilege at all) is
// reported exactly that way: a nonzero return with a last-error.
func setPrivilege(name string, enable bool) (wasEnabled bool, err error) {
	var token windows.Token
	if err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_ADJUST_PRIVILEGES|windows.TOKEN_QUERY, &token); err != nil {
		return false, fmt.Errorf("open process token: %w", err)
	}
	defer func() { _ = token.Close() }()

	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return false, fmt.Errorf("encode privilege name %s: %w", name, err)
	}
	var luid windows.LUID
	if err := windows.LookupPrivilegeValue(nil, namePtr, &luid); err != nil {
		return false, fmt.Errorf("lookup privilege %s: %w", name, err)
	}
	var attrs uint32
	if enable {
		attrs = windows.SE_PRIVILEGE_ENABLED
	}
	newState := windows.Tokenprivileges{
		PrivilegeCount: 1,
		Privileges:     [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: attrs}},
	}
	var prev windows.Tokenprivileges
	var retLen uint32
	r1, _, callErr := procAdjustTokenPrivileges.Call(
		uintptr(token), 0, uintptr(unsafe.Pointer(&newState)),
		unsafe.Sizeof(prev), uintptr(unsafe.Pointer(&prev)), uintptr(unsafe.Pointer(&retLen)),
	)
	if r1 == 0 {
		return false, fmt.Errorf("adjust token privileges for %s: %w", name, callErr)
	}
	if errors.Is(callErr, windows.ERROR_NOT_ALL_ASSIGNED) {
		return false, fmt.Errorf("%s: %w", name, errPrivNotHeld)
	}
	// PreviousState lists only privileges whose state CHANGED; an empty
	// list means it was already in the requested state.
	if prev.PrivilegeCount == 0 {
		return enable, nil
	}
	return prev.Privileges[0].Attributes&windows.SE_PRIVILEGE_ENABLED != 0, nil
}

// acquirePrivilege enables name for the lifetime of the returned release
// (reference counted — see privRef). release is idempotent and restores the
// privilege to its pre-acquisition state once the last holder releases it.
func acquirePrivilege(name string) (release func(), err error) {
	privMu.Lock()
	defer privMu.Unlock()
	r := privRefs[name]
	if r == nil {
		r = &privRef{}
		privRefs[name] = r
	}
	if r.refs == 0 {
		was, err := setPrivilege(name, true)
		if err != nil {
			return func() {}, err
		}
		r.enabledByUs = !was
	}
	r.refs++
	return sync.OnceFunc(func() {
		privMu.Lock()
		defer privMu.Unlock()
		r.refs--
		if r.refs == 0 && r.enabledByUs {
			if _, err := setPrivilege(name, false); err != nil {
				log.Warn("failed to disable privilege after use", "privilege", name, "error", err.Error())
			}
			r.enabledByUs = false
		}
	}), nil
}

// acquireSDPrivileges enables every privilege in names plus
// SeSecurityPrivilege, best effort (a privilege the token lacks only means
// less fidelity, never a failed run), and returns one release that undoes
// all of them and drops hasSecurityPrivilege when no scope still holds it.
func acquireSDPrivileges(names ...string) (release func()) {
	var releases []func()
	for _, name := range names {
		rel, err := acquirePrivilege(name)
		if err != nil {
			log.Debug("privilege unavailable for security-descriptor handling", "privilege", name, "error", err.Error())
			continue
		}
		releases = append(releases, rel)
	}
	securityOK := false
	if rel, err := acquirePrivilege(securityPrivName); err == nil {
		releases = append(releases, rel)
		if probeSACL() {
			securityOK = true
			privMu.Lock()
			securityHolders++
			hasSecurityPrivilege.Store(true)
			privMu.Unlock()
		}
	} else {
		log.Debug("SACL capture/apply unavailable", "privilege", securityPrivName, "error", err.Error())
	}
	return sync.OnceFunc(func() {
		if securityOK {
			privMu.Lock()
			securityHolders--
			if securityHolders == 0 {
				hasSecurityPrivilege.Store(false)
			}
			privMu.Unlock()
		}
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
	})
}

// enableCaptureSDPrivileges enables SeBackupPrivilege (read any file's
// descriptor regardless of its DACL, via FILE_FLAG_BACKUP_SEMANTICS) and
// SeSecurityPrivilege (the SACL) for the duration of one capture walk.
// Callers must `defer release()` — the privileges are never left enabled
// for the rest of the helper's life.
func enableCaptureSDPrivileges() (release func()) {
	return acquireSDPrivileges("SeBackupPrivilege")
}

// enableRestoreSDPrivileges enables SeRestorePrivilege (set any owner, and
// WRITE_DAC/WRITE_OWNER regardless of the target's DACL via
// FILE_FLAG_BACKUP_SEMANTICS), SeTakeOwnershipPrivilege and
// SeSecurityPrivilege (write the SACL) for the duration of one restore.
// Without them applySecurity fails and the restore records a
// reduced-fidelity warning per entry (R39). Callers must `defer release()`.
func enableRestoreSDPrivileges() (release func()) {
	return acquireSDPrivileges("SeRestorePrivilege", "SeTakeOwnershipPrivilege")
}

// probeSACL reports whether this process can really read a SACL right now:
// opening the Windows directory for ACCESS_SYSTEM_SECURITY fails with
// ERROR_PRIVILEGE_NOT_HELD unless SeSecurityPrivilege is enabled.
func probeSACL() bool {
	root, err := windows.GetSystemWindowsDirectory()
	if err != nil {
		return false
	}
	h, err := openNoFollow(root, windows.ACCESS_SYSTEM_SECURITY)
	if err != nil {
		return false
	}
	_ = windows.CloseHandle(h)
	return true
}
