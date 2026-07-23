//go:build !windows

package tools

import (
	"os"
	"os/user"
	"strconv"
	"sync"
	"syscall"
)

// uidNameCache memoizes uid -> username resolution for the lifetime of the
// process. A filesystem scan touches millions of files but only a handful of
// distinct UIDs; without this, getFileOwner issued a fresh user.LookupId
// (getpwuid_r via cgo/NSS — can reach files, sss, LDAP) per file. The cache
// collapses that to one lookup per distinct UID.
var uidNameCache sync.Map // map[uint32]string

func getFileOwner(info os.FileInfo) string {
	if info == nil || info.Sys() == nil {
		return ""
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return ""
	}

	if cached, ok := uidNameCache.Load(stat.Uid); ok {
		return cached.(string)
	}

	uid := strconv.FormatUint(uint64(stat.Uid), 10)
	usr, err := user.LookupId(uid)
	if err != nil {
		// Only successful resolutions are cached. A transient NSS/SSSD/LDAP
		// failure must not pin this uid to its numeric fallback for the whole
		// process lifetime — return the fallback but let the next file retry.
		return uid
	}
	uidNameCache.Store(stat.Uid, usr.Username)
	return usr.Username
}
