package backup

import (
	"encoding/base64"
	"fmt"
	"runtime"

	"github.com/breeze-rmm/agent/internal/securefs"
)

// restoreAppliesSecurityDescriptors gates NTFS security-descriptor apply on
// restore. Descriptors mean nothing off Windows, so there the manifest's
// table is ignored entirely: never decoded, never applied, no warnings
// (R37). A var only so untagged tests can drive the Windows wiring on any
// host.
var restoreAppliesSecurityDescriptors = runtime.GOOS == "windows"

// restoreSecurityApplier is securityApplier (sd_windows.go/sd_other.go): it
// turns a descriptor into the securefs hook that sets it on a pinned handle.
// A var only so untagged tests can record the applies
// RestoreFromSnapshotContext makes, and when.
var restoreSecurityApplier = securityApplier

// sdPlatform is the machinery the restore's descriptor decision needs from
// the OS (sd_windows.go; inert stubs in sd_other.go): read the principals a
// descriptor names, resolve the domains this machine recognises, and build
// the two alternative appliers — the captured descriptor without its SACL,
// and the restrictive quarantine descriptor.
type sdPlatform struct {
	principals  func(sd []byte) (sdPrincipals, error)
	domains     func() (knownDomains, []string)
	withoutSACL func(sd []byte) (*securefs.SecurityApplier, error)
	quarantine  func() (*securefs.SecurityApplier, error)
}

// restoreSDPlatform is the OS machinery the restore uses. A var only so
// untagged tests can drive the decision on any host.
var restoreSDPlatform = sdPlatform{
	principals:  descriptorPrincipals,
	domains:     localKnownDomains,
	withoutSACL: securityApplierWithoutSACL,
	quarantine:  quarantineApplier,
}

// sdPlan is what the restore does with one entry's captured descriptor: the
// applier to hand securefs, and the verdict that chose it.
type sdPlan struct {
	applier *securefs.SecurityApplier
	verdict sdVerdict
	reason  string
}

// decodeSecurityDescriptors turns Snapshot.SecurityDescriptors (base64,
// 1-based via SnapshotFile.SDIndex — see sdtable.go) into the raw-bytes
// table the restore applies. A single corrupt entry — undecodable, or
// decoding to zero bytes — degrades to "no SD for that slot" with one
// warning, rather than failing the whole restore; the affected file's
// CONTENT restore is entirely unaffected either way.
func decodeSecurityDescriptors(encoded []string) (table [][]byte, warnings []string) {
	if len(encoded) == 0 {
		return nil, nil
	}
	table = make([][]byte, len(encoded))
	for i, s := range encoded {
		b, err := base64.StdEncoding.DecodeString(s)
		if err == nil && len(b) == 0 {
			err = fmt.Errorf("decodes to zero bytes")
		}
		if err != nil {
			warnings = append(warnings, fmt.Sprintf("security descriptor table entry %d is corrupt: %v", i+1, err))
			continue
		}
		table[i] = b
	}
	return table, warnings
}

// sdBytesAt returns table's 1-based SDIndex entry, or nil when index is 0
// ("unknown" — SnapshotFile.SDIndex's zero value) or out of range (a
// manifest from a newer/different agent build than expected — fail open,
// never fail the file restore over it).
func sdBytesAt(table [][]byte, index int) []byte {
	if index <= 0 || index > len(table) {
		return nil
	}
	return table[index-1]
}

// restoreSecurity is one restore run's view of the manifest's security
// descriptor table: which descriptor each restored entry takes, and the
// aggregate count of entries restored without one.
type restoreSecurity struct {
	table    [][]byte
	hasTable bool
	missing  int

	// asCaptured skips the principal check (RestoreConfig.
	// SecurityDescriptorsAsCaptured).
	asCaptured bool

	// The machine's domains, resolved once per run on first use.
	domainsResolved bool
	domains         knownDomains
	domainNotes     []string

	quarantined, saclDropped        int
	firstQuarantined, firstSACLDrop string
}

// newRestoreSecurity decodes the table when enabled (Windows) and checks its
// integrity against the entries about to be restored: any SDIndex past the
// table's end raises ONE truncation warning, and those entries are then
// restored without a descriptor (counted only there, never in finish's
// aggregate). Disabled, it returns an inert value and no warnings.
func newRestoreSecurity(encoded []string, entries []SnapshotFile, enabled bool) (*restoreSecurity, []string) {
	if !enabled {
		return &restoreSecurity{}, nil
	}
	table, warnings := decodeSecurityDescriptors(encoded)
	rs := &restoreSecurity{table: table, hasTable: len(encoded) > 0}
	truncated, maxIndex := 0, 0
	for _, e := range entries {
		if e.Kind == KindSymlink || e.SDIndex <= len(table) {
			continue
		}
		truncated++
		if e.SDIndex > maxIndex {
			maxIndex = e.SDIndex
		}
	}
	if truncated > 0 {
		warnings = append(warnings, fmt.Sprintf(
			"security descriptor table is truncated: %d entries reference slots up to %d but the table has %d; they were restored with a restrictive access list",
			truncated, maxIndex, len(table)))
	}
	return rs, warnings
}

// active reports whether this restore applies descriptors at all (and so
// needs the restore privilege scope).
func (rs *restoreSecurity) active() bool { return rs.hasTable }

// forEntry returns the descriptor to apply to a just-restored entry, or nil.
// Symlinks/junctions never take one (applying a DACL through the link
// would land on its target). A file or directory with SDIndex 0 in a
// manifest that HAS a table is counted for finish's aggregate warning. An
// out-of-range index (already reported as truncation) and a corrupt slot
// (decodeSecurityDescriptors already warned) return nil without counting, so
// no entry is reported twice.
func (rs *restoreSecurity) forEntry(e SnapshotFile) []byte {
	if !rs.hasTable || e.Kind == KindSymlink {
		return nil
	}
	if e.SDIndex <= 0 {
		rs.missing++
		return nil
	}
	// Past the table's end: already counted once, in newRestoreSecurity's
	// truncation warning — not counted again here. sdBytesAt returns nil.
	return sdBytesAt(rs.table, e.SDIndex)
}

// entryPlan is how an entry's recorded descriptor is applied. Symlinks and
// entries without a recorded descriptor get none (the latter counted for
// finish's aggregate warning). A recorded descriptor that cannot be used — a
// table slot that did not decode, an index past the table's end, or bytes
// that do not validate — is restricted exactly like one naming principals
// this machine does not recognise, never left with the target's inherited
// ACL. That holds for a whole-machine rebuild too: it opts out of the
// principal check, not of a readable descriptor.
func (rs *restoreSecurity) entryPlan(e SnapshotFile) sdPlan {
	if !rs.hasTable || e.Kind == KindSymlink {
		return sdPlan{}
	}
	if e.SDIndex <= 0 {
		rs.missing++
		return sdPlan{}
	}
	sd := sdBytesAt(rs.table, e.SDIndex)
	if sd == nil {
		return sdPlan{applier: quarantineRequired(), verdict: sdQuarantine, reason: "its recorded security descriptor could not be read from the snapshot"}
	}
	p, err := rs.plan(sd)
	if err != nil {
		return sdPlan{applier: quarantineRequired(), verdict: sdQuarantine, reason: fmt.Sprintf("its recorded security descriptor is not valid (%v)", err)}
	}
	return p
}

// plan decides how sd is applied to an entry. The captured descriptor is
// validated first (restoreSecurityApplier); an invalid one returns its error,
// and entryPlan restricts the entry instead. A valid one is applied as
// captured only when every principal it names is recognised here
// (judgeDescriptor); otherwise the
// entry gets the restrictive quarantine descriptor, or — when only the SACL
// names an unrecognised principal — the descriptor without its SACL.
// Principals that cannot be read are treated as unrecognised.
func (rs *restoreSecurity) plan(sd []byte) (sdPlan, error) {
	applier, err := restoreSecurityApplier(sd)
	if err != nil || applier == nil || rs.asCaptured {
		return sdPlan{applier: applier}, err
	}
	verdict, reason := sdQuarantine, ""
	if p, perr := restoreSDPlatform.principals(sd); perr != nil {
		reason = fmt.Sprintf("its principals could not be read (%v)", perr)
	} else {
		verdict, reason = judgeDescriptor(p, rs.knownDomains())
	}
	switch verdict {
	case sdApply:
		return sdPlan{applier: applier, verdict: sdApply}, nil
	case sdApplyWithoutSACL:
		reduced, rerr := restoreSDPlatform.withoutSACL(sd)
		if rerr == nil && reduced != nil {
			return sdPlan{applier: reduced, verdict: sdApplyWithoutSACL, reason: reason}, nil
		}
		// Cannot build the SACL-less form: restrict rather than apply the
		// SACL or fall back to the inherited ACL.
		reason = fmt.Sprintf("%s, and the descriptor could not be applied without it (%v)", reason, rerr)
	}
	return sdPlan{applier: quarantineRequired(), verdict: sdQuarantine, reason: reason}, nil
}

// quarantineRequired is the quarantine applier, marked Required so a failure
// to restrict the entry fails it instead of publishing it with the parent's
// inherited ACL.
func quarantineRequired() *securefs.SecurityApplier {
	q, err := restoreSDPlatform.quarantine()
	if err != nil || q == nil {
		if err == nil {
			err = fmt.Errorf("no restrictive descriptor on this platform")
		}
		return &securefs.SecurityApplier{Required: true, Apply: func(uintptr) error {
			return fmt.Errorf("build restrictive descriptor: %w", err)
		}}
	}
	required := *q
	required.Required = true
	return &required
}

// knownDomains resolves the machine's domains once per restore run.
func (rs *restoreSecurity) knownDomains() knownDomains {
	if !rs.domainsResolved {
		rs.domainsResolved = true
		rs.domains, rs.domainNotes = restoreSDPlatform.domains()
	}
	return rs.domains
}

// record notes an entry whose plan was applied successfully: a quarantined
// entry is counted and listed in the result, a dropped SACL is counted for
// the run's aggregate warning.
func (rs *restoreSecurity) record(result *RestoreResult, display string, p sdPlan) {
	switch p.verdict {
	case sdQuarantine:
		result.SecurityDescriptorQuarantined++
		result.SecurityDescriptorQuarantinedPaths = append(result.SecurityDescriptorQuarantinedPaths, display)
		rs.quarantined++
		if rs.firstQuarantined == "" {
			rs.firstQuarantined = display + ": " + p.reason
		}
	case sdApplyWithoutSACL:
		rs.saclDropped++
		if rs.firstSACLDrop == "" {
			rs.firstSACLDrop = display + ": " + p.reason
		}
	}
}

// finish returns the run's aggregate warnings (one per outcome per restore,
// never one per file): entries restored without a recorded descriptor,
// entries quarantined, entries restored without their SACL, and any note
// from resolving the machine's domains.
func (rs *restoreSecurity) finish() []string {
	var out []string
	if rs.missing > 0 {
		out = append(out, fmt.Sprintf("%d entries had no security descriptor recorded; they were restored with ACLs inherited from the restore target", rs.missing))
	}
	if rs.quarantined > 0 {
		out = append(out, fmt.Sprintf("%d entries were restored with a restrictive access list (owner Administrators; SYSTEM and Administrators only) instead of their recorded security descriptor, which names principals this machine does not recognise or cannot be read (first: %s)", rs.quarantined, rs.firstQuarantined))
	}
	if rs.saclDropped > 0 {
		out = append(out, fmt.Sprintf("%d entries were restored without their recorded audit entries (SACL), which name principals this machine does not recognise (first: %s)", rs.saclDropped, rs.firstSACLDrop))
	}
	return append(out, rs.domainNotes...)
}
