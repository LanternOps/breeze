//go:build windows

package onedrivehelper

import (
	"errors"
	"fmt"
	"os"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/breeze-rmm/agent/internal/logging"
	"github.com/breeze-rmm/agent/internal/sessionbroker"
)

var log = logging.L("onedrivehelper")

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
	errs := []error{baseErr}

	sessions := activeUserSessions()
	anyUserChanged := false
	var entitled []string
	var applied []LibraryRule
	for _, s := range sessions {
		isMember := func(groupName string) bool { return isTokenGroupMember(s, groupName) }
		upn := sessionUpn(s.sid)
		apply, _ := PartitionLibraries(cfg.Libraries, isMember, upn)
		changed, err := applyUserAutoMount(s.sid, apply)
		if err != nil {
			// One broken user hive must not stop the others — but a hive that
			// can't be written means that user's libraries silently never
			// mount, so the failure must still surface (the heartbeat caller
			// logs Apply's returned error).
			errs = append(errs, fmt.Errorf("session %s: %w", s.sid, err))
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

	state := readDeviceState(sessions, entitled, applied)

	if (baseChanged || anyUserChanged) && cfg.Base.RestartOnChange {
		restartOneDrive(sessions)
	}
	return state, errors.Join(errs...)
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

// sessionUpn reads the signed-in user's UPN from the session's own OneDrive
// account key. Empty when the user isn't signed in to OneDrive Business or the
// value is unreadable — callers treat empty as "cannot match graph_group rules"
// (fail closed).
func sessionUpn(sid string) string {
	k, err := registry.OpenKey(registry.USERS, sid+`\`+accountKeySuffix, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, err := k.GetStringValue("UserEmail")
	if err != nil {
		return ""
	}
	return v
}

// restartOneDrive best-effort kills + relaunches OneDrive in each session so
// policy/AutoMount changes take effect promptly. Confirmed-path-first: for
// each session we resolve a launchable, absolute OneDrive.exe path (machine
// install, else the user's real per-user install resolved via their HKU
// Volatile Environment) BEFORE ever taskkilling. SpawnProcessInSessionWithArgs
// passes filepath.Dir(binaryPath) as CreateProcessAsUser's lpCurrentDirectory,
// so an unexpanded literal like `%LOCALAPPDATA%\...` can never resolve — that
// would kill OneDrive with no way to bring it back. If no launchable path is
// found for a session, we skip that session's taskkill entirely: failure mode
// is "no restart", never "killed and not restarted". Errors from the spawn
// itself are ignored: OneDrive also picks changes up on its own schedule.
func restartOneDrive(sessions []userSession) {
	machineExe := `C:\Program Files\Microsoft OneDrive\OneDrive.exe`
	machineExeOK := false
	if _, err := os.Stat(machineExe); err == nil {
		machineExeOK = true
	}
	for _, s := range sessions {
		exe := ""
		if machineExeOK {
			exe = machineExe
		} else if userExe := resolveUserOneDriveExe(s.sid); userExe != "" {
			exe = userExe
		}
		if exe == "" {
			// No confirmed launch path for this session: never kill without a
			// way to relaunch.
			continue
		}
		_ = sessionbroker.SpawnProcessInSessionWithArgs(
			`C:\Windows\System32\taskkill.exe`, []string{"/f", "/im", "OneDrive.exe"}, s.sessionID)
		_ = sessionbroker.SpawnProcessInSessionWithArgs(exe, []string{"/background"}, s.sessionID)
	}
}

// resolveUserOneDriveExe resolves the per-user OneDrive.exe path for sid by
// reading the user's real LocalAppData out of their HKU\<SID>\Volatile
// Environment values (populated by the OS at logon), then stat-ing the
// resulting path. Returns "" if the environment values or the exe itself
// can't be resolved/confirmed.
func resolveUserOneDriveExe(sid string) string {
	k, err := registry.OpenKey(registry.USERS, sid+`\Volatile Environment`, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()

	localAppData, _, err := k.GetStringValue("LOCALAPPDATA")
	if err != nil || localAppData == "" {
		userProfile, _, err := k.GetStringValue("USERPROFILE")
		if err != nil || userProfile == "" {
			return ""
		}
		localAppData = userProfile + `\AppData\Local`
	}

	exe := localAppData + `\Microsoft\OneDrive\OneDrive.exe`
	if _, err := os.Stat(exe); err != nil {
		return ""
	}
	return exe
}

// shellFolderValues maps the KFM folder names we manage to their
// "User Shell Folders" registry value names.
var shellFolderValues = map[string]string{
	"Desktop":   "Desktop",
	"Documents": "Personal",
	"Pictures":  "My Pictures",
}

// readDeviceState reads OneDrive state across the active sessions. Flattening
// rule (device-level row, per-user reality): signedIn/version/KFM come from the
// first signed-in session; mounted libraries and signedInUpns are the union of
// all sessions (UPNs deduped case-insensitively, capped at 16).
func readDeviceState(sessions []userSession, entitled []string, applied []LibraryRule) *DeviceState {
	if entitled == nil {
		entitled = []string{}
	}
	state := &DeviceState{
		KfmFolderStates:   map[string]string{},
		MountedLibraries:  []string{},
		EntitledLibraries: entitled,
		DriftEntries:      []DriftEntry{},
		SignedInUpns:      []string{},
	}

	// FOD reflects the policy we enforce (HKLM read-back).
	if k, err := registry.OpenKey(registry.LOCAL_MACHINE, policyKeyPath, registry.QUERY_VALUE); err == nil {
		if v, _, e := k.GetIntegerValue("FilesOnDemandEnabled"); e == nil && v == 1 {
			state.FilesOnDemandOn = true
		}
		k.Close()
	}

	primaryFound := false
	for _, s := range sessions {
		acct, err := registry.OpenKey(registry.USERS, s.sid+`\`+accountKeySuffix, registry.QUERY_VALUE)
		if err != nil {
			continue // this user isn't signed in to OneDrive Business
		}
		state.SignedIn = true
		// Cap at 16 entries and 320 chars per UPN to match the server-side zod
		// schema (schemas.ts signedInUpns) — a violating value drops the whole
		// UPN list server-side, so enforce the bounds here and make any
		// truncation visible instead of silently losing sessions 17+.
		if upn, _, e := acct.GetStringValue("UserEmail"); e == nil && upn != "" && len(upn) <= 320 && !containsFold(state.SignedInUpns, upn) {
			if len(state.SignedInUpns) < 16 {
				state.SignedInUpns = append(state.SignedInUpns, upn)
			} else {
				log.Warn("signed-in UPN cap reached; not reporting this session's UPN",
					"cap", 16, "sessionID", s.sessionID)
			}
		}
		if !primaryFound {
			primaryFound = true
			if v, _, e := acct.GetStringValue("OneDriveVersion"); e == nil {
				state.OneDriveVersion = v
			} else if k2, e2 := registry.OpenKey(registry.USERS, s.sid+`\SOFTWARE\Microsoft\OneDrive`, registry.QUERY_VALUE); e2 == nil {
				if v2, _, e3 := k2.GetStringValue("Version"); e3 == nil {
					state.OneDriveVersion = v2
				}
				k2.Close()
			}
			// KFM redirection per managed folder, from User Shell Folders.
			if usf, e := registry.OpenKey(registry.USERS,
				s.sid+`\SOFTWARE\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders`,
				registry.QUERY_VALUE); e == nil {
				for folder, valueName := range shellFolderValues {
					raw, _, re := usf.GetStringValue(valueName)
					if re != nil {
						state.KfmFolderStates[folder] = "unknown"
						continue
					}
					state.KfmFolderStates[folder] = FolderRedirectionState(raw)
				}
				usf.Close()
			} else {
				// Whole key failed to open: every managed folder is explicitly
				// unknown rather than silently missing from the map.
				for folder := range shellFolderValues {
					state.KfmFolderStates[folder] = "unknown"
				}
			}
		}

		// Personal OneDrive folder for this account, read before acct.Close() so
		// we can exclude it below when collecting Tenants value names.
		userFolder, _, _ := acct.GetStringValue("UserFolder")
		acct.Close()

		// Mounted scopes: Tenants\<TenantName> value names are local folder paths.
		// The tenant cache also lists the signed-in user's own personal OneDrive
		// folder (Business1's UserFolder) alongside real SharePoint library
		// mounts — live spike validation (2026-06-19 doc; live-validated
		// 2026-07-09) confirmed every signed-in device was misreporting its
		// personal folder as a mounted library. Skip it explicitly.
		if tenants, e := registry.OpenKey(registry.USERS, s.sid+`\`+accountKeySuffix+`\Tenants`, registry.ENUMERATE_SUB_KEYS); e == nil {
			if subs, se := tenants.ReadSubKeyNames(-1); se == nil {
				for _, sub := range subs {
					if tk, te := registry.OpenKey(registry.USERS, s.sid+`\`+accountKeySuffix+`\Tenants\`+sub, registry.QUERY_VALUE); te == nil {
						if names, ne := tk.ReadValueNames(-1); ne == nil {
							for _, n := range names {
								if userFolder != "" && strings.EqualFold(n, userFolder) {
									continue
								}
								if !containsString(state.MountedLibraries, n) {
									state.MountedLibraries = append(state.MountedLibraries, n)
								}
							}
						}
						tk.Close()
					}
				}
			}
			tenants.Close()
		}
	}

	state.DriftEntries = ComputeDrift(applied, state.MountedLibraries)
	return state
}
