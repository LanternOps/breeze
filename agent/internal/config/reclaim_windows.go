//go:build windows

package config

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// reclaimConfigFiles are the files whose contents the agent loads as its
// configuration and identity, with the descriptor each gets.
var reclaimConfigFiles = map[string]string{
	"agent.yaml":   windowsConfigFileSDDL,
	"secrets.yaml": windowsSecretFileSDDL,
}

// reclaimConfigFileNames is reclaimConfigFiles' keys in a fixed order.
var reclaimConfigFileNames = []string{"agent.yaml", "secrets.yaml"}

// Seams for tests.
var (
	secureConfigRootFn    = secureMainAgentConfigDir
	createConfigRootDirFn = createMainAgentDirectory
)

// reclaimOwnerSDDL makes applyWindowsDACL also set the owner to SYSTEM (with
// its SeRestorePrivilege retry and Administrators fallback).
const reclaimOwnerSDDL = `O:SYG:SY`

var (
	procNetUserGetLocalGroups = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserGetLocalGroups")
	procNetUserModalsGet      = windows.NewLazySystemDLL("netapi32.dll").NewProc("NetUserModalsGet")
)

const (
	lgIncludeIndirect  = 0x1
	maxPreferredLength = 0xFFFFFFFF
)

// localAccountDomainSID is this machine's account domain SID (the prefix of
// every local user's SID), or "" if it could not be read.
var localAccountDomainSID = sync.OnceValue(func() string {
	// USER_MODALS_INFO_2: { LPWSTR usrmod2_domain_name; PSID usrmod2_domain_id; }
	var buf *byte
	r, _, _ := procNetUserModalsGet.Call(0, 2, uintptr(unsafe.Pointer(&buf)))
	if r != 0 || buf == nil {
		return ""
	}
	defer func() { _ = windows.NetApiBufferFree(buf) }()
	info := (*struct {
		name *uint16
		sid  *windows.SID
	})(unsafe.Pointer(buf))
	if info.sid == nil {
		return ""
	}
	return info.sid.String()
})

// lookupNeedsNoDomain reports whether a failed lookup of sid is a definite
// answer: a local account, or any SID that is not a domain account (those
// resolve on this machine without a domain controller).
func lookupNeedsNoDomain(sid string) bool {
	if !strings.HasPrefix(sid, "S-1-5-21-") {
		return true
	}
	domain := localAccountDomainSID()
	if domain == "" {
		return false
	}
	rest, ok := strings.CutPrefix(sid, domain+"-")
	return ok && !strings.Contains(rest, "-")
}

// adminGroupMember reports whether the account sid names is a member of the
// local Administrators group, directly or through a group (a domain group
// nested in it). Only user accounts are looked up. A SID that names no
// account, where that answer needs no domain controller, returns
// errAccountNotFound; other failures return an error (undecided).
func adminGroupMember(sidString string) (bool, error) {
	sid, err := windows.StringToSid(sidString)
	if err != nil {
		return false, fmt.Errorf("parse owner SID %s: %w", sidString, err)
	}
	account, domain, use, err := sid.LookupAccount("")
	if err != nil {
		if errors.Is(err, windows.ERROR_NONE_MAPPED) && lookupNeedsNoDomain(sidString) {
			return false, fmt.Errorf("%s: %w", sidString, errAccountNotFound)
		}
		return false, fmt.Errorf("look up owner %s: %w", sidString, err)
	}
	if use != windows.SidTypeUser {
		return false, nil
	}
	admins, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil {
		return false, err
	}
	adminsName, _, _, err := admins.LookupAccount("")
	if err != nil {
		return false, fmt.Errorf("look up the Administrators group name: %w", err)
	}
	user16, err := windows.UTF16PtrFromString(domain + `\` + account)
	if err != nil {
		return false, err
	}
	var buf *byte
	var read, total uint32
	r, _, _ := procNetUserGetLocalGroups.Call(0, uintptr(unsafe.Pointer(user16)), 0, lgIncludeIndirect,
		uintptr(unsafe.Pointer(&buf)), maxPreferredLength, uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)))
	if buf != nil {
		defer func() { _ = windows.NetApiBufferFree(buf) }()
	}
	if r != 0 {
		return false, fmt.Errorf("list local groups of %s\\%s: %w", domain, account, syscall.Errno(r))
	}
	// LOCALGROUP_USERS_INFO_0 is a single LPWSTR.
	names := unsafe.Slice((**uint16)(unsafe.Pointer(buf)), read)
	for _, n := range names {
		if strings.EqualFold(windows.UTF16PtrToString(n), adminsName) {
			return true, nil
		}
	}
	return false, nil
}

// The data dir is inside the config dir on Windows.
func reclaimSeparateDataDir() error { return nil }

// openConfigObject opens path without following a link at it, for reading
// (a folder: for its attributes and security only). A missing path returns an
// error matching os.ErrNotExist.
func openConfigObject(path string, dir bool) (windows.Handle, error) {
	p16, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return windows.InvalidHandle, err
	}
	access := uint32(windows.GENERIC_READ)
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	if dir {
		access = windows.READ_CONTROL | windows.FILE_READ_ATTRIBUTES
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	h, err := windows.CreateFile(p16, access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		if errors.Is(err, windows.ERROR_FILE_NOT_FOUND) || errors.Is(err, windows.ERROR_PATH_NOT_FOUND) {
			return windows.InvalidHandle, fmt.Errorf("%s: %w", path, os.ErrNotExist)
		}
		if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
			// The agent's own config never denies SYSTEM or Administrators.
			return windows.InvalidHandle, fmt.Errorf("%w: %s cannot be opened by the agent (its permissions deny it): %w", ErrConfigDirUntrusted, path, err)
		}
		return windows.InvalidHandle, fmt.Errorf("open %s: %w", path, err)
	}
	return h, nil
}

// configObjectState is what the trust check needs about an open handle.
type configObjectState struct {
	sec   programDataPathSecurity
	dir   bool
	links uint32
}

// inspectConfigHandle reads the attributes, link count, owner and DACL of
// the object h refers to, from h itself. Any reparse point counts as a link.
func inspectConfigHandle(h windows.Handle, path string) (configObjectState, error) {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(h, &info); err != nil {
		return configObjectState{}, fmt.Errorf("inspect %s: %w", path, err)
	}
	st := configObjectState{
		sec:   programDataPathSecurity{Exists: true},
		dir:   info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0,
		links: info.NumberOfLinks,
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		st.sec.Reparse, st.sec.NameSurrogate = true, true
		return st, nil
	}
	sd, err := windows.GetSecurityInfo(h, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return configObjectState{}, fmt.Errorf("get security info on %s: %w", path, err)
	}
	if err := parseProgramDataSecurity(sd, path, &st.sec); err != nil {
		return configObjectState{}, err
	}
	return st, nil
}

// checkConfigFileState applies checkConfigObjectTrust to a config file and
// requires a regular file with no other hard link (a hard link could make
// the agent read, or copy into a readable config, some other file).
func checkConfigFileState(path string, st configObjectState) error {
	if st.dir {
		return fmt.Errorf("%w: %s is not a regular file", ErrConfigDirUntrusted, path)
	}
	if !st.sec.Reparse && st.links != 1 {
		return fmt.Errorf("%w: %s has other hard links", ErrConfigDirUntrusted, path)
	}
	return checkConfigObjectTrust(path, st.sec)
}

// openTrustedConfigFile opens path without following links and checks it
// through the handle (checkConfigFileState). On success the caller owns the
// returned file and reads from it what was checked.
func openTrustedConfigFile(path string) (*os.File, error) {
	h, err := openConfigObject(path, false)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(h), path)
	st, err := inspectConfigHandle(h, path)
	if err == nil {
		err = checkConfigFileState(path, st)
	}
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return f, nil
}

// readTrustedMachineConfigFile: see readTrustedMachineConfigFileFn. The
// folder must pass checkConfigObjectTrust too: a file is only as safe as the
// folder that holds it.
func readTrustedMachineConfigFile(path string) ([]byte, error) {
	dir := filepath.Dir(path)
	dh, err := openConfigObject(dir, true)
	if err != nil {
		return nil, err
	}
	dst, err := inspectConfigHandle(dh, dir)
	_ = windows.CloseHandle(dh)
	if err != nil {
		return nil, err
	}
	if !dst.dir && !dst.sec.Reparse {
		return nil, fmt.Errorf("%w: %s is not a folder", ErrConfigDirUntrusted, dir)
	}
	if err := checkConfigObjectTrust(dir, dst.sec); err != nil {
		return nil, fmt.Errorf("refusing to read %s: %w", path, err)
	}
	f, err := openTrustedConfigFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, err
		}
		return nil, fmt.Errorf("refusing to read %s: %w", path, err)
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(f)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	return data, nil
}

// reclaimConfigDir: see ReclaimConfigDir. On Windows, taking a folder back in
// place is not enough: access is checked when a handle is opened, so a
// process that opened the folder for writing while another account owned it
// keeps that access after the owner and DACL change, and could add, rename or
// replace entries behind any check. When another account owned the folder,
// one of the agent's own entries in it (reclaimAgentEntries) or a link among
// them, the agent therefore replaces the folder: it builds a new one with its
// own descriptor, carries over only the config files it can trust, and
// renames the old one aside to <folder>.untrusted-<time>. Handles into the
// old folder then reach the set-aside copy, never the agent's.
//
// Otherwise the folder is the agent's: it is hardened through its handle, a
// config file that fails the trust check (another owner, or a DACL that lets
// another account write it) is set aside on its own, unread, into
// <folder>.untrusted-<time>, and so is any other entry another account owns.
//
// An owner whose administrator membership cannot be checked (the domain is
// unreachable, or the lookup is too slow) is never treated as untrusted: the
// agent changes nothing and returns an error, and decides on its next start.
func reclaimConfigDir(root string, forEnroll bool) error {
	if _, err := os.Lstat(root); os.IsNotExist(err) {
		return nil
	} else if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	rootSec, err := readEntrySecurity(root)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	if rootSec.Reparse {
		return fmt.Errorf("%w: %s is a link or reparse point; remove it and install the agent again", ErrConfigDirUntrusted, root)
	}

	// The folder alone may already decide it (another owner, or a DACL that
	// keeps the agent from inspecting it); its contents need not, and may
	// not, be listable then.
	evidence, foreign, err := replaceEvidence(rootSec, nil)
	if err != nil {
		return err
	}
	if evidence == "" {
		entries, err := readReclaimEntries(root)
		switch {
		case errors.Is(err, windows.ERROR_ACCESS_DENIED):
			evidence = "the folder's contents cannot be listed by the agent"
		case err != nil:
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		default:
			if evidence, foreign, err = replaceEvidence(rootSec, entries); err != nil {
				return err
			}
		}
	}
	if evidence != "" {
		log.Warn("The agent config folder was created or changed by another account; replacing it", "dir", root, "evidence", evidence)
		if err := replaceConfigRoot(root, forEnroll); err != nil {
			if errors.Is(err, ErrConfigDirUntrusted) {
				return err
			}
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		return nil
	}

	// The agent's own folder: harden it through its handle (as the
	// instance guard does on every start), then decide on each config file
	// from its handle before changing anything.
	if err := secureConfigRootFn(root); err != nil {
		return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
	}
	type fileDecision struct {
		name, why string
		resecure  bool
	}
	var decisions []fileDecision
	for _, name := range reclaimConfigFileNames {
		p := filepath.Join(root, name)
		f, err := openTrustedConfigFile(p)
		switch {
		case errors.Is(err, os.ErrNotExist):
			continue
		case errors.Is(err, errConfigOwnerUnverified):
			return err
		case errors.Is(err, ErrConfigDirUntrusted):
			decisions = append(decisions, fileDecision{name: name, why: err.Error()})
			continue
		case err != nil:
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		st, err := inspectConfigHandle(windows.Handle(f.Fd()), p)
		_ = f.Close()
		if err != nil {
			return fmt.Errorf("%w: %v", ErrConfigDirUntrusted, err)
		}
		// Trusted, but owned by an administrator's own account or carrying
		// extra entries of that owner: give it the agent's owner and DACL,
		// so later loads need no account lookup.
		if checkProgramDataObject(p, st.sec) != nil {
			decisions = append(decisions, fileDecision{name: name, resecure: true})
		}
	}

	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	aside := root + ".untrusted-" + stamp
	asideReady := false
	setAside := func(name string) error {
		if !asideReady {
			if err := createConfigRootDirFn(aside, windowsConfigDirCreateSDDL); err != nil {
				return fmt.Errorf("create %s: %w", aside, err)
			}
			asideReady = true
		}
		return renameEntry(filepath.Join(root, name), filepath.Join(aside, name))
	}
	for _, d := range decisions {
		p := filepath.Join(root, d.name)
		if d.resecure {
			log.Warn("Re-securing an agent config file (SYSTEM owner, the agent's DACL)", "path", p)
			if err := applyWindowsDACL(p, reclaimOwnerSDDL+reclaimConfigFiles[d.name]); err != nil {
				return fmt.Errorf("%w: re-secure %s: %v", ErrConfigDirUntrusted, p, err)
			}
			continue
		}
		if forEnroll {
			log.Warn("Setting aside a config file another account could have written; enrollment writes a new one", "file", d.name, "reason", d.why, "keptIn", aside)
		} else {
			log.Warn("Setting aside a config file another account could have written; the agent starts unenrolled", "file", d.name, "reason", d.why, "keptIn", aside)
		}
		if err := setAside(d.name); err != nil {
			return fmt.Errorf("%w: set aside %s: %v", ErrConfigDirUntrusted, p, err)
		}
	}
	for _, name := range foreign {
		log.Warn("Setting aside an entry another account put in the agent config folder", "entry", name, "keptIn", aside)
		if err := setAside(name); err != nil {
			return fmt.Errorf("%w: set aside %s: %v", ErrConfigDirUntrusted, filepath.Join(root, name), err)
		}
	}
	return nil
}

// readReclaimEntries reads, without following links, the security of every
// entry directly in root.
func readReclaimEntries(root string) (map[string]programDataPathSecurity, error) {
	list, err := os.ReadDir(root)
	if err != nil {
		return nil, fmt.Errorf("list %s: %w", root, err)
	}
	entries := make(map[string]programDataPathSecurity, len(list))
	for _, e := range list {
		sec, err := readEntrySecurity(filepath.Join(root, e.Name()))
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				continue
			}
			return nil, err
		}
		entries[e.Name()] = sec
	}
	return entries, nil
}

// replaceConfigRoot builds a new folder next to root, carries over the
// config files the agent can trust, then moves root aside and the new folder
// into its place (swapConfigRootIntoPlace). Any failure before the swap
// leaves root where it is and returns an error, so the agent does not start
// on it.
func replaceConfigRoot(root string, forEnroll bool) error {
	stamp := time.Now().UTC().Format("20060102T150405.000000000Z")
	staging := root + ".new-" + stamp
	aside := root + ".untrusted-" + stamp

	if err := createConfigRootDirFn(staging, windowsConfigDirCreateSDDL); err != nil {
		return fmt.Errorf("create %s: %w", staging, err)
	}
	cleanup := func() { _ = os.RemoveAll(staging) }

	names := append([]string(nil), reclaimConfigFileNames...)
	sort.Strings(names)
	for _, name := range names {
		carried, why, err := carryConfigFile(filepath.Join(root, name), filepath.Join(staging, name), reclaimConfigFiles[name])
		if err != nil {
			cleanup()
			return err
		}
		if !carried && why != "" {
			if forEnroll {
				log.Warn("Not carrying over a config file another account could have written; enrollment writes a new one", "file", name, "reason", why, "keptIn", aside)
			} else {
				log.Warn("Not adopting a config file another account could have written; the agent starts unenrolled", "file", name, "reason", why, "keptIn", aside)
			}
		}
	}

	// The first move fails while a process holds the old folder, or anything
	// in it, open without delete sharing: the agent then does not start,
	// rather than run in a folder that process can still change.
	// renameEntry never changes security: a refusal (a file in the folder
	// held open) leaves the folder exactly as it was, and only a folder whose
	// own DACL keeps the agent out is moved with backup intent.
	keepStaging, err := swapConfigRootIntoPlace(root, staging, aside, renameEntry, func(p string) bool {
		_, err := os.Lstat(p)
		return err == nil
	})
	if err != nil {
		if !keepStaging {
			cleanup()
		} else {
			log.Error("Could not finish replacing the agent config folder", "dir", root, "error", err.Error())
		}
		return err
	}
	if err := secureConfigRootFn(root); err != nil {
		return err
	}
	log.Warn("Replaced the agent config folder; the old one is kept for review", "dir", root, "keptIn", aside)
	return nil
}

// carryConfigFile copies src to dst with sddl when src passes the trust
// check through the handle it is read from (openTrustedConfigFile: owner,
// DACL, not a link, one hard link). It reports whether it copied, and if not,
// why ("" when src does not exist); an entry it cannot open or check is not
// carried. An owner that cannot be checked returns an error, so the whole
// replace waits for the next start rather than drop a config that may be the
// agent's.
func carryConfigFile(src, dst, sddl string) (bool, string, error) {
	f, err := openTrustedConfigFile(src)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return false, "", nil
	case errors.Is(err, errConfigOwnerUnverified):
		return false, "", err
	case err != nil:
		// Untrusted, or not openable as a file at all (a folder by that
		// name, a DACL that denies the agent): not carried. It stays in the
		// set-aside folder; failing here would fail every start on it.
		return false, err.Error(), nil
	}
	defer func() { _ = f.Close() }()
	data, err := io.ReadAll(f)
	if err != nil {
		return false, "", fmt.Errorf("read %s: %w", src, err)
	}
	if err := atomicWriteFile(dst, data, 0o600); err != nil {
		return false, "", fmt.Errorf("write %s: %w", dst, err)
	}
	if err := applyWindowsDACL(dst, sddl); err != nil {
		return false, "", fmt.Errorf("secure %s: %w", dst, err)
	}
	return true, "", nil
}

// readEntrySecurity is readProgramDataPathSecurity for an entry the agent is
// deciding about: one whose DACL keeps this process (SYSTEM, or an elevated
// administrator) from reading its owner and DACL is reported Unreadable, not
// as an error. The agent's own entries never deny SYSTEM or Administrators,
// so such an entry is another account's and is set aside or replaced.
func readEntrySecurity(path string) (programDataPathSecurity, error) {
	sec, err := readProgramDataPathSecurity(path)
	if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return programDataPathSecurity{Exists: true, Unreadable: true}, nil
	}
	return sec, err
}

// renameEntry moves from to to. If the entry's own DACL denies the move
// (another account set it to deny SYSTEM and Administrators, and the parent
// does not grant delete-child), it is moved again through a handle opened
// with backup intent (SeRestorePrivilege grants DELETE then), which leaves
// its owner and DACL exactly as they were. Any other failure — a folder that
// holds an open file, say — is returned as is, with nothing changed.
func renameEntry(from, to string) error {
	err := os.Rename(from, to)
	if err == nil || !errors.Is(err, windows.ERROR_ACCESS_DENIED) {
		return err
	}
	if sec, serr := readEntrySecurity(from); serr != nil || !sec.Unreadable {
		return err
	}
	if rerr := renameWithBackupIntent(from, to); rerr != nil {
		return fmt.Errorf("%w (moving it with backup intent: %v)", err, rerr)
	}
	log.Warn("Moved aside an entry whose permissions deny the agent, leaving them unchanged", "path", from, "to", to)
	return nil
}

// fileRenameInformation mirrors FILE_RENAME_INFORMATION (x64 layout: the
// BOOLEAN at 0, padding, RootDirectory at 8, FileNameLength at 16, FileName
// at 20).
type fileRenameInformation struct {
	ReplaceIfExists uint32
	RootDirectory   windows.Handle
	FileNameLength  uint32
	FileName        [1]uint16
}

const fileRenameInformationClass = 10

// renameWithBackupIntent renames from to to (an absolute path, never
// replacing an existing entry) through a handle opened for DELETE with
// FILE_FLAG_BACKUP_SEMANTICS while SeRestorePrivilege and SeBackupPrivilege
// are enabled, without following a link at from.
func renameWithBackupIntent(from, to string) error {
	release, err := enableTokenPrivileges("SeRestorePrivilege", "SeBackupPrivilege")
	if err != nil {
		return err
	}
	defer release()
	p16, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return err
	}
	h, err := windows.CreateFile(p16, windows.DELETE|windows.SYNCHRONIZE,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil,
		windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return fmt.Errorf("open %s: %w", from, err)
	}
	defer func() { _ = windows.CloseHandle(h) }()
	abs, err := filepath.Abs(to)
	if err != nil {
		return err
	}
	name, err := windows.UTF16FromString(`\??\` + abs)
	if err != nil {
		return err
	}
	nameLen := len(name)*2 - 2
	var layout fileRenameInformation
	size := int(unsafe.Offsetof(layout.FileName)) + nameLen
	if minimum := int(unsafe.Sizeof(layout)); size < minimum {
		size = minimum
	}
	buf := make([]byte, size)
	info := (*fileRenameInformation)(unsafe.Pointer(&buf[0]))
	info.FileNameLength = uint32(nameLen)
	copy(unsafe.Slice(&info.FileName[0], nameLen/2), name[:nameLen/2])
	var iosb windows.IO_STATUS_BLOCK
	if err := windows.NtSetInformationFile(h, &iosb, &buf[0], uint32(len(buf)), fileRenameInformationClass); err != nil {
		return fmt.Errorf("rename %s to %s: %w", from, to, err)
	}
	return nil
}
