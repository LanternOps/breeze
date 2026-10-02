package backup

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf16"
)

// Skipped reparse points (#7051). Junctions are captured as links since #7325
// (junction.go); what follows is the skip path, which still covers volume
// mount points, other reparse tags, and junctions whose target is not a
// drive path.
//
// Since Go 1.23, os.Lstat on Windows reports a junction or volume mount point
// (IO_REPARSE_TAG_MOUNT_POINT), and any other reparse point Go does not model,
// as os.ModeIrregular: not a directory, not a regular file, not a symlink. The
// collector does not traverse or capture these on purpose. Following a
// junction can back up the same data twice or loop (the legacy
// "Application Data" junctions in every profile point back up the tree), and
// the manifest has no entry type that restores a junction. That skip used to
// be completely silent. It still skips, but every skipped reparse point is now
// recorded and surfaced on the job's Warning and in the agent log, so an
// operator can see what a restore will not bring back. Backing junctions up
// as links, with junction restore, is a separate follow-up.

// reparseKind names what a skipped reparse point was.
type reparseKind string

const (
	reparseKindJunction   reparseKind = "junction"
	reparseKindMountPoint reparseKind = "volume mount point"
	reparseKindOther      reparseKind = "other"
)

// ioReparseTagMountPoint is IO_REPARSE_TAG_MOUNT_POINT, the tag shared by
// junctions and volume mount points. It is spelled out here instead of taken
// from golang.org/x/sys/windows so the buffer parser can build and be tested
// on every platform.
const ioReparseTagMountPoint uint32 = 0xA0000003

// maxSkippedReparseSample caps how many skipped reparse points are kept in
// full (path, kind, target) and logged individually. The rest still count
// toward reparseSkips.total and byKind, so a profile tree with thousands of
// reparse points cannot grow the collector's memory, the log, or the Warning.
const maxSkippedReparseSample = 20

// skippedReparsePoint is one reparse point the collector did not back up.
type skippedReparsePoint struct {
	path string
	kind reparseKind
	// target is where a junction or mount point points: a drive path for a
	// junction, `\\?\Volume{GUID}\` for a volume mount point. Empty when
	// unknown or for other tags.
	target string
	// tag is the raw IO_REPARSE_TAG_* value. Zero when it could not be read.
	tag uint32
	// detail explains why the tag or target is missing, e.g. the reparse
	// data could not be read.
	detail string
}

// String renders a skipped reparse point for the Warning and the log:
// `C:\Users\a\My Music (junction -> C:\Users\a\Music)`.
func (s skippedReparsePoint) String() string {
	var desc string
	switch s.kind {
	case reparseKindJunction, reparseKindMountPoint:
		desc = string(s.kind)
		if s.target != "" {
			desc += " -> " + s.target
		}
	default:
		desc = "other reparse point"
		if s.tag != 0 {
			desc += fmt.Sprintf(", tag 0x%08X", s.tag)
		}
	}
	if s.detail != "" {
		desc += ", " + s.detail
	}
	return s.path + " (" + desc + ")"
}

// reparseSkips accumulates what one collection walk did with the reparse
// points it met. Junctions with a drive-path target are captured as links in
// junctions (#7325) — every one, uncapped, since each is a manifest entry.
// Everything else is skipped: an exact total and per-kind count, plus the
// first maxSkippedReparseSample entries in walk order.
type reparseSkips struct {
	total     int
	byKind    map[reparseKind]int
	sample    []skippedReparsePoint
	junctions []SnapshotJunction
}

func newReparseSkips() *reparseSkips {
	return &reparseSkips{byKind: map[reparseKind]int{}}
}

func (r *reparseSkips) add(sp skippedReparsePoint) {
	r.total++
	r.byKind[sp.kind]++
	if len(r.sample) < maxSkippedReparseSample {
		r.sample = append(r.sample, sp)
	}
}

// skippedReparsePointFor classifies an entry the collector is about to skip
// because it is neither a directory, a regular file, nor a symlink. ok is
// false when the entry is not a reparse point (a Unix FIFO, socket or device
// node), which stays a silent skip. A package var so tests can drive the
// recording path on hosts that have no junctions.
var skippedReparsePointFor = platformSkippedReparsePoint

// parseReparseBuffer decodes the REPARSE_DATA_BUFFER that
// FSCTL_GET_REPARSE_POINT returns. For IO_REPARSE_TAG_MOUNT_POINT it tells a
// junction from a volume mount point by the substitute name: a volume mount
// point targets `\??\Volume{GUID}\`, a junction a drive or UNC path. Every
// other tag is reparseKindOther with no target.
func parseReparseBuffer(buf []byte) (tag uint32, kind reparseKind, target string, err error) {
	const headerLen = 8 // ReparseTag uint32, ReparseDataLength uint16, Reserved uint16
	if len(buf) < headerLen {
		return 0, "", "", fmt.Errorf("reparse buffer too short: %d bytes", len(buf))
	}
	tag = binary.LittleEndian.Uint32(buf[0:4])
	if tag != ioReparseTagMountPoint {
		return tag, reparseKindOther, "", nil
	}

	const mountHeaderLen = headerLen + 8 // four uint16 offset/length fields
	if len(buf) < mountHeaderLen {
		return tag, "", "", errors.New("mount point reparse buffer truncated before its name fields")
	}
	pathBuf := buf[mountHeaderLen:]
	name := func(offset, length uint16) (string, error) {
		end := int(offset) + int(length)
		if length%2 != 0 || end > len(pathBuf) {
			return "", fmt.Errorf("reparse name [%d:%d] outside %d-byte path buffer", offset, end, len(pathBuf))
		}
		u := make([]uint16, length/2)
		for i := range u {
			u[i] = binary.LittleEndian.Uint16(pathBuf[int(offset)+2*i:])
		}
		return string(utf16.Decode(u)), nil
	}
	substitute, err := name(binary.LittleEndian.Uint16(buf[8:]), binary.LittleEndian.Uint16(buf[10:]))
	if err != nil {
		return tag, "", "", err
	}
	print, err := name(binary.LittleEndian.Uint16(buf[12:]), binary.LittleEndian.Uint16(buf[14:]))
	if err != nil {
		return tag, "", "", err
	}

	// NT object-manager paths start with `\??\`; the Win32 spelling of a
	// volume GUID path is `\\?\Volume{...}\`, of a drive path just `C:\...`.
	rest, nt := strings.CutPrefix(substitute, `\??\`)
	if nt && strings.HasPrefix(strings.ToLower(rest), "volume{") {
		return tag, reparseKindMountPoint, `\\?\` + rest, nil
	}
	// The substitute name is what the filesystem resolves; the print name
	// is display text and may differ. The target is captured and restored
	// (#7325), so it must be the substitute. The print name is used only
	// when the substitute is not an NT path, which mklink never writes.
	if !nt && print != "" {
		return tag, reparseKindJunction, print, nil
	}
	return tag, reparseKindJunction, rest, nil
}

// summarizeSkippedReparsePoints renders a run's skipped reparse points as a
// Warning fragment:
// "N reparse point(s) were not backed up (a junction, mount point or other
// reparse point is skipped, not followed; K junction, …): <first few> (+M more)".
// Detail count is capped like summarizeScanErrors because the Warning lands
// in a DB text column and the UI.
func summarizeSkippedReparsePoints(r *reparseSkips) string {
	if r == nil || r.total == 0 {
		return ""
	}
	var counts []string
	for _, k := range []reparseKind{reparseKindJunction, reparseKindMountPoint, reparseKindOther} {
		if n := r.byKind[k]; n > 0 {
			counts = append(counts, fmt.Sprintf("%d %s", n, k))
		}
	}
	details := make([]string, 0, maxUploadFailureDetails)
	for i, sp := range r.sample {
		if i >= maxUploadFailureDetails {
			break
		}
		details = append(details, sp.String())
	}
	summary := fmt.Sprintf("%d reparse point(s) were not backed up (junctions and mount points are skipped, not followed; %s): %s",
		r.total, strings.Join(counts, ", "), strings.Join(details, "; "))
	if shown := len(details); r.total > shown {
		summary += fmt.Sprintf(" (+%d more)", r.total-shown)
	}
	return summary
}

// reportSkippedReparsePoints puts a run's skipped reparse points on the job's
// Warning and in the agent log at warn level: one line per sampled entry and
// one summary line with the total. Warning only, like volatile files: the
// skip is deliberate, so it adds nothing to ErrorCount and cannot downgrade
// the run to partial.
func reportSkippedReparsePoints(job *BackupJob, r *reparseSkips) {
	if r == nil || r.total == 0 {
		return
	}
	for _, sp := range r.sample {
		log.Warn("reparse point skipped, not backed up",
			"jobId", job.ID, "path", sp.path, "kind", string(sp.kind), "target", sp.target,
			"tag", fmt.Sprintf("0x%08X", sp.tag), "detail", sp.detail)
	}
	warning := summarizeSkippedReparsePoints(r)
	appendWarning(job, warning)
	log.Warn("backup scan skipped reparse points", "jobId", job.ID, "total", r.total,
		"logged", len(r.sample), "warning", warning)
}

// livePathForVSS maps a path under a VSS shadow copy back to the live volume
// path it mirrors, so an operator reads `C:\Users\…` rather than
// `\\?\GLOBALROOT\Device\HarddiskVolumeShadowCopyN\Users\…`. shadowPaths is
// VSS session's volume -> shadow map; a path outside every shadow is returned
// unchanged. Same matching rule as originalPathsForVSS.
func livePathForVSS(p string, shadowPaths map[string]string) string {
	for vol, shadow := range shadowPaths {
		if shadow == "" {
			continue
		}
		if p == shadow {
			return vol
		}
		if strings.HasPrefix(p, shadow+string(filepath.Separator)) {
			return vol + p[len(shadow):]
		}
	}
	return p
}
