package config

import (
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
)

// errProgramDataDirCreateUnsupported is returned by createProgramDataDir on
// hosts with no hardened-create primitive; a missing dir is then skipped and
// stays untrusted, exactly as before.
var errProgramDataDirCreateUnsupported = errors.New("hardened ProgramData directory creation is not supported on this platform")

// ProgramData ACL drift self-heal.
//
// The MSI installer's HardenProgramDataAcl custom action runs Return="ignore"
// (#1480) so that an external control (Controlled Folder Access / ASR / EDR /
// GPO) blocking its icacls child can never roll back an otherwise-good install.
// The trade-off: when that icacls is blocked, the C:\ProgramData\Breeze\logs
// and \data dirs silently keep the default ProgramData ACL (BUILTIN\Users:
// read + create files/subdirs) — a confidentiality/tamper exposure with no
// operator-visible signal.
//
// Unlike the config dir (self-healed by enforceConfigDirPermissions) and
// secrets.yaml (fail-closed by enforceSecretFilePermissions), logs/data are not
// otherwise re-hardened at runtime. enforceProgramDataTreePermissions closes
// that gap: at startup it detects the leftover BUILTIN\Users ACE, warns to
// agent_logs (the reliable signal — it does not depend on the same blocked
// child process the MSI relies on), and re-applies the PROTECTED DACL so the
// drift self-heals.
//
// The seams below are package-level vars so the cross-platform orchestration
// can be tested without real Windows ACLs (mirroring the enforceSecretFile-
// Permissions injection pattern). Detection and re-application are no-ops on
// non-Windows hosts.
var (
	programDataHardenDirsFn = func() []string {
		return []string{LogDir(), GetDataDir()}
	}
	detectProgramDataDriftFn = programDataDirACLDrifted
	reapplyProgramDataDACLFn = enforceProgramDataDirPermissions
	// createProgramDataDirFn creates a logs/data dir that does not exist yet
	// with the hardened descriptor already applied at creation time. A fresh
	// non-MSI install (enroll + service install) starts the agent before
	// data\ exists; without this the dir was skipped here, created later in
	// the same run with no trust entry, and every code-loading path that
	// consults ProgramDataDirTrusted refused it until the next restart.
	createProgramDataDirFn = createProgramDataDir

	// configDirHardenFn/detectConfigDirOwnerDriftFn/reapplyConfigDirOwnerFn
	// self-heal the ProgramData ROOT (C:\ProgramData\Breeze), which
	// programDataHardenDirsFn above deliberately does not cover: the root
	// intentionally grants BUILTIN\Users read (for the Breeze Helper), so it
	// cannot use the strict logs/data drift check without stripping that
	// access. Only the owner is checked/repaired here — the DACL itself
	// (Users included) is left alone. See EnforceProgramDataTreePermissions.
	configDirHardenFn           = func() []string { return []string{ConfigDir()} }
	detectConfigDirOwnerDriftFn = configDirOwnerDrifted
	reapplyConfigDirOwnerFn     = enforceConfigDirPermissions

	// programDataPathIsLinkFn reports whether a managed path is itself a
	// reparse point (junction, symbolic link, ...), judged on the path and
	// not on whatever it points at. A standard user can create
	// C:\ProgramData\Breeze\data (or logs) as a link to a folder they own
	// before the agent is installed; owner/DACL repair through such a path
	// changes only the link object, while everything the agent writes or
	// loads there lands in the user's folder.
	programDataPathIsLinkFn = programDataPathIsLink
	// removeProgramDataLinkFn deletes the link object at a path, never its
	// target and never recursively.
	removeProgramDataLinkFn = removeProgramDataLink
	// resetProgramDataTreeFn sweeps the content of a logs/data directory
	// once the directory itself is trusted. Links found inside are removed
	// (never their targets) and entries that are not
	// SYSTEM/Administrators-controlled get a trusted owner and
	// inherited-only permissions, together with everything below them.
	// With full set (after a drift repair, when anything inside may have
	// been created while the directory was open to other principals) every
	// entry is visited; otherwise only the direct entries and the subtrees
	// of those that fail, which covers content planted in a directory
	// someone pre-created before it was hardened. It returns the links it
	// could not remove.
	resetProgramDataTreeFn = resetProgramDataTreeContents
)

// ProgramDataTreeResult describes what one EnforceProgramDataTreePermissions
// pass changed.
type ProgramDataTreeResult struct {
	// Replaced lists managed directories that were links and have been
	// replaced by real, hardened directories in this pass.
	Replaced []string
}

// LinkReplaced reports whether dir was a link that this pass replaced. A
// file this process opened under dir before the pass was reached through
// the link and should be reopened.
func (r ProgramDataTreeResult) LinkReplaced(dir string) bool {
	for _, d := range r.Replaced {
		if strings.EqualFold(d, dir) {
			return true
		}
	}
	return false
}

// programDataTrust records, per directory, whether the most recent
// EnforceProgramDataTreePermissions pass left it in a state code-loading
// paths may trust: either it was already clean, or drift was detected and
// the repair succeeded. A directory that was never checked (not yet run, or
// skipped in support mode), whose check errored, or whose repair failed is
// left absent/false — fail closed, not "assume trusted".
var (
	programDataTrustMu    sync.RWMutex
	programDataTrustedDir = map[string]bool{}
)

func setProgramDataDirTrusted(dir string, trusted bool) {
	programDataTrustMu.Lock()
	defer programDataTrustMu.Unlock()
	programDataTrustedDir[dir] = trusted
}

// ProgramDataDirTrusted reports whether dir's owner/DACL were verified clean
// or successfully repaired by the most recent EnforceProgramDataTreePermissions
// pass. Code-loading paths that read from a ProgramData directory (e.g. the
// OpenH264 codec cache in GetDataDir()) must treat "not yet checked" the same
// as "checked and failed" — both report false here — and refuse to load
// rather than trust an unverified directory.
func ProgramDataDirTrusted(dir string) bool {
	programDataTrustMu.RLock()
	defer programDataTrustMu.RUnlock()
	return programDataTrustedDir[dir]
}

// EnforceProgramDataTreePermissions checks the ProgramData logs/data dirs and
// the ProgramData root for ACL/ownership drift and self-heals it, recording
// each directory's resulting trust state for ProgramDataDirTrusted. Safe to
// call on every startup: dirs that are missing or already hardened are left
// untouched and produce no log noise.
//
// A logs/data directory that is a link is replaced: the link itself is
// removed (its target is left untouched) and a real hardened directory is
// created in its place. The root is never removed — it holds the agent
// configuration, and the main-agent lock already refuses to run from a
// linked root. The returned error lists every managed path that is still a
// link (or whose link state could not be read) after the pass; the caller
// must not start anything that writes under it.
//
// Call this AFTER the log shipper is initialized — the drift warning is the
// whole point of the check, and a warning emitted before the shipper is up
// never reaches agent_logs (same constraint as the #1201 reconcile reporter).
func EnforceProgramDataTreePermissions() (ProgramDataTreeResult, error) {
	var pass driftPass
	// The root goes first: logs/data may be created inside it during this
	// pass, and a child must not be created under a root whose owner is
	// still untrusted.
	pass.run(configDirHardenFn(), detectConfigDirOwnerDriftFn, reapplyConfigDirOwnerFn, nil, false,
		"ProgramData root ownership drift detected: the directory is not owned by SYSTEM or Administrators — re-applying the trusted owner")
	pass.run(programDataHardenDirsFn(), detectProgramDataDriftFn, reapplyProgramDataDACLFn, createProgramDataDirFn, true,
		"ProgramData ACL drift detected: an untrusted owner or an ACE beyond SYSTEM/Administrators was found — MSI HardenProgramDataAcl was skipped or blocked; re-applying the PROTECTED DACL")
	if len(pass.unresolved) == 0 {
		return pass.result, nil
	}
	sort.Strings(pass.unresolved)
	return pass.result, fmt.Errorf("agent ProgramData paths are links that could not be replaced with real directories: %s", strings.Join(pass.unresolved, ", "))
}

type driftPass struct {
	result     ProgramDataTreeResult
	unresolved []string
}

// run checks, repairs and records trust for each dir. When create is
// non-nil, a dir that does not exist yet is created with its hardened
// descriptor and then goes through the same check as any other: trust
// always comes from the check, never from having created the dir. When
// replaceLinks is set, a dir that is a link is removed first and recreated.
func (dp *driftPass) run(dirs []string, detect func(string) (bool, error), reapply func(string) error, create func(string) error, replaceLinks bool, warnMsg string) {
	for _, dir := range dirs {
		if !dp.settleLink(dir, replaceLinks) {
			setProgramDataDirTrusted(dir, false)
			continue
		}
		info, err := os.Stat(dir)
		if err != nil && os.IsNotExist(err) && create != nil {
			if cerr := create(dir); cerr != nil && !errors.Is(cerr, os.ErrExist) {
				if !errors.Is(cerr, errProgramDataDirCreateUnsupported) {
					log.Warn("Failed to create ProgramData directory with a hardened ACL", "dir", dir, "error", cerr.Error())
				}
				setProgramDataDirTrusted(dir, false)
				continue
			}
			// Created here, or created concurrently by someone else
			// (ErrExist): either way, re-stat and verify below.
			info, err = os.Stat(dir)
		}
		if err != nil || !info.IsDir() {
			// Not yet created (and not creatable here), or not a directory:
			// nothing to trust. An absent entry already reads as untrusted
			// via ProgramDataDirTrusted's zero value.
			continue
		}
		// Whatever exists now must not have become a link since the first
		// check (e.g. a concurrent creator won the race above).
		if isLink, lerr := programDataPathIsLinkFn(dir); lerr != nil || isLink {
			dp.fail(dir, lerr, "ProgramData directory turned into a link during the permission check — refusing to trust it")
			setProgramDataDirTrusted(dir, false)
			continue
		}
		drifted, err := detect(dir)
		if err != nil {
			log.Warn("Failed to check ProgramData ACL for drift", "dir", dir, "error", err.Error())
			setProgramDataDirTrusted(dir, false)
			continue
		}
		if drifted {
			log.Warn(warnMsg, "dir", dir)
			if err := reapply(dir); err != nil {
				log.Warn("Failed to re-apply ProgramData ACL/owner repair", "dir", dir, "error", err.Error())
				setProgramDataDirTrusted(dir, false)
				continue
			}
		}
		if replaceLinks {
			nestedLinks, rerr := resetProgramDataTreeFn(dir, drifted)
			if len(nestedLinks) > 0 {
				for _, l := range nestedLinks {
					dp.fail(l, nil, "A link inside an agent ProgramData directory could not be removed — refusing to trust the directory")
				}
				setProgramDataDirTrusted(dir, false)
				continue
			}
			if rerr != nil {
				log.Warn("Failed to reset the owner/permissions of content inside a repaired ProgramData directory", "dir", dir, "error", rerr.Error())
				setProgramDataDirTrusted(dir, false)
				continue
			}
		}
		setProgramDataDirTrusted(dir, true)
	}
}

// settleLink handles a managed path that is a link. It returns true when the
// path is not a link (or no longer is), false when it must stay untrusted.
func (dp *driftPass) settleLink(dir string, replace bool) bool {
	isLink, err := programDataPathIsLinkFn(dir)
	if err != nil {
		dp.fail(dir, err, "Failed to check whether an agent ProgramData directory is a link — refusing to trust it")
		return false
	}
	if !isLink {
		return true
	}
	if !replace {
		dp.fail(dir, nil, "The agent ProgramData root is a link to another location — refusing to trust it")
		return false
	}
	log.Warn("An agent ProgramData directory is a link to another location — removing the link (its target is left untouched) and creating a real directory in its place", "dir", dir)
	if err := removeProgramDataLinkFn(dir); err != nil {
		dp.fail(dir, err, "Failed to remove a link at an agent ProgramData directory — refusing to trust it")
		return false
	}
	dp.result.Replaced = append(dp.result.Replaced, dir)
	return true
}

func (dp *driftPass) fail(path string, err error, msg string) {
	if err != nil {
		log.Warn(msg, "path", path, "error", err.Error())
	} else {
		log.Warn(msg, "path", path)
	}
	dp.unresolved = append(dp.unresolved, path)
}
