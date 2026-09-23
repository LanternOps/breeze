package backup

import (
	"encoding/base64"
	"fmt"
	"runtime"
)

// restoreAppliesSecurityDescriptors gates NTFS security-descriptor apply on
// restore. Descriptors mean nothing off Windows, so there the manifest's
// table is ignored entirely: never decoded, never applied, no warnings
// (R37). A var only so untagged tests can drive the Windows wiring on any
// host.
var restoreAppliesSecurityDescriptors = runtime.GOOS == "windows"

// restoreApplySecurity is applySecurity; a var only so untagged tests can
// record the calls RestoreFromSnapshotContext makes.
var restoreApplySecurity = applySecurity

// decodeSecurityDescriptors turns Snapshot.SecurityDescriptors (base64,
// 1-based via SnapshotFile.SDIndex — see sdtable.go) into the raw-bytes
// table applySecurity consumes. A single corrupt entry degrades to "no SD
// for that slot" with one warning, rather than failing the whole restore —
// the affected file's CONTENT restore is entirely unaffected either way.
func decodeSecurityDescriptors(encoded []string) (table [][]byte, warnings []string) {
	if len(encoded) == 0 {
		return nil, nil
	}
	table = make([][]byte, len(encoded))
	for i, s := range encoded {
		b, err := base64.StdEncoding.DecodeString(s)
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
}

// newRestoreSecurity decodes the table when enabled (Windows) and checks its
// integrity against the entries about to be restored: any SDIndex past the
// table's end raises ONE truncation warning, and those entries are then
// treated as SDIndex 0. Disabled, it returns an inert value and no warnings.
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
			"security descriptor table is truncated: %d entries reference slots up to %d but the table has %d; they were restored with inherited ACLs",
			truncated, maxIndex, len(table)))
	}
	return rs, warnings
}

// active reports whether this restore applies descriptors at all (and so
// needs the restore privilege scope).
func (rs *restoreSecurity) active() bool { return rs.hasTable }

// forEntry returns the descriptor to apply to a just-restored entry, or nil.
// Symlinks/junctions never take one (applying a DACL through the link
// would land on its target). A file or directory with SDIndex 0 — or an
// out-of-range index, already reported as truncation — in a manifest that
// HAS a table is counted for finish's aggregate warning. A corrupt slot
// returns nil without counting: decodeSecurityDescriptors already warned.
func (rs *restoreSecurity) forEntry(e SnapshotFile) []byte {
	if !rs.hasTable || e.Kind == KindSymlink {
		return nil
	}
	if e.SDIndex <= 0 || e.SDIndex > len(rs.table) {
		rs.missing++
		return nil
	}
	return sdBytesAt(rs.table, e.SDIndex)
}

// finish returns the run's aggregate warning (one per restore, never one per
// file) for entries restored without a recorded descriptor.
func (rs *restoreSecurity) finish() []string {
	if rs.missing == 0 {
		return nil
	}
	return []string{fmt.Sprintf("%d entries had no security descriptor recorded; they were restored with inherited ACLs", rs.missing)}
}
