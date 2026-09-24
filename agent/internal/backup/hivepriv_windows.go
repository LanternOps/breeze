//go:build windows

package backup

import (
	"fmt"
	"sync"
)

// AcquireHivePrivileges enables SeBackupPrivilege and SeRestorePrivilege on
// the process token for the lifetime of the returned release. RegLoadKeyW
// and RegUnLoadKeyW fail with ERROR_PRIVILEGE_NOT_HELD unless BOTH are
// enabled, and SYSTEM holds them disabled by default. Built on the same
// ref-counted acquirePrivilege as the security-descriptor scopes, so a hive
// mount overlapping a restore never switches a privilege off underneath
// the other. All or nothing: if SeRestorePrivilege cannot be enabled,
// SeBackupPrivilege is released before the error returns. release is
// idempotent and never nil.
//
// The offline-hive editor (package winhive) does no privilege work itself;
// its callers (rebuild's WinSystem.LoadHive / UnloadStaleHives) hold this
// scope around the load and until after the unload.
func AcquireHivePrivileges() (release func(), err error) {
	return acquirePrivileges("SeBackupPrivilege", "SeRestorePrivilege")
}

// acquirePrivileges acquires every name in order, all or nothing (see
// AcquireHivePrivileges). The returned release drops them in reverse order.
func acquirePrivileges(names ...string) (release func(), err error) {
	var releases []func()
	releaseAll := func() {
		for i := len(releases) - 1; i >= 0; i-- {
			releases[i]()
		}
	}
	for _, name := range names {
		rel, err := acquirePrivilege(name)
		if err != nil {
			releaseAll()
			return func() {}, fmt.Errorf("enable %s: %w", name, err)
		}
		releases = append(releases, rel)
	}
	return sync.OnceFunc(releaseAll), nil
}
