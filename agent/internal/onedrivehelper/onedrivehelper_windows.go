//go:build windows

package onedrivehelper

import (
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

const (
	policyKeyPath    = `SOFTWARE\Policies\Microsoft\OneDrive`
	autoMountSubKey  = policyKeyPath + `\TenantAutoMount`
	accountKeySuffix = `SOFTWARE\Microsoft\OneDrive\Accounts\Business1`
	sentinelValue    = "BreezeOneDriveManaged"
)

// userSession is one active interactive session resolved to a SID + group set.
type userSession struct {
	sessionID uint32
	sid       string
	groupSIDs map[string]bool // uppercase SID strings from the user token
}

// Apply enforces base config in HKLM and per-user TenantAutoMount values in
// HKU\<SID>, then reads back device state. Additive-only: toggles turned off
// stop being enforced but are not scrubbed (unmount/revert is Sub-project B).
func Apply(cfg Config) (*DeviceState, error) {
	baseChanged, baseErr := applyBaseConfig(cfg)

	sessions := activeUserSessions()
	anyUserChanged := false
	var entitled []string
	var applied []LibraryRule
	for _, s := range sessions {
		isMember := func(groupName string) bool { return isTokenGroupMember(s, groupName) }
		apply, _ := PartitionLibraries(cfg.Libraries, isMember)
		changed, err := applyUserAutoMount(s.sid, apply)
		if err != nil {
			// One broken user hive must not stop the others.
			continue
		}
		if changed {
			anyUserChanged = true
			pokeAutoMountTimer(s.sid)
		}
		for _, r := range apply {
			if !containsString(entitled, r.LibraryID) {
				entitled = append(entitled, r.LibraryID)
				applied = append(applied, r)
			}
		}
	}

	state := readDeviceState(sessions, entitled, applied) // full reader lands in Task 9

	if (baseChanged || anyUserChanged) && cfg.Base.RestartOnChange {
		restartOneDrive(sessions)
	}
	return state, baseErr
}

func containsString(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

// applyBaseConfig writes the HKLM OneDrive policy values. Returns whether
// anything changed. Write-then-readback-verify per the winupdate pattern.
func applyBaseConfig(cfg Config) (bool, error) {
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, policyKeyPath, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return false, fmt.Errorf("open/create OneDrive policy key: %w", err)
	}
	defer k.Close()

	changed := false
	setDword := func(name string, want uint32) error {
		if got, _, e := k.GetIntegerValue(name); e == nil && uint32(got) == want {
			return nil // already correct
		}
		if e := k.SetDWordValue(name, want); e != nil {
			return fmt.Errorf("set %s: %w", name, e)
		}
		if got, _, e := k.GetIntegerValue(name); e != nil || uint32(got) != want {
			return fmt.Errorf("verify %s read-back: got %d (err %v)", name, got, e)
		}
		changed = true
		return nil
	}

	var firstErr error
	keep := func(e error) {
		if e != nil && firstErr == nil {
			firstErr = e
		}
	}

	// Ownership sentinel so a future revert can distinguish Breeze-written
	// enforcement from admin GPOs (winupdate pattern).
	keep(setDword(sentinelValue, 1))

	if cfg.Base.SilentAccountConfig {
		keep(setDword("SilentAccountConfig", 1))
	}
	if cfg.Base.FilesOnDemand {
		keep(setDword("FilesOnDemandEnabled", 1))
	}
	if cfg.Base.KfmSilentOptIn {
		tenantID := cfg.Base.TenantAssociationID
		if tenantID == "" && len(cfg.Libraries) > 0 {
			tenantID = TenantIDFromComposite(cfg.Libraries[0].LibraryID)
		}
		if tenantID != "" {
			if got, _, e := k.GetStringValue("KFMSilentOptIn"); e != nil || got != tenantID {
				if e := k.SetStringValue("KFMSilentOptIn", tenantID); e != nil {
					keep(fmt.Errorf("set KFMSilentOptIn: %w", e))
				} else if got, _, e := k.GetStringValue("KFMSilentOptIn"); e != nil || got != tenantID {
					keep(fmt.Errorf("verify KFMSilentOptIn read-back: got %q (err %v)", got, e))
				} else {
					changed = true
				}
			}
			// Per-folder opt-in selection (OneDrive 23.002+). 1 = include.
			folderSet := map[string]bool{}
			for _, f := range cfg.Base.KfmFolders {
				folderSet[f] = true
			}
			keep(setDword("KFMSilentOptInDesktop", boolToDword(folderSet["Desktop"])))
			keep(setDword("KFMSilentOptInDocuments", boolToDword(folderSet["Documents"])))
			keep(setDword("KFMSilentOptInPictures", boolToDword(folderSet["Pictures"])))
			if cfg.Base.KfmBlockOptOut {
				keep(setDword("KFMBlockOptOut", 1))
			}
		}
		// No tenant id resolvable → KFM silently skipped; surfaced via
		// kfmFolderStates="unknown" in the state reader rather than an error.
	}
	return changed, firstErr
}

func boolToDword(b bool) uint32 {
	if b {
		return 1
	}
	return 0
}

// applyUserAutoMount writes one TenantAutoMount value per applied rule under
// HKU\<SID>. Idempotent: skips values already correct. Additive-only: values
// for rules no longer delivered are left in place (v1 — see spec).
func applyUserAutoMount(sid string, rules []LibraryRule) (bool, error) {
	if len(rules) == 0 {
		return false, nil
	}
	path := sid + `\` + autoMountSubKey
	k, _, err := registry.CreateKey(registry.USERS, path, registry.SET_VALUE|registry.QUERY_VALUE)
	if err != nil {
		return false, fmt.Errorf("open/create HKU automount key for %s: %w", sid, err)
	}
	defer k.Close()

	changed := false
	for _, r := range rules {
		name := ValueName(r.LibraryID)
		if got, _, e := k.GetStringValue(name); e == nil && got == r.LibraryID {
			continue
		}
		if e := k.SetStringValue(name, r.LibraryID); e != nil {
			return changed, fmt.Errorf("set automount %s: %w", name, e)
		}
		changed = true
	}
	return changed, nil
}

// pokeAutoMountTimer forces OneDrive to process AutoMount promptly (it
// otherwise runs on an up-to-8h timer). Only possible when the user has a
// Business1 account key (i.e. is signed in); missing key is fine — OneDrive
// will process on sign-in.
func pokeAutoMountTimer(sid string) {
	k, err := registry.OpenKey(registry.USERS, sid+`\`+accountKeySuffix, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetQWordValue("TimerAutoMount", 1)
}

// activeUserSessions enumerates active WTS sessions and resolves each to a SID
// + token group set (WTSQueryUserToken → GetTokenUser/GetTokenGroups — same
// recipe as sessionbroker/spawn_process_windows.go and userhelper/sid_windows.go).
func activeUserSessions() []userSession {
	var pInfo *windows.WTS_SESSION_INFO
	var count uint32
	if err := windows.WTSEnumerateSessions(0, 0, 1, &pInfo, &count); err != nil {
		return nil
	}
	defer windows.WTSFreeMemory(uintptr(unsafe.Pointer(pInfo)))

	infos := unsafe.Slice(pInfo, count)
	var out []userSession
	for _, info := range infos {
		if info.State != windows.WTSActive {
			continue
		}
		var tok windows.Token
		if err := windows.WTSQueryUserToken(info.SessionID, &tok); err != nil {
			continue // no user token (e.g. services session)
		}
		s := userSession{sessionID: info.SessionID, groupSIDs: map[string]bool{}}
		if tu, err := tok.GetTokenUser(); err == nil {
			s.sid = tu.User.Sid.String()
		}
		if tg, err := tok.GetTokenGroups(); err == nil {
			for _, g := range tg.AllGroups() {
				s.groupSIDs[strings.ToUpper(g.Sid.String())] = true
			}
		}
		tok.Close()
		if s.sid != "" {
			out = append(out, s)
		}
	}
	return out
}

// isTokenGroupMember resolves a local/domain group name to a SID and checks the
// session token's group list. Unresolvable names are treated as non-member
// (fail closed).
func isTokenGroupMember(s userSession, groupName string) bool {
	sid, _, _, err := windows.LookupSID("", groupName)
	if err != nil {
		return false
	}
	return s.groupSIDs[strings.ToUpper(sid.String())]
}

// restartOneDrive best-effort kills + relaunches OneDrive in each session so
// policy/AutoMount changes take effect promptly. Errors are ignored: OneDrive
// also picks changes up on its own schedule.
func restartOneDrive(sessions []userSession) {
	machineExe := `C:\Program Files\Microsoft OneDrive\OneDrive.exe`
	for _, s := range sessions {
		_ = sessionbroker.SpawnProcessInSessionWithArgs(
			`C:\Windows\System32\taskkill.exe`, []string{"/f", "/im", "OneDrive.exe"}, s.sessionID)
		if _, err := os.Stat(machineExe); err == nil {
			_ = sessionbroker.SpawnProcessInSessionWithArgs(machineExe, []string{"/background"}, s.sessionID)
		} else {
			// Per-user install path; %LOCALAPPDATA% expands in the user's env
			// block inside the spawn's cmd wrapper.
			_ = sessionbroker.SpawnProcessInSessionWithArgs(
				`%LOCALAPPDATA%\Microsoft\OneDrive\OneDrive.exe`, []string{"/background"}, s.sessionID)
		}
	}
}

// readDeviceState — minimal placeholder until Task 9 replaces it with the full
// registry-backed reader. Reports entitlement only.
func readDeviceState(sessions []userSession, entitled []string, applied []LibraryRule) *DeviceState {
	return &DeviceState{
		KfmFolderStates:   map[string]string{},
		MountedLibraries:  []string{},
		EntitledLibraries: entitled,
		DriftEntries:      []DriftEntry{},
	}
}
