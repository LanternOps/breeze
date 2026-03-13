package tools

import (
	"sync"

	"github.com/shirou/gopsutil/v3/process"
	"golang.org/x/sys/windows"
)

// sidCache maps SID string → resolved "DOMAIN\user" username.
// Populated lazily; survives across ListProcesses calls so repeated
// listings benefit from earlier lookups too.
var sidCache sync.Map

// resolveUsername extracts the process token SID (fast, local) and only
// calls the expensive LookupAccountSid when we encounter a new SID.
// On an AzureAD-joined machine with ~450 processes and ~4 unique users
// this turns ~450 slow network calls into ~4.
func resolveUsername(p *process.Process) string {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(p.Pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)

	var token windows.Token
	if err := windows.OpenProcessToken(handle, windows.TOKEN_QUERY, &token); err != nil {
		return ""
	}
	defer token.Close()

	tokenUser, err := token.GetTokenUser()
	if err != nil {
		return ""
	}

	sidStr := tokenUser.User.Sid.String()

	// Fast path: cached lookup.
	if cached, ok := sidCache.Load(sidStr); ok {
		return cached.(string)
	}

	// Slow path: LookupAccount (network call on AzureAD).
	account, domain, _, err := tokenUser.User.Sid.LookupAccount("")
	if err != nil {
		sidCache.Store(sidStr, "")
		return ""
	}

	username := domain + `\` + account
	sidCache.Store(sidStr, username)
	return username
}
