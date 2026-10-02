package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// Trust rules for the machine-wide config folder (ProgramData\Breeze on
// Windows) and the files the agent's SYSTEM processes read from it.
//
// Every process that loads the machine config — the agent service, the
// watchdog, the installer's bootstrap step, `service install`, the backup
// helper — goes through the shared loader, and on Windows the loader reads
// agent.yaml and secrets.yaml only after checking them, through the handle it
// reads from: the folder and the file are not links, the file has one hard
// link, the owner is SYSTEM, Administrators, TrustedInstaller or an account in
// the local Administrators group, and no other account may write either of
// them. A config that fails is refused (the process does not run on it), not
// repaired: repairing is the agent service's job at start (ReclaimConfigDir).

// errConfigOwnerUnverified: whether an owner is an administrator could not be
// decided (the account lookup failed or did not answer in time, e.g. a domain
// account while the domain is unreachable). Callers neither trust nor discard
// anything on it; the decision is retried later.
var errConfigOwnerUnverified = errors.New("could not confirm whether the owner is an administrator; this is checked again on the next start")

// errAccountNotFound is what adminGroupMember returns for a SID that names no
// account on this machine (for example a local account since deleted). Such
// an owner is not an administrator.
var errAccountNotFound = errors.New("no such account")

// adminGroupMemberFn reports whether an account SID is a member of the local
// Administrators group (adminGroupMember on Windows); a seam for tests.
var adminGroupMemberFn = adminGroupMember

// adminLookupTimeout bounds one membership lookup, so a domain controller
// that does not answer cannot hold up a service start (the service control
// manager allows 30 s).
var adminLookupTimeout = 5 * time.Second

type configOwnerVerdict int

const (
	configOwnerTrusted configOwnerVerdict = iota
	configOwnerUntrusted
	configOwnerUnverified
)

func (v configOwnerVerdict) String() string {
	switch v {
	case configOwnerTrusted:
		return "trusted"
	case configOwnerUntrusted:
		return "untrusted"
	}
	return "unverified"
}

// Verdicts are cached for a while (a long-running watchdog re-reads the
// config); a failed lookup only briefly, so it is retried soon.
const (
	configOwnerVerdictTTL       = 10 * time.Minute
	configOwnerUnverifiedTTL    = 30 * time.Second
	configOwnerVerdictCacheSize = 64
)

type cachedOwnerVerdict struct {
	verdict configOwnerVerdict
	until   time.Time
}

var (
	configOwnerVerdictMu    sync.Mutex
	configOwnerVerdictCache = map[string]cachedOwnerVerdict{}
)

func resetConfigOwnerVerdictCache() {
	configOwnerVerdictMu.Lock()
	defer configOwnerVerdictMu.Unlock()
	configOwnerVerdictCache = map[string]cachedOwnerVerdict{}
}

// configOwnerVerdictFor decides whether sid may own the agent's config:
// SYSTEM, Administrators and TrustedInstaller without a lookup; any other
// account only if it is in the local Administrators group (an elevated
// enroll under the "object creator" owner policy leaves the admin's own
// account as owner). An account that does not exist is untrusted; a lookup
// that fails or takes longer than adminLookupTimeout is unverified.
func configOwnerVerdictFor(sid string) configOwnerVerdict {
	if trustedProgramDataPrincipal(sid) {
		return configOwnerTrusted
	}
	if sid == "" {
		return configOwnerUntrusted
	}
	now := time.Now()
	configOwnerVerdictMu.Lock()
	if c, ok := configOwnerVerdictCache[sid]; ok && now.Before(c.until) {
		configOwnerVerdictMu.Unlock()
		return c.verdict
	}
	configOwnerVerdictMu.Unlock()

	type answer struct {
		member bool
		err    error
	}
	lookup := adminGroupMemberFn
	ch := make(chan answer, 1)
	go func() {
		m, err := lookup(sid)
		ch <- answer{m, err}
	}()
	verdict, ttl := configOwnerUnverified, configOwnerUnverifiedTTL
	select {
	case a := <-ch:
		switch {
		case a.err == nil && a.member:
			verdict, ttl = configOwnerTrusted, configOwnerVerdictTTL
		case a.err == nil, errors.Is(a.err, errAccountNotFound):
			verdict, ttl = configOwnerUntrusted, configOwnerVerdictTTL
		default:
			log.Warn("Could not check whether an agent config owner is an administrator", "owner", sid, "error", a.err.Error())
		}
	case <-time.After(adminLookupTimeout):
		log.Warn("Checking whether an agent config owner is an administrator took too long", "owner", sid, "timeout", adminLookupTimeout.String())
	}

	configOwnerVerdictMu.Lock()
	if len(configOwnerVerdictCache) >= configOwnerVerdictCacheSize {
		configOwnerVerdictCache = map[string]cachedOwnerVerdict{}
	}
	configOwnerVerdictCache[sid] = cachedOwnerVerdict{verdict, now.Add(ttl)}
	configOwnerVerdictMu.Unlock()
	return verdict
}

// checkConfigObjectTrust applies the trust rules to one config file or
// folder, whose security was read from the handle the caller holds: not a
// link or other reparse point, an owner configOwnerVerdictFor trusts, and a
// DACL that lets no one but SYSTEM, Administrators, TrustedInstaller and that
// owner write, delete or change permissions. The error wraps
// ErrConfigDirUntrusted, and also errConfigOwnerUnverified when the only
// problem is an owner that could not be checked.
func checkConfigObjectTrust(p string, sec programDataPathSecurity) error {
	if sec.Unreadable {
		return fmt.Errorf("%w: %s cannot be inspected by the agent (its permissions deny SYSTEM and Administrators)", ErrConfigDirUntrusted, p)
	}
	if sec.NameSurrogate {
		return fmt.Errorf("%w: %s is a link to another location", ErrConfigDirUntrusted, p)
	}
	if sec.Reparse {
		return fmt.Errorf("%w: %s is a reparse point", ErrConfigDirUntrusted, p)
	}
	if !sec.DACLPresent {
		return fmt.Errorf("%w: %s has no DACL, which grants everyone full access", ErrConfigDirUntrusted, p)
	}
	for _, ace := range sec.ACEs {
		if ace.Flags&aceFlagInheritOnly != 0 || isDenyACE(ace.Type) {
			continue
		}
		if ace.Type != aceTypeAccessAllowed {
			return fmt.Errorf("%w: %s has an allow entry of unrecognised type 0x%02x", ErrConfigDirUntrusted, p, ace.Type)
		}
		if trustedProgramDataPrincipal(ace.SID) || (ace.SID != "" && ace.SID == sec.OwnerSID) {
			continue
		}
		if ace.Mask&programDataWriteMask != 0 {
			return fmt.Errorf("%w: %s lets %s change it (access 0x%08x)", ErrConfigDirUntrusted, p, ace.SID, ace.Mask&programDataWriteMask)
		}
	}
	switch configOwnerVerdictFor(sec.OwnerSID) {
	case configOwnerUntrusted:
		return fmt.Errorf("%w: %s is owned by %s, which is not SYSTEM, Administrators or an administrator account", ErrConfigDirUntrusted, p, sec.OwnerSID)
	case configOwnerUnverified:
		return fmt.Errorf("%w: %s owner %s: %w", ErrConfigDirUntrusted, p, sec.OwnerSID, errConfigOwnerUnverified)
	}
	return nil
}

// reclaimAgentEntries are the entries the agent itself keeps directly in its
// config folder. Another account owning one of them (or one being a link)
// means that account could write the folder, so the folder is replaced.
// Other entries another account owns are set aside one by one.
var reclaimAgentEntries = map[string]bool{
	"agent.yaml":   true,
	"secrets.yaml": true,
	"agent.state":  true,
	"data":         true,
	"logs":         true,
	"run":          true,
	"sessions":     true,
}

// replaceEvidence decides, from the folder's security and that of each entry
// directly in it (keyed by name), whether the folder must be replaced
// (evidence names why) and which other entries are to be set aside on their
// own (sorted). An owner that cannot be checked on the folder or one of the
// agent's own entries returns an error wrapping errConfigOwnerUnverified: the
// caller changes nothing and decides on the next start. Such an owner on any
// other entry leaves that entry alone.
func replaceEvidence(root programDataPathSecurity, entries map[string]programDataPathSecurity) (string, []string, error) {
	if root.Unreadable {
		return "the folder cannot be inspected by the agent", nil, nil
	}
	switch configOwnerVerdictFor(root.OwnerSID) {
	case configOwnerUntrusted:
		return "folder owner " + root.OwnerSID, nil, nil
	case configOwnerUnverified:
		return "", nil, fmt.Errorf("%w: folder owner %s: %w", ErrConfigDirUntrusted, root.OwnerSID, errConfigOwnerUnverified)
	}
	names := make([]string, 0, len(entries))
	for name := range entries {
		names = append(names, name)
	}
	sort.Strings(names)
	var foreign []string
	for _, name := range names {
		sec := entries[name]
		if !sec.Exists {
			continue
		}
		own := reclaimAgentEntries[strings.ToLower(name)]
		if sec.Unreadable {
			if own {
				return name + " cannot be inspected by the agent", nil, nil
			}
			foreign = append(foreign, name)
			continue
		}
		if sec.NameSurrogate {
			if own {
				return name + " is a link", nil, nil
			}
			foreign = append(foreign, name)
			continue
		}
		switch configOwnerVerdictFor(sec.OwnerSID) {
		case configOwnerUntrusted:
			if own {
				return name + " owner " + sec.OwnerSID, nil, nil
			}
			foreign = append(foreign, name)
		case configOwnerUnverified:
			if own {
				return "", nil, fmt.Errorf("%w: %s owner %s: %w", ErrConfigDirUntrusted, name, sec.OwnerSID, errConfigOwnerUnverified)
			}
		}
	}
	return "", foreign, nil
}

// swapConfigRootAttempts bounds how many folders that appear at the config
// folder's name during a replace are set aside before giving up.
const swapConfigRootAttempts = 5

// swapConfigRootIntoPlace moves root aside and staging into its place. Any
// user may create a folder in ProgramData, so the name can be taken between
// the two moves; a folder that appears there is moved aside too (to
// <aside>-<n>) and the move retried. If staging cannot be put in place, root
// is moved back. keepStaging reports that root could not be moved back, so
// staging (holding the carried config) must not be removed; the error then
// says where both folders are.
func swapConfigRootIntoPlace(root, staging, aside string, rename func(from, to string) error, exists func(string) bool) (keepStaging bool, err error) {
	if err := rename(root, aside); err != nil {
		return false, fmt.Errorf("set %s aside (another process may hold it or a file in it open): %w", root, err)
	}
	var moveErr error
	for attempt := 1; attempt <= swapConfigRootAttempts; attempt++ {
		if moveErr = rename(staging, root); moveErr == nil {
			return false, nil
		}
		if !exists(root) {
			break
		}
		taken := fmt.Sprintf("%s-%d", aside, attempt)
		if err := rename(root, taken); err != nil {
			moveErr = fmt.Errorf("%v; a folder created at %s meanwhile could not be set aside: %w", moveErr, root, err)
			break
		}
		log.Warn("A folder was created at the agent config folder's path while it was being replaced; set it aside", "dir", root, "keptIn", taken)
	}
	if err := rename(aside, root); err != nil {
		return true, fmt.Errorf("move the new folder into place at %s: %v; the previous folder could not be moved back either (%v): it is at %s, and the new folder with the carried config is at %s",
			root, moveErr, err, aside, staging)
	}
	return false, fmt.Errorf("move the new folder into place at %s: %w", root, moveErr)
}

// machineConfigTrustEnforced reports whether the loader checks machine
// config files before reading them: on Windows, where another account can
// have created the folder (ProgramData lets any user create one). On other
// platforms the folder is root's and ReclaimConfigDir takes it back.
var machineConfigTrustEnforced = func() bool { return runtime.GOOS == "windows" }

// readTrustedMachineConfigFileFn opens path without following links, checks
// the folder and the file through their handles (checkConfigObjectTrust, one
// hard link) and returns the file's contents read from that same handle. A
// missing file returns an error matching os.ErrNotExist.
var readTrustedMachineConfigFileFn = readTrustedMachineConfigFile

// machineConfigFileNeedsTrust reports whether path is a file directly in the
// machine-wide config folder that must pass the trust check before it is
// read. Never in a support session, whose files are its own private folder's.
func machineConfigFileNeedsTrust(path string) bool {
	if path == "" || !machineConfigTrustEnforced() || registeredUserWorkspace() != "" {
		return false
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return true // cannot place it: check it
	}
	dir, machine := filepath.Clean(filepath.Dir(abs)), filepath.Clean(MachineConfigDir())
	if runtime.GOOS == "windows" {
		return strings.EqualFold(dir, machine)
	}
	return dir == machine
}

// readConfigFileBytes reads a config file, through the trust check when it is
// a machine config file (machineConfigFileNeedsTrust).
func readConfigFileBytes(path string) ([]byte, error) {
	if machineConfigFileNeedsTrust(path) {
		return readTrustedMachineConfigFileFn(path)
	}
	return os.ReadFile(path)
}
