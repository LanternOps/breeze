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
	policyKeyPath   = `SOFTWARE\Policies\Microsoft\OneDrive`
	autoMountSubKey = policyKeyPath + `\TenantAutoMount`
	sentinelValue   = "BreezeOneDriveManaged"

	// maxBusinessAccounts is the number of OneDrive work-account slots we scan
	// (Business1..Business9). Accounts can be sparse after unlinking one, so
	// every slot must be checked — stopping at the first miss is not safe.
	maxBusinessAccounts = 9
)

// businessAccountKeyPath returns the HKU-relative key path for work-account
// slot n (1-based; OneDrive names these Business1..Business9).
func businessAccountKeyPath(n int) string {
	return fmt.Sprintf(`SOFTWARE\Microsoft\OneDrive\Accounts\Business%d`, n)
}

// userSession is one active interactive session resolved to a SID + group set.
type userSession struct {
	sessionID uint32
	sid       string
	groupSIDs map[string]bool // uppercase SID strings from the user token
}

// Apply enforces base config in HKLM and per-user TenantAutoMount values in
// HKU\<SID>, scrubs stale Breeze-* values for rules no longer entitled, then
// reads back device state.
func Apply(cfg Config) (*DeviceState, error) {
	baseChanged, baseErr := applyBaseConfig(cfg)
	errs := []error{baseErr}

	sessions := activeUserSessions()
	anyUserChanged := false
	var entitled []string
	var applied []LibraryRule
	for _, s := range sessions {
		isMember := func(groupName string) bool { return isTokenGroupMember(s, groupName) }
		upns := sessionUpns(s.sid)
		apply, _ := PartitionLibraries(cfg.Libraries, isMember, upns)
		written, changed, err := applyUserAutoMount(s.sid, apply)
		if err != nil {
			// One broken user hive must not stop the others — but any value
			// that failed to write/scrub must still surface (the heartbeat
			// caller logs Apply's returned error). Values that DID succeed
			// (written) are still counted below: reporting a library as
			// neither entitled nor drifted when it's actually sitting on
			// disk mounted is the fail-open edge this is fixing.
			errs = append(errs, fmt.Errorf("session %s: %w", s.sid, err))
		}
		if changed {
			anyUserChanged = true
			pokeAutoMountTimer(s.sid)
		}
		for _, r := range written {
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
// HKU\<SID>, then scrubs any Breeze-* value no longer in the desired set.
// Idempotent: skips values already correct. The scrub closes a fail-open
// edge: a value written for a previously-allowlisted user must not persist
// after the rule stops applying — a different, non-allowlisted user signing
// into the same Windows profile would otherwise inherit that mount.
//
// Returns the subset of rules whose values were confirmed written (already
// correct or freshly set) so a per-value failure doesn't hide the rules that
// DID succeed from entitlement/drift bookkeeping (Apply folds partial writes
// into the caller's returned error via errors.Join rather than discarding
// them).
func applyUserAutoMount(sid string, rules []LibraryRule) (written []LibraryRule, changed bool, err error) {
	path := sid + `\` + autoMountSubKey
	k, _, kerr := registry.CreateKey(registry.USERS, path, registry.SET_VALUE|registry.QUERY_VALUE)
	if kerr != nil {
		return nil, false, fmt.Errorf("open/create HKU automount key for %s: %w", sid, kerr)
	}
	defer k.Close()

	var errs []error
	desired := make([]string, 0, len(rules))
	for _, r := range rules {
		name := ValueName(r.LibraryID)
		desired = append(desired, name)
		if got, _, e := k.GetStringValue(name); e == nil && got == r.LibraryID {
			written = append(written, r)
			continue
		}
		if e := k.SetStringValue(name, r.LibraryID); e != nil {
			log.Warn("set automount value failed", "value", name, "error", e.Error())
			errs = append(errs, fmt.Errorf("set automount %s: %w", name, e))
			continue
		}
		changed = true
		written = append(written, r)
	}

	names, nerr := k.ReadValueNames(-1)
	if nerr != nil {
		errs = append(errs, fmt.Errorf("enumerate automount values for %s: %w", sid, nerr))
	} else {
		for _, stale := range StaleValueNames(names, desired) {
			if e := k.DeleteValue(stale); e != nil {
				log.Warn("delete stale automount value failed", "value", stale, "error", e.Error())
				errs = append(errs, fmt.Errorf("delete stale automount %s: %w", stale, e))
				continue
			}
			log.Info("removed stale automount value", "value", stale)
			changed = true
		}
	}

	return written, changed, errors.Join(errs...)
}

// pokeAutoMountTimer forces OneDrive to process AutoMount promptly (it
// otherwise runs on an up-to-8h timer). Only possible when the user has a
// Business1 account key (i.e. is signed in); missing key is fine — OneDrive
// will process on sign-in. Business1 specifically: any signed-in business
// account's OneDrive process serves the same AutoMount timer, so poking the
// primary slot is sufficient — no need to enumerate Business2..9 here.
func pokeAutoMountTimer(sid string) {
	k, err := registry.OpenKey(registry.USERS, sid+`\`+businessAccountKeyPath(1), registry.SET_VALUE)
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

// sessionUpns reads the signed-in user's UPNs across all of the session's
// OneDrive work-account slots (Business1..Business9 — OneDrive supports
// multiple linked work accounts, and slots can be sparse after unlinking one,
// so every slot is checked). Empty when the user isn't signed in to any
// OneDrive Business account or no value is readable — callers treat an empty
// slice as "cannot match graph_group rules" (fail closed).
func sessionUpns(sid string) []string {
	var upns []string
	for n := 1; n <= maxBusinessAccounts; n++ {
		k, err := registry.OpenKey(registry.USERS, sid+`\`+businessAccountKeyPath(n), registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		v, _, verr := k.GetStringValue("UserEmail")
		k.Close()
		if verr != nil || v == "" || len(v) > 320 {
			continue
		}
		if !containsFold(upns, v) {
			upns = append(upns, v)
		}
	}
	return upns
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
// rule (device-level row, per-user reality): signedIn/version/KFM come from
// the first session that has ANY signed-in business account (Business1
// preferred, else the first present Business2..9 slot for that session, kept
// simple rather than trying to merge version/KFM across accounts); mounted
// libraries and signedInUpns are the union of all business accounts across
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
		// Business1..Business9: accounts can be sparse after unlinking one, so
		// every slot must be checked for this session (stop-early is not
		// safe). accountKeyPaths collects the slots actually present, in
		// Business1..9 order, so accountKeyPaths[0] is Business1 if present,
		// else the first present secondary slot.
		var accountKeyPaths []string
		for n := 1; n <= maxBusinessAccounts; n++ {
			keyPath := businessAccountKeyPath(n)
			acct, err := registry.OpenKey(registry.USERS, s.sid+`\`+keyPath, registry.QUERY_VALUE)
			if err != nil {
				continue // this slot isn't signed in
			}
			state.SignedIn = true
			accountKeyPaths = append(accountKeyPaths, keyPath)
			// Cap at 16 entries and 320 chars per UPN to match the server-side zod
			// schema (schemas.ts signedInUpns) — a violating value drops the whole
			// UPN list server-side, so enforce the bounds here and make any
			// truncation visible instead of silently losing entries beyond the cap.
			if upn, _, e := acct.GetStringValue("UserEmail"); e == nil && upn != "" && len(upn) <= 320 && !containsFold(state.SignedInUpns, upn) {
				if len(state.SignedInUpns) < 16 {
					state.SignedInUpns = append(state.SignedInUpns, upn)
				} else {
					log.Warn("signed-in UPN cap reached; not reporting this account's UPN",
						"cap", 16, "sessionID", s.sessionID)
				}
			}
			acct.Close()
		}

		if len(accountKeyPaths) == 0 {
			continue // this user isn't signed in to any OneDrive Business account
		}
		primaryKeyPath := accountKeyPaths[0]

		if !primaryFound {
			primaryFound = true
			if acct, err := registry.OpenKey(registry.USERS, s.sid+`\`+primaryKeyPath, registry.QUERY_VALUE); err == nil {
				if v, _, e := acct.GetStringValue("OneDriveVersion"); e == nil {
					state.OneDriveVersion = v
				} else if k2, e2 := registry.OpenKey(registry.USERS, s.sid+`\SOFTWARE\Microsoft\OneDrive`, registry.QUERY_VALUE); e2 == nil {
					if v2, _, e3 := k2.GetStringValue("Version"); e3 == nil {
						state.OneDriveVersion = v2
					}
					k2.Close()
				}
				acct.Close()
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

		// Mounted scopes, read from this session's primary account slot:
		// Tenants\<TenantName> value names are local folder paths. The tenant
		// cache also lists the signed-in user's own personal OneDrive folder
		// (the account's UserFolder) alongside real SharePoint library mounts
		// — live spike validation (2026-06-19 doc; live-validated 2026-07-09)
		// confirmed every signed-in device was misreporting its personal
		// folder as a mounted library. Skip it explicitly.
		userFolder := ""
		if acct, err := registry.OpenKey(registry.USERS, s.sid+`\`+primaryKeyPath, registry.QUERY_VALUE); err == nil {
			userFolder, _, _ = acct.GetStringValue("UserFolder")
			acct.Close()
		}
		if tenants, e := registry.OpenKey(registry.USERS, s.sid+`\`+primaryKeyPath+`\Tenants`, registry.ENUMERATE_SUB_KEYS); e == nil {
			if subs, se := tenants.ReadSubKeyNames(-1); se == nil {
				for _, sub := range subs {
					if tk, te := registry.OpenKey(registry.USERS, s.sid+`\`+primaryKeyPath+`\Tenants\`+sub, registry.QUERY_VALUE); te == nil {
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
