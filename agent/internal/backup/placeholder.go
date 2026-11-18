package backup

import (
	"fmt"
	"os"
	"strings"
)

// WOF-compressed files and cloud placeholders (#7326).
//
// Go 1.23+ reports every Windows reparse point whose tag is not SYMLINK,
// AF_UNIX or DEDUP as os.ModeIrregular. Two such tags mark ordinary data
// files, not links:
//
//   - IO_REPARSE_TAG_WOF: files compressed by CompactOS or `compact /exe`.
//     wof.sys decompresses them on read, so a plain read returns the file's
//     real bytes.
//   - IO_REPARSE_TAG_CLOUD_*: cloud files (OneDrive Files On-Demand and other
//     Cloud Files API providers). A placeholder whose data is on disk reads
//     locally. One whose data is not on disk is downloaded by cldflt.sys when
//     it is read.
//
// The policy:
//
//   - Any file or directory whose attributes say its data is not on this
//     machine (OFFLINE, RECALL_ON_DATA_ACCESS, RECALL_ON_OPEN) is skipped and
//     reported, and is never opened: reading it would download it, and a
//     whole-machine backup must not hydrate a user's entire OneDrive. A
//     directory with RECALL_ON_DATA_ACCESS is the one exception: it is
//     partially local and can hold local files, so it is still walked and only
//     its non-local children are skipped.
//   - A WOF or cloud file that is local is backed up as a regular file, but
//     only after it is shown to open through its filter. A file whose filter
//     is not attached to that volume (a VSS shadow copy, for example) fails to
//     open; it stays a skipped reparse point and the Warning says why.
//   - Restore writes these files back as plain, uncompressed files: readable,
//     but no longer WOF-compressed or cloud-managed.
//
// The walk also asks Windows to expose placeholders on its thread
// (exposePlaceholdersForWalk), since a process in "disguise" mode sees cloud
// placeholders as plain files with these attributes hidden.

// Windows file attributes and reparse tags the policy keys on, spelled out so
// it builds and is tested on every platform.
const (
	winAttrDirectory          uint32 = 0x00000010
	winAttrSparseFile         uint32 = 0x00000200
	winAttrReparsePoint       uint32 = 0x00000400
	winAttrOffline            uint32 = 0x00001000
	winAttrRecallOnOpen       uint32 = 0x00040000
	winAttrPinned             uint32 = 0x00080000
	winAttrRecallOnDataAccess uint32 = 0x00400000

	// ioReparseTagWOF is IO_REPARSE_TAG_WOF.
	ioReparseTagWOF uint32 = 0x80000017
	// ioReparseTagCloud is IO_REPARSE_TAG_CLOUD. IO_REPARSE_TAG_CLOUD_1..F
	// differ from it only in the bits of ioReparseTagCloudMask.
	ioReparseTagCloud     uint32 = 0x9000001A
	ioReparseTagCloudMask uint32 = 0x0000F000
)

// reparseKindNotLocal marks a file or directory skipped because its data is
// not on this machine. It is recorded apart from the reparse-point skips.
const reparseKindNotLocal reparseKind = "not stored locally"

// isDataReparseTag reports whether tag marks a data file that reads like a
// regular file once its filter has opened it: WOF or any cloud tag.
func isDataReparseTag(tag uint32) bool {
	return tag == ioReparseTagWOF || tag&^ioReparseTagCloudMask == ioReparseTagCloud
}

// notStoredLocallyReason returns why attrs mark a file whose data is not on
// this machine, or "" when its data is local.
func notStoredLocallyReason(attrs uint32) string {
	var why []string
	if attrs&winAttrOffline != 0 {
		why = append(why, "offline")
	}
	if attrs&winAttrRecallOnOpen != 0 {
		why = append(why, "recall on open")
	}
	if attrs&winAttrRecallOnDataAccess != 0 {
		why = append(why, "recall on data access")
	}
	if len(why) == 0 {
		return ""
	}
	return "cloud placeholder: " + strings.Join(why, ", ")
}

// rawWinAttrsFor returns an entry's raw Windows file attributes as the
// directory listing or stat reported them; 0 off Windows. A package var so
// tests can drive the policy on any host.
var rawWinAttrsFor = platformRawWinAttrs

// openDataReparseFile proves a WOF or cloud file opens through its filter the
// way the upload will open it (os.Open), without reading it. A package var so
// tests can stand in for wof.sys and cldflt.sys.
var openDataReparseFile = func(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	return f.Close()
}

// notStoredLocally reports whether the entry at path must be skipped because
// its data is not on this machine. A directory with only
// RECALL_ON_DATA_ACCESS is partially local and is not skipped.
func notStoredLocally(path string, info os.FileInfo) (skippedReparsePoint, bool) {
	attrs := rawWinAttrsFor(info)
	if info.IsDir() {
		attrs &^= winAttrRecallOnDataAccess
	}
	reason := notStoredLocallyReason(attrs)
	if reason == "" {
		return skippedReparsePoint{}, false
	}
	return skippedReparsePoint{path: path, kind: reparseKindNotLocal, detail: reason}, true
}

// captureAsDataFile reports whether a reparse point the collector met should
// be backed up as a regular file: a WOF or cloud file that opens through its
// filter. When the file does not open, sp.detail records why and it stays a
// skipped reparse point. Any other tag is never opened.
func captureAsDataFile(sp *skippedReparsePoint) bool {
	if !isDataReparseTag(sp.tag) || sp.detail != "" {
		return false
	}
	if err := openDataReparseFile(sp.path); err != nil {
		sp.detail = "data file did not open through its filter: " + err.Error()
		return false
	}
	return true
}

func (r *reparseSkips) addNotLocal(sp skippedReparsePoint) {
	r.notLocalTotal++
	if len(r.notLocalSample) < maxSkippedReparseSample {
		r.notLocalSample = append(r.notLocalSample, sp)
	}
}

// summarizeNotStoredLocally renders a run's skipped placeholders as a
// Warning fragment, capped like summarizeSkippedReparsePoints.
func summarizeNotStoredLocally(r *reparseSkips) string {
	if r == nil || r.notLocalTotal == 0 {
		return ""
	}
	details := make([]string, 0, maxUploadFailureDetails)
	for i, sp := range r.notLocalSample {
		if i >= maxUploadFailureDetails {
			break
		}
		details = append(details, sp.String())
	}
	summary := fmt.Sprintf("%d file(s) were not backed up because their data is not stored on this machine (cloud placeholders such as OneDrive Files On-Demand are skipped, not downloaded): %s",
		r.notLocalTotal, strings.Join(details, "; "))
	if shown := len(details); r.notLocalTotal > shown {
		summary += fmt.Sprintf(" (+%d more)", r.notLocalTotal-shown)
	}
	return summary
}

// reportNotStoredLocally puts a run's skipped placeholders on the job's
// Warning and in the agent log, like reportSkippedReparsePoints: Warning only,
// no ErrorCount, so a OneDrive folder full of online-only files does not turn
// every run partial.
func reportNotStoredLocally(job *BackupJob, r *reparseSkips) {
	if r == nil || r.notLocalTotal == 0 {
		return
	}
	for _, sp := range r.notLocalSample {
		log.Warn("file not stored locally, not backed up", "jobId", job.ID, "path", sp.path, "detail", sp.detail)
	}
	warning := summarizeNotStoredLocally(r)
	appendWarning(job, warning)
	log.Warn("backup scan skipped files not stored locally", "jobId", job.ID, "total", r.notLocalTotal,
		"logged", len(r.notLocalSample), "warning", warning)
}
