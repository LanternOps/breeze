package config

import "os"

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
)

// EnforceProgramDataTreePermissions checks the ProgramData logs/data dirs for
// ACL drift and self-heals it. Safe to call on every startup: dirs that are
// missing or already hardened are left untouched and produce no log noise.
//
// Call this AFTER the log shipper is initialized — the drift warning is the
// whole point of the check, and a warning emitted before the shipper is up
// never reaches agent_logs (same constraint as the #1201 reconcile reporter).
func EnforceProgramDataTreePermissions() {
	for _, dir := range programDataHardenDirsFn() {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue
		}
		drifted, err := detectProgramDataDriftFn(dir)
		if err != nil {
			log.Warn("Failed to check ProgramData ACL for drift", "dir", dir, "error", err.Error())
			continue
		}
		if !drifted {
			continue
		}
		log.Warn("ProgramData ACL drift detected: BUILTIN\\Users still has access — MSI HardenProgramDataAcl was skipped or blocked; re-applying PROTECTED DACL",
			"dir", dir)
		if err := reapplyProgramDataDACLFn(dir); err != nil {
			log.Warn("Failed to re-apply PROTECTED ProgramData DACL", "dir", dir, "error", err.Error())
		}
	}
}
